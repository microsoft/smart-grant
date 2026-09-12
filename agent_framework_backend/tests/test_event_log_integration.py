"""Contrato do SDK do Azure Blob, verificado contra o emulador.

Os testes de ``test_pulse.py`` usam fakes: eles provam a nossa logica, nao a
semantica do servico. Se ``append_block`` nao levantasse 404 em blob ausente,
ou se ``create_append_blob(if_none_match="*")`` nao recusasse sobrescrever,
todos passariam e producao quebraria. Estes fecham essa lacuna.

Rodar exige o Azurite (emulador oficial da Microsoft) na porta 10000::

    npx --yes -p azurite azurite-blob --location ./.azurite --blobPort 10000

Sem ele, o modulo inteiro e pulado -- CI e quem so quer rodar a suite normal
nao precisam de nada instalado. Vale dizer o que isto **nao** prova: Azurite e
um emulador, entao o que se verifica aqui e o contrato da API, nao o
comportamento do servico real sob carga.
"""

from __future__ import annotations

import socket
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from azure.core.exceptions import ResourceExistsError, ResourceNotFoundError

from services.event_log import DailyEventLog, _blob_name

AZURITE_HOST = "127.0.0.1"
AZURITE_PORT = 10000

# Chave publica de desenvolvimento do Azurite, documentada pela Microsoft e
# identica em toda instalacao. Nao e um segredo.
AZURITE_CONNECTION_STRING = (
    "DefaultEndpointsProtocol=http;"
    "AccountName=devstoreaccount1;"
    "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/"
    "K1SZFPTOtr/KBHBeksoGMGw==;"
    f"BlobEndpoint=http://{AZURITE_HOST}:{AZURITE_PORT}/devstoreaccount1;"
)


def _azurite_esta_no_ar() -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex((AZURITE_HOST, AZURITE_PORT)) == 0


pytestmark = [
    pytest.mark.skipif(
        not _azurite_esta_no_ar(),
        reason=f"Azurite nao esta escutando em {AZURITE_HOST}:{AZURITE_PORT}",
    ),
    pytest.mark.asyncio,
]

DIA_A = datetime(2026, 3, 4, 12, 0, tzinfo=UTC)
DIA_B = DIA_A + timedelta(days=1)


@pytest.fixture
async def service():
    from azure.storage.blob.aio import BlobServiceClient

    client = BlobServiceClient.from_connection_string(AZURITE_CONNECTION_STRING)
    try:
        yield client
    finally:
        await client.close()


@pytest.fixture
async def log(service):
    """Um ``DailyEventLog`` real, apontado para um container descartavel."""

    nome = f"pulse-teste-{uuid.uuid4().hex[:12]}"
    diario = DailyEventLog("", nome)
    # A unica coisa trocada e a fabrica do client: todo o resto do log --
    # nomes, criacao condicional, leitura -- e o codigo de producao.
    diario._container = lambda: service.get_container_client(nome)  # type: ignore[method-assign]
    try:
        yield diario
    finally:
        try:
            await service.get_container_client(nome).delete_container()
        except ResourceNotFoundError:
            pass


async def test_eventos_atravessam_dias_e_voltam_na_leitura(log: DailyEventLog) -> None:
    await log.append(DIA_A, {"kind": "discovery", "school": "A"})
    await log.append(DIA_A, {"kind": "generation", "school": "A"})
    await log.append(DIA_B, {"kind": "discovery", "school": "B"})

    tudo = await log.read(None)
    assert len(tudo.events) == 3
    assert tudo.total_days == 2
    assert tudo.first_day == DIA_A.date()
    assert tudo.unreadable_lines == 0

    janela = await log.read(DIA_B.date())
    assert len(janela.events) == 1
    assert janela.days_in_window == 1
    # O extent do log inteiro sobrevive ao recorte -- e o que separa
    # "janela parada" de "instalacao nova" no painel.
    assert janela.total_days == 2
    assert janela.first_day == DIA_A.date()


async def test_append_em_blob_ausente_levanta_404(log: DailyEventLog) -> None:
    """Premissa do caminho rapido: tentamos o append antes de criar o blob."""

    await log._ensure_container()
    blob = log._container().get_blob_client(_blob_name(DIA_A.date()))
    with pytest.raises(ResourceNotFoundError):
        await blob.append_block(b"x\n")


async def test_leitura_de_blob_ausente_levanta_404(log: DailyEventLog) -> None:
    """E o que ``read`` trata como zero eventos, nao como erro."""

    await log._ensure_container()
    blob = log._container().get_blob_client(_blob_name(DIA_A.date()))
    with pytest.raises(ResourceNotFoundError):
        await blob.download_blob()


async def test_criacao_condicional_nao_sobrescreve_o_arquivo_do_dia(
    log: DailyEventLog,
) -> None:
    """Sem o ``if_none_match``, quem perde a corrida zera o arquivo do vencedor."""

    await log.append(DIA_A, {"kind": "discovery", "school": "A"})
    blob = log._container().get_blob_client(_blob_name(DIA_A.date()))

    with pytest.raises(ResourceExistsError):
        await blob.create_append_blob(if_none_match="*")

    depois = await log.read(None)
    assert len(depois.events) == 1


async def test_escritores_concorrentes_nao_perdem_nem_partem_linhas(
    service, log: DailyEventLog
) -> None:
    """O caso que motivou o desenho: varias replicas escrevendo no mesmo dia."""

    import asyncio

    nome = log._container_name
    escritores = [DailyEventLog("", nome) for _ in range(12)]
    for w in escritores:
        w._container = lambda: service.get_container_client(nome)  # type: ignore[method-assign]

    await log._ensure_container()
    for w in escritores:
        w._container_ready = True

    await asyncio.gather(
        *(w.append(DIA_A, {"kind": "discovery", "n": i}) for i, w in enumerate(escritores))
    )

    resultado = await log.read(None)
    assert sorted(e["n"] for e in resultado.events) == list(range(12))
    assert resultado.unreadable_lines == 0


async def test_log_vazio_le_como_vazio(log: DailyEventLog) -> None:
    vazio = await log.read(None)
    assert vazio.events == []
    assert vazio.total_days == 0
    assert vazio.first_day is None
