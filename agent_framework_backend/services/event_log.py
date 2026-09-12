"""Log de eventos append-only sobre Azure Blob Storage, um arquivo por dia.

Formato JSON Lines, um evento por linha, em ``events/AAAA/MM/DD.jsonl``.

Por que blob e nao tabela
~~~~~~~~~~~~~~~~~~~~~~~~~
O guia de design do Table Storage classifica log particionado por data como
anti-pattern ("Log data anti-pattern") e recomenda o Blob para esse caso -- e o
proprio Azure Storage Analytics guarda logs assim, em blobs nomeados por data.
Seguimos a recomendacao.

As tres propriedades que sustentam o desenho
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
* ``append_block`` e **atomico**. Varias replicas escrevem no mesmo blob sem
  lock, sem coordenacao e sem risco de linha partida pela metade.
* O nome carrega a data, entao uma janela de tempo e um filtro sobre nomes --
  nunca uma varredura de conteudo.
* Nada e apagado. O historico completo fica nos arquivos brutos.

Limite conhecido: um append blob aceita 50.000 blocos. Como gravamos um bloco
por evento, o teto e de 50.000 eventos **em um mesmo dia**; ao ultrapassar,
``append`` falha e o chamador (fail-soft) apenas registra o aviso.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, datetime

from azure.core.exceptions import ResourceExistsError, ResourceNotFoundError

logger = logging.getLogger(__name__)

_PREFIX = "events"
_SUFFIX = ".jsonl"

# Quantos arquivos diarios lemos em paralelo. Uma janela de um ano sao 365
# blobs; abrir todos de uma vez esgotaria o pool de conexoes do SDK.
_MAX_CONCURRENT_READS = 16


def _blob_name(day: date) -> str:
    return f"{_PREFIX}/{day:%Y/%m/%d}{_SUFFIX}"


def _day_from_name(name: str) -> date | None:
    """Extrai a data de ``events/AAAA/MM/DD.jsonl``; None se o nome nao casar."""

    if not name.startswith(f"{_PREFIX}/") or not name.endswith(_SUFFIX):
        return None
    try:
        year, month, day = name[len(_PREFIX) + 1 : -len(_SUFFIX)].split("/")
        return date(int(year), int(month), int(day))
    except ValueError:
        return None


@dataclass(frozen=True, slots=True)
class LogRead:
    """Resultado de uma leitura, com o que falhou declarado em vez de sumido.

    ``total_days`` e ``first_day`` descrevem o log inteiro, nao a janela. Sao
    o que permite distinguir "nunca houve atividade" de "nao houve atividade
    nesta janela" -- e saem de graca, porque o LIST ja enxerga todos os dias.
    """

    events: list[dict]
    unreadable_lines: int
    days_in_window: int
    total_days: int
    first_day: date | None


class DailyEventLog:
    """Log append-only particionado por dia.

    ``connection_string`` existe para um unico caso: desenvolvimento local
    contra o emulador (Azurite), que so fala chave compartilhada. Ele nao abre
    um segundo caminho em producao -- as contas provisionadas pelo Bicep tem
    ``allowSharedKeyAccess: false`` e recusam essa autenticacao no servidor.
    A ramificacao vive so aqui, na fabrica do client; todo o resto do log
    ignora como a conexao foi feita.
    """

    def __init__(
        self, account_url: str, container: str, connection_string: str = ""
    ) -> None:
        self._account_url = account_url
        self._container_name = container
        self._connection_string = connection_string
        self._service = None
        self._credential = None
        self._container_ready = False
        self._startup_lock = asyncio.Lock()

    # ------------------------------------------------------------ connection

    def _container(self):
        if self._service is None:
            # Import tardio: mantem o modulo importavel (e os testes rodando)
            # sem depender de o SDK estar instalado.
            from azure.storage.blob.aio import BlobServiceClient

            if self._connection_string:
                logger.warning(
                    "pulse: conectando por chave compartilhada "
                    "(PULSE_STORAGE_CONNECTION_STRING). Esperado apenas em "
                    "desenvolvimento local; em producao a conta recusa chave."
                )
                self._service = BlobServiceClient.from_connection_string(
                    self._connection_string
                )
            else:
                from azure.identity.aio import DefaultAzureCredential

                self._credential = DefaultAzureCredential()
                self._service = BlobServiceClient(
                    account_url=self._account_url, credential=self._credential
                )
        return self._service.get_container_client(self._container_name)

    async def _ensure_container(self) -> None:
        if self._container_ready:
            return
        async with self._startup_lock:
            if self._container_ready:
                return
            try:
                await self._container().create_container()
            except ResourceExistsError:
                pass
            self._container_ready = True

    async def close(self) -> None:
        if self._service is not None:
            await self._service.close()
            self._service = None
        if self._credential is not None:
            await self._credential.close()
            self._credential = None

    # ----------------------------------------------------------------- write

    async def append(self, moment: datetime, event: dict) -> None:
        """Acrescenta um evento ao arquivo do dia. Levanta se falhar."""

        await self._ensure_container()
        line = json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n"
        payload = line.encode("utf-8")
        blob = self._container().get_blob_client(_blob_name(moment.date()))

        try:
            await blob.append_block(payload)
            return
        except ResourceNotFoundError:
            pass

        # Primeiro evento do dia. Duas replicas podem chegar aqui juntas, entao
        # a criacao e condicional: quem perde a corrida recebe ResourceExists e
        # segue para o append, sem sobrescrever o arquivo do vencedor.
        try:
            await blob.create_append_blob(if_none_match="*")
        except ResourceExistsError:
            pass
        await blob.append_block(payload)

    # ------------------------------------------------------------------ read

    async def read(self, since: date | None) -> LogRead:
        """Le os eventos a partir de ``since``; None significa todo o historico."""

        await self._ensure_container()
        container = self._container()

        all_days: list[date] = []
        async for props in container.list_blobs(name_starts_with=f"{_PREFIX}/"):
            day = _day_from_name(props.name)
            if day is not None:
                all_days.append(day)

        total_days = len(all_days)
        first_day = min(all_days) if all_days else None
        days = [d for d in all_days if since is None or d >= since]

        if not days:
            return LogRead(
                events=[],
                unreadable_lines=0,
                days_in_window=0,
                total_days=total_days,
                first_day=first_day,
            )

        gate = asyncio.Semaphore(_MAX_CONCURRENT_READS)

        async def read_day(day: date) -> tuple[list[dict], int]:
            async with gate:
                blob = container.get_blob_client(_blob_name(day))
                try:
                    stream = await blob.download_blob()
                    raw = await stream.readall()
                except ResourceNotFoundError:
                    # Apagado entre o LIST e o GET. Zero eventos, nao um erro.
                    return [], 0
            return decode_lines(raw.decode("utf-8").splitlines())

        results = await asyncio.gather(*(read_day(d) for d in sorted(days)))

        events: list[dict] = []
        unreadable = 0
        for batch, failures in results:
            events.extend(batch)
            unreadable += failures

        return LogRead(
            events=events,
            unreadable_lines=unreadable,
            days_in_window=len(days),
            total_days=total_days,
            first_day=first_day,
        )


def decode_lines(lines: Iterable[str]) -> tuple[list[dict], int]:
    """Converte linhas em eventos, contando as ilegiveis em vez de escondê-las.

    Uma linha corrompida some da agregacao de qualquer jeito; a diferenca e que
    aqui ela sai contada, e a contagem aparece na procedencia do painel.
    """

    events: list[dict] = []
    unreadable = 0
    for line in lines:
        if not line.strip():
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            unreadable += 1
            continue
        if isinstance(parsed, dict):
            events.append(parsed)
        else:
            unreadable += 1
    return events, unreadable
