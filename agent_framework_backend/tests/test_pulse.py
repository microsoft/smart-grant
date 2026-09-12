"""Testes do Pulse: log de eventos em blob e agregacao por janela.

A agregacao e uma funcao pura sobre um ``LogRead``, entao tudo aqui roda sem
Azure, sem rede e sem relogio real -- o ``now`` entra por parametro para as
bordas da janela poderem ser exercitadas de verdade.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, date, datetime, timedelta
from unittest.mock import patch

from azure.core.exceptions import ResourceExistsError, ResourceNotFoundError

from services.event_log import (
    DailyEventLog,
    LogRead,
    _blob_name,
    _day_from_name,
    decode_lines,
)
from services.pulse import PulseTracker, aggregate

NOW = datetime(2026, 9, 5, 12, 0, tzinfo=UTC)


def _event(
    *,
    days_ago: float = 0,
    event_type: str = "discovery",
    school: str | None = "Lincoln High",
    state: str | None = "CA",
    grant_type: str | None = "stem",
    funder: str | None = None,
    amount_high: int | None = None,
) -> dict:
    return {
        "ts": (NOW - timedelta(days=days_ago)).isoformat(),
        "event_type": event_type,
        "grant_type": grant_type,
        "school_name": school,
        "district": None,
        "state": state,
        "city": None,
        "school_type": "public",
        "students": 2500,
        "grade_levels": "9-12",
        "selected_grant_title": "Discovery Research PreK-12" if funder else None,
        "selected_funder": funder,
        "amount_low": None,
        "amount_high": amount_high,
    }


def _read(events: list[dict], *, first_day: date | None = None) -> LogRead:
    return LogRead(
        events=events,
        unreadable_lines=0,
        days_in_window=len({e["ts"][:10] for e in events}),
        total_days=len({e["ts"][:10] for e in events}),
        first_day=first_day or date(2026, 5, 22),
    )


# ------------------------------------------------------------------ blob names


def test_blob_name_round_trips_through_the_date() -> None:
    """O nome e o indice: se ele nao voltar a virar data, a janela quebra."""

    day = date(2026, 9, 5)
    assert _blob_name(day) == "events/2026/09/05.jsonl"
    assert _day_from_name(_blob_name(day)) == day


def test_day_from_name_rejects_anything_that_is_not_an_event_file() -> None:
    for name in (
        "events/2026/09/readme.txt",
        "outro/2026/09/05.jsonl",
        "events/2026/09.jsonl",
        "events/nao/e/data.jsonl",
    ):
        assert _day_from_name(name) is None


# --------------------------------------------------------------------- parsing


def test_decode_counts_bad_lines_instead_of_hiding_them() -> None:
    """Linha corrompida some da agregacao de qualquer jeito; tem que sair contada."""

    events, unreadable = decode_lines(
        ['{"ts":"x"}', "", "   ", "{nao e json", '"uma string"', '{"ts":"y"}']
    )
    assert [e["ts"] for e in events] == ["x", "y"]
    assert unreadable == 2


# ---------------------------------------------------------------------- window


def test_window_excludes_events_older_than_the_cutoff() -> None:
    """O arquivo do dia do corte carrega eventos anteriores a hora do corte.

    Sem o filtro fino, uma janela de 7 dias devolveria ate 8 dias de dados.
    """

    read = _read([_event(days_ago=1), _event(days_ago=6.9), _event(days_ago=7.1)])
    payload = aggregate(read, window_days=7, now=NOW)
    assert payload["totals"]["agent_runs"] == 2


def test_all_time_window_keeps_every_event() -> None:
    read = _read([_event(days_ago=1), _event(days_ago=400)])
    payload = aggregate(read, window_days=None, now=NOW)
    assert payload["totals"]["agent_runs"] == 2
    assert payload["window"]["days"] is None


def test_window_reports_the_range_actually_covered_not_the_nominal_one() -> None:
    """Uma janela de 365 dias sobre 3 dias de dados cobre 3 dias, e diz isso."""

    read = _read([_event(days_ago=3), _event(days_ago=1)])
    payload = aggregate(read, window_days=365, now=NOW)
    assert payload["window"]["from"] == "2026-09-02"
    assert payload["window"]["to"] == "2026-09-05"


def test_window_from_is_the_first_event_inside_it_not_the_oldest_on_record() -> None:
    """Evento de 200 dias atras fica fora de uma janela de 7 e nao pode datar o rotulo."""

    read = _read([_event(days_ago=200), _event(days_ago=2)])
    payload = aggregate(read, window_days=7, now=NOW)
    assert payload["window"]["from"] == "2026-09-03"
    assert payload["totals"]["agent_runs"] == 1


# --------------------------------------------------------------------- buckets


def test_bucket_size_grows_with_the_window() -> None:
    """Uma barra por dia em 5 anos vira um pente ilegivel."""

    read = _read([_event(days_ago=1)])
    assert aggregate(read, window_days=30, now=NOW)["activity"]["bucket"] == "day"
    assert aggregate(read, window_days=365, now=NOW)["activity"]["bucket"] == "week"
    assert aggregate(read, window_days=None, now=NOW)["activity"]["bucket"] == "month"


def test_daily_buckets_cover_every_day_including_the_silent_ones() -> None:
    read = _read([_event(days_ago=0), _event(days_ago=6)])
    points = aggregate(read, window_days=7, now=NOW)["activity"]["points"]
    assert len(points) == 7
    assert sum(p["discoveries"] for p in points) == 2
    # Cronologico, do mais antigo para o mais novo.
    assert [p["date"] for p in points] == sorted(p["date"] for p in points)


# ---------------------------------------------------------------------- totals


def test_totals_follow_the_selected_window() -> None:
    """Antes, funding_explored somava o historico ao lado de metricas de 30 dias."""

    events = [
        _event(days_ago=2, event_type="generation", funder="NSF", amount_high=100_000),
        _event(days_ago=90, event_type="generation", funder="NSF", amount_high=900_000),
    ]
    dentro = aggregate(_read(events), window_days=30, now=NOW)
    tudo = aggregate(_read(events), window_days=None, now=NOW)

    assert dentro["totals"]["funding_explored_usd"] == 100_000
    assert tudo["totals"]["funding_explored_usd"] == 1_000_000
    assert len(dentro["top_funders"]) == 1
    assert dentro["top_funders"][0]["count"] == 1
    assert tudo["top_funders"][0]["count"] == 2


def test_distinct_schools_are_counted_once() -> None:
    read = _read(
        [
            _event(days_ago=1, school="Lincoln High"),
            _event(days_ago=2, school="Lincoln High"),
            _event(days_ago=3, school="Kaktovik School"),
        ]
    )
    assert aggregate(read, window_days=30, now=NOW)["totals"]["schools_served"] == 2


def test_conversion_is_zero_when_there_are_no_discoveries() -> None:
    """Divisao por zero aqui derrubaria o painel inteiro."""

    read = _read([_event(days_ago=1, event_type="generation", funder="NSF")])
    assert aggregate(read, window_days=30, now=NOW)["totals"]["conversion_pct"] == 0


def test_event_with_unparseable_timestamp_is_dropped_not_crashed() -> None:
    bad = _event(days_ago=1)
    bad["ts"] = "ontem"
    read = _read([bad, _event(days_ago=1)])
    assert aggregate(read, window_days=30, now=NOW)["totals"]["agent_runs"] == 1


# ------------------------------------------------------- empty vs quiet window


def test_quiet_window_is_not_the_same_as_an_empty_install() -> None:
    """Escolher uma semana parada nao pode mostrar a tela de boas-vindas."""

    read = _read([_event(days_ago=200)], first_day=date(2026, 2, 1))
    payload = aggregate(read, window_days=7, now=NOW)

    assert payload["totals"]["agent_runs"] == 0
    assert payload["provenance"]["storage_configured"] is True
    # O historico existe, e a procedencia prova isso.
    assert payload["provenance"]["history_started_on"] == "2026-02-01"


def test_unreadable_lines_survive_into_provenance_even_when_nothing_matches() -> None:
    read = LogRead(
        events=[], unreadable_lines=3, days_in_window=0, total_days=2,
        first_day=date(2026, 2, 1),
    )
    payload = aggregate(read, window_days=30, now=NOW)
    assert payload["provenance"]["unreadable_lines"] == 3


# --------------------------------------------------------------------- tracker


def test_tracker_without_storage_records_nothing_and_says_so() -> None:
    """Sem armazenamento o Pulse desliga -- nao cai, e nao inventa dado local."""

    tracker = PulseTracker(None)
    assert tracker.enabled is False

    async def exercise() -> dict:
        await tracker.record_discovery("stem", {"name": "Lincoln High"})
        return await tracker.compute_pulse(30)

    payload = asyncio.run(exercise())
    assert payload["provenance"]["storage_configured"] is False
    assert payload["totals"]["agent_runs"] == 0


def test_record_never_raises_when_the_log_fails() -> None:
    """Telemetria nao pode derrubar o fluxo real."""

    class BrokenLog:
        async def append(self, moment, event):
            raise RuntimeError("storage down")

    tracker = PulseTracker(BrokenLog())  # type: ignore[arg-type]
    asyncio.run(tracker.record_generation("stem", {"name": "X"}, None))


# ------------------------------------------------------------------- blob i/o
#
# O duplo abaixo imita so a superficie do SDK que usamos. Nao prova o contrato
# do Azure -- prova a nossa logica em cima dele, que e onde estao as sutilezas:
# a corrida na criacao do arquivo do dia e o 404 tratado como vazio.


class _FakeBlob:
    def __init__(self, store: dict[str, bytes | None], name: str) -> None:
        self._store = store
        self._name = name

    async def append_block(self, data: bytes) -> None:
        if self._name not in self._store:
            raise ResourceNotFoundError(self._name)
        self._store[self._name] = (self._store[self._name] or b"") + data

    async def create_append_blob(self, if_none_match: str | None = None) -> None:
        if if_none_match == "*" and self._name in self._store:
            raise ResourceExistsError(self._name)
        self._store[self._name] = b""

    async def download_blob(self):
        if self._name not in self._store:
            raise ResourceNotFoundError(self._name)
        payload = self._store[self._name] or b""

        class _Stream:
            async def readall(self) -> bytes:
                return payload

        return _Stream()


class _FakeProps:
    def __init__(self, name: str) -> None:
        self.name = name


class _FakeContainer:
    def __init__(self, store: dict[str, bytes | None]) -> None:
        self._store = store

    def get_blob_client(self, name: str) -> _FakeBlob:
        return _FakeBlob(self._store, name)

    async def create_container(self) -> None:
        raise ResourceExistsError("already there")

    def list_blobs(self, name_starts_with: str = ""):
        names = [n for n in self._store if n.startswith(name_starts_with)]

        async def iterator():
            for n in names:
                yield _FakeProps(n)

        return iterator()


def _log_over(store: dict[str, bytes | None]) -> DailyEventLog:
    log = DailyEventLog("https://example.blob.core.windows.net", "pulse")
    log._container = lambda: _FakeContainer(store)  # type: ignore[method-assign]
    return log


def test_first_event_of_the_day_creates_the_file_then_appends() -> None:
    store: dict[str, bytes | None] = {}
    log = _log_over(store)

    asyncio.run(log.append(NOW, {"ts": NOW.isoformat(), "event_type": "discovery"}))

    assert list(store) == ["events/2026/09/05.jsonl"]
    assert store["events/2026/09/05.jsonl"].endswith(b"\n")


def test_losing_the_creation_race_must_not_wipe_the_winners_file() -> None:
    """A corrida real: outra replica cria o arquivo entre a nossa checagem e a nossa criacao.

    Reproduzido de forma deterministica -- o primeiro ``append_block`` levanta
    ResourceNotFound como se o arquivo nao existisse, mas ele ja existe e com
    conteudo. Sem o ``if_none_match='*'`` a criacao truncaria o arquivo e o
    evento do vencedor sumiria em silencio.
    """

    name = "events/2026/09/05.jsonl"
    store: dict[str, bytes | None] = {name: b'{"who":"winner"}\n'}

    class _StaleView(_FakeBlob):
        primeira_chamada = True

        async def append_block(self, data: bytes) -> None:
            if _StaleView.primeira_chamada:
                _StaleView.primeira_chamada = False
                raise ResourceNotFoundError(self._name)
            await super().append_block(data)

    class _RacingContainer(_FakeContainer):
        def get_blob_client(self, blob_name: str):
            return _StaleView(self._store, blob_name)

    log = DailyEventLog("https://example.blob.core.windows.net", "pulse")
    log._container = lambda: _RacingContainer(store)  # type: ignore[method-assign]

    asyncio.run(log.append(NOW, {"who": "loser"}))

    lines = store[name].decode().strip().splitlines()
    assert [json.loads(line)["who"] for line in lines] == ["winner", "loser"]


def test_read_skips_files_that_vanish_between_list_and_get() -> None:
    """Um 404 na leitura e zero evento daquele dia, nao uma falha do painel."""

    presente = "events/2026/09/04.jsonl"
    sumido = "events/2026/09/05.jsonl"
    store: dict[str, bytes | None] = {
        presente: json.dumps(_event(days_ago=1)).encode() + b"\n",
        sumido: b"",
    }

    class _Vanishing(_FakeContainer):
        def get_blob_client(self, name: str):
            # Aparece no LIST, some antes do GET.
            return _FakeBlob({} if name == sumido else self._store, name)

    log = DailyEventLog("https://example.blob.core.windows.net", "pulse")
    log._container = lambda: _Vanishing(store)  # type: ignore[method-assign]

    result = asyncio.run(log.read(None))
    assert len(result.events) == 1
    assert result.days_in_window == 2


def test_read_reports_the_whole_log_extent_not_just_the_window() -> None:
    """E o que permite ao painel separar 'janela parada' de 'instalacao nova'."""

    store: dict[str, bytes | None] = {
        "events/2026/02/01.jsonl": json.dumps({"ts": "2026-02-01T00:00:00+00:00"}).encode()
        + b"\n",
        "events/2026/09/05.jsonl": json.dumps({"ts": NOW.isoformat()}).encode() + b"\n",
        "events/nao-e-evento.txt": b"ignorar",
    }
    log = _log_over(store)

    result = asyncio.run(log.read(date(2026, 9, 1)))
    assert len(result.events) == 1
    assert result.days_in_window == 1
    assert result.total_days == 2
    assert result.first_day == date(2026, 2, 1)


# ------------------------------------------------------- rotulos de setor


def test_every_grant_type_has_a_sector_label() -> None:
    """As duas listas ja divergiram uma vez, e em silencio.

    O mapa de rotulos usava "_" onde GRANT_TYPES usa "-", entao todo tipo com
    mais de uma palavra caia no fallback e o painel mostrava "Computer-Science"
    e "Mental-Health". Nada quebrava; so ficava feio e errado.
    """

    from config import GRANT_TYPES
    from services.pulse import _GRANT_TYPE_LABELS

    faltando = set(GRANT_TYPES) - set(_GRANT_TYPE_LABELS)
    assert not faltando, f"tipos sem rotulo: {sorted(faltando)}"

    sobrando = set(_GRANT_TYPE_LABELS) - set(GRANT_TYPES)
    assert not sobrando, f"rotulos para tipos que nao existem: {sorted(sobrando)}"


def test_unknown_grant_type_still_reads_like_a_label() -> None:
    """Um tipo novo nao pode aparecer no painel como slug cru."""

    from services.pulse import _label

    assert _label("computer-science") == "Computer Science"
    assert _label("tipo-novo-qualquer") == "Tipo Novo Qualquer"
    assert _label(None) == "Unspecified"


# ------------------------------------------------------- escotilha de dev local


def test_connection_string_path_never_constructs_an_entra_credential() -> None:
    """A escotilha do emulador nao pode virar um segundo caminho de auth.

    Se um dia alguem fizer a fabrica montar credencial *e* chave, este teste
    falha -- e e exatamente esse o cenario que queremos impossivel.
    """

    visto: dict[str, object] = {}

    class _Servico:
        @classmethod
        def from_connection_string(cls, conn: str) -> _Servico:
            visto["conn"] = conn
            return cls()

        def get_container_client(self, name: str) -> object:
            visto["container"] = name
            return object()

    def _proibido(*_args: object, **_kwargs: object) -> object:
        raise AssertionError("DefaultAzureCredential nao deveria ser construida")

    with (
        patch("azure.storage.blob.aio.BlobServiceClient", _Servico),
        patch("azure.identity.aio.DefaultAzureCredential", _proibido),
    ):
        log = DailyEventLog("", "pulse", connection_string="UseDevelopmentStorage=true")
        log._container()  # type: ignore[misc]

    assert visto == {"conn": "UseDevelopmentStorage=true", "container": "pulse"}


def test_a_stray_connection_string_cannot_downgrade_a_real_install() -> None:
    """Com os dois definidos, a URL (Entra ID) vence. Nunca o contrario."""

    import services.pulse as pulse_module

    class _Config:
        pulse_storage_account_url = "https://real.blob.core.windows.net"
        pulse_storage_container = "pulse"
        pulse_storage_connection_string = "UseDevelopmentStorage=true"

    original = pulse_module._TRACKER
    try:
        pulse_module._TRACKER = None
        with patch.object(pulse_module, "get_settings", lambda: _Config()):
            tracker = pulse_module.get_pulse_tracker()
    finally:
        pulse_module._TRACKER = original

    assert tracker.enabled
    assert tracker._log._connection_string == ""  # type: ignore[union-attr]
    assert tracker._log._account_url == "https://real.blob.core.windows.net"  # type: ignore[union-attr]
