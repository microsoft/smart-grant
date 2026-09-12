"""Pulse - analytics de uso do portal.

Registra cada requisicao de Discovery e de Generation num log append-only
(``services.event_log``) e agrega esses eventos numa carga pronta para o
painel de ``GET /v2/analytics/pulse``.

Decisoes
~~~~~~~~
* **Janela escolhida pelo usuario.** Toda metrica obedece a mesma janela, e a
  janela viaja na resposta. Antes o painel misturava 7 dias, 30 dias e o
  historico inteiro em cards vizinhos, sem dizer qual era qual.
* **Fail-soft na escrita.** ``record_*`` nunca levanta. Telemetria nao pode
  derrubar o fluxo real; o pior que acontece e um aviso no log.
* **Sem semente.** Instalacao nova comeca vazia e o painel mostra um estado
  vazio honesto ate existir atividade real.
* **Sem armazenamento configurado, o rastreador fica desligado.** Nao existe
  implementacao alternativa em disco: duas vias de persistencia seria a
  bifurcacao que ninguem mantem.
"""

from __future__ import annotations

import logging
from collections import Counter
from datetime import UTC, date, datetime, timedelta
from typing import Any

from config import get_settings
from services.event_log import DailyEventLog, LogRead

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------- window

# Janelas oferecidas pela API. ``None`` e o historico completo.
WINDOW_CHOICES: dict[str, int | None] = {
    "7": 7,
    "30": 30,
    "90": 90,
    "365": 365,
    "all": None,
}

# Acima de certo tamanho, uma barra por dia vira um pente ilegivel. O balde
# cresce com a janela, e a carga declara qual balde usou, para o titulo do
# painel nunca desmentir o grafico.
_BUCKET_THRESHOLDS: tuple[tuple[int, str], ...] = ((90, "day"), (730, "week"))


def _bucket_for(window_days: int | None) -> str:
    if window_days is None:
        return "month"
    for limit, bucket in _BUCKET_THRESHOLDS:
        if window_days <= limit:
            return bucket
    return "month"


# --------------------------------------------------------------------- helpers

# Rotulo curto para cada tipo de bolsa. As chaves espelham GRANT_TYPES do
# config -- a lista antiga vivia em paralelo e usava "_" onde o produto usa
# "-", entao "computer-science" nunca casava e o painel exibia "Computer-
# Science". O teste test_every_grant_type_has_a_sector_label impede a volta
# do desalinhamento.
#
# Nao reaproveitamos GRANT_TYPES[k]["name"] porque ali estao os nomes dos
# programas ("Perkins V Career & Technical Education Grant"); aqui o que se
# quer e o setor, curto o bastante para caber numa lista.
_GRANT_TYPE_LABELS = {
    "stem": "STEM & Innovation",
    "ed-tech": "Educational Technology",
    "computer-science": "Computer Science",
    "maker-space": "STEM Maker Space",
    "special-ed": "Special Education",
    "accessibility": "Accessibility",
    "behavioral-support": "Behavioral Support",
    "cte": "Career & Technical Ed",
    "apprenticeship": "Apprenticeships",
    "dual-enrollment": "Dual Enrollment",
    "literacy": "Literacy",
    "title-i": "Title I Improvement",
    "ap-expansion": "AP & IB Expansion",
    "nutrition": "Nutrition",
    "mental-health": "Mental Health",
    "physical-education": "Physical Education",
    "arts": "Arts Education",
    "music": "Music Education",
    "school-safety": "School Safety",
    "green-energy": "Green Energy",
    "hvac": "Air Quality & HVAC",
    "ell": "English Learners",
    "equity": "Educational Equity",
    "homeless-support": "Homeless Student Support",
    "other": "Custom Grant",
}


def _now_utc() -> datetime:
    return datetime.now(UTC)


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat()


def _label(grant_type: str | None) -> str:
    if not grant_type:
        return "Unspecified"
    return _GRANT_TYPE_LABELS.get(
        grant_type, grant_type.replace("-", " ").replace("_", " ").title()
    )


def _parse_ts(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    # Todo evento e gravado em UTC; um sem fuso so pode ter vindo dali.
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _bucket_key(moment: datetime, bucket: str) -> str:
    day = moment.astimezone(UTC).date()
    if bucket == "day":
        return day.isoformat()
    if bucket == "week":
        return (day - timedelta(days=day.weekday())).isoformat()
    return day.replace(day=1).isoformat()


def _bucket_starts(first: date, last: date, bucket: str) -> list[str]:
    """Todos os inicios de balde entre duas datas, do mais antigo ao mais novo."""

    keys: list[str] = []
    if bucket == "day":
        cursor = first
        while cursor <= last:
            keys.append(cursor.isoformat())
            cursor += timedelta(days=1)
        return keys

    if bucket == "week":
        cursor = first - timedelta(days=first.weekday())
        while cursor <= last:
            keys.append(cursor.isoformat())
            cursor += timedelta(days=7)
        return keys

    cursor = first.replace(day=1)
    while cursor <= last:
        keys.append(cursor.isoformat())
        cursor = (cursor.replace(day=28) + timedelta(days=4)).replace(day=1)
    return keys


# --------------------------------------------------------------------- tracker


class PulseTracker:
    """Grava eventos de uso e monta o painel a partir deles."""

    def __init__(self, log: DailyEventLog | None) -> None:
        self._log = log

    @property
    def enabled(self) -> bool:
        return self._log is not None

    # ---------------------------------------------------------------- record

    async def record_discovery(
        self,
        grant_type: str,
        school_data: dict[str, Any] | None,
    ) -> None:
        """Registra uma requisicao de Discovery (etapa 1). Fail-soft."""

        await self._record(
            event_type="discovery", grant_type=grant_type, school_data=school_data
        )

    async def record_generation(
        self,
        grant_type: str,
        school_data: dict[str, Any] | None,
        selected_grant: Any | None,
    ) -> None:
        """Registra uma requisicao de Generation (etapa 2) com o alvo escolhido."""

        title: str | None = None
        funder: str | None = None
        amount_low: int | None = None
        amount_high: int | None = None

        if selected_grant is not None:
            # Pode ser um modelo Pydantic ou um dicionario, conforme a rota.
            get = (
                selected_grant.get
                if isinstance(selected_grant, dict)
                else lambda k, default=None: getattr(selected_grant, k, default)
            )
            title = get("title")
            funder = get("funder")
            amount_low = get("amount_low_usd")
            amount_high = get("amount_high_usd")

        await self._record(
            event_type="generation",
            grant_type=grant_type,
            school_data=school_data,
            selected_grant_title=title,
            selected_funder=funder,
            amount_low=amount_low,
            amount_high=amount_high,
        )

    async def _record(
        self,
        *,
        event_type: str,
        grant_type: str | None,
        school_data: dict[str, Any] | None,
        selected_grant_title: str | None = None,
        selected_funder: str | None = None,
        amount_low: int | None = None,
        amount_high: int | None = None,
    ) -> None:
        if self._log is None:
            return

        sd = school_data or {}

        def _clean(value: Any) -> Any | None:
            return None if value is None or value == "" else value

        moment = _now_utc()
        event = {
            "ts": _iso(moment),
            "event_type": event_type,
            "grant_type": grant_type,
            "school_name": _clean(sd.get("name")),
            "district": _clean(sd.get("district")),
            "state": _clean(sd.get("state")),
            "city": _clean(sd.get("city")),
            "school_type": _clean(sd.get("type")),
            "students": _clean(sd.get("students")),
            "grade_levels": _clean(sd.get("grades")),
            "selected_grant_title": selected_grant_title,
            "selected_funder": selected_funder,
            "amount_low": amount_low,
            "amount_high": amount_high,
        }

        try:
            await self._log.append(moment, event)
        except Exception:  # pragma: no cover - telemetria nunca derruba o fluxo
            logger.warning(
                "pulse: falha ao gravar evento %s", event_type, exc_info=True
            )

    # ------------------------------------------------------------- aggregate

    async def compute_pulse(self, window_days: int | None) -> dict[str, Any]:
        now = _now_utc()

        if self._log is None:
            return _empty_payload(now, window_days, configured=False)

        since = (
            None if window_days is None else (now - timedelta(days=window_days)).date()
        )
        read = await self._log.read(since)
        return aggregate(read, window_days=window_days, now=now)


# --------------------------------------------------------------------- payload


def _window_block(
    window_days: int | None, now: datetime, first_event: datetime | None
) -> dict[str, Any]:
    """Descreve a janela pedida e o intervalo que os dados realmente cobrem.

    ``from`` e o primeiro evento *dentro* da janela, nao o inicio nominal dela.
    Uma janela de 365 dias sobre um portal de duas semanas cobre duas semanas,
    e o painel diz isso em vez de sugerir um ano de historico.
    """

    covered = first_event.astimezone(UTC).date() if first_event else None
    return {
        "days": window_days,
        "from": covered.isoformat() if covered else None,
        "to": now.astimezone(UTC).date().isoformat() if covered else None,
    }


def _empty_payload(
    now: datetime, window_days: int | None, *, configured: bool
) -> dict[str, Any]:
    return {
        "as_of": _iso(now),
        "window": _window_block(window_days, now, None),
        "totals": {
            "agent_runs": 0,
            "applications_drafted": 0,
            "schools_served": 0,
            "funding_explored_usd": 0,
            "conversion_pct": 0,
            "avg_award_ceiling_usd": 0,
        },
        "by_sector": [],
        "by_state": [],
        "by_school_type": [],
        "top_schools": [],
        "top_funders": [],
        "activity": {"bucket": _bucket_for(window_days), "points": []},
        "recent_activity": [],
        "provenance": {
            "storage_configured": configured,
            "events_in_window": 0,
            "history_started_on": None,
            "unreadable_lines": 0,
            "source": (
                "Append-only event log on Azure Blob Storage (Discovery + Generation)."
                if configured
                else "Pulse storage is not configured; no activity is being recorded."
            ),
        },
    }


def aggregate(read: LogRead, *, window_days: int | None, now: datetime) -> dict[str, Any]:
    """Agrega os eventos da janela.

    Funcao pura: nao toca em rede nem le o relogio. O ``now`` entra por
    parametro justamente para o comportamento nas bordas da janela poder ser
    testado sem esperar o tempo passar.
    """

    cutoff = None if window_days is None else now - timedelta(days=window_days)

    rows: list[dict[str, Any]] = []
    for event in read.events:
        moment = _parse_ts(event.get("ts"))
        if moment is None:
            continue
        # O arquivo do dia do corte tambem carrega eventos anteriores a hora
        # do corte; o filtro fino acontece aqui.
        if cutoff is not None and moment < cutoff:
            continue
        rows.append({**event, "_ts": moment})

    history_started_on = read.first_day.isoformat() if read.first_day else None

    if not rows:
        payload = _empty_payload(now, window_days, configured=True)
        payload["provenance"]["history_started_on"] = history_started_on
        payload["provenance"]["unreadable_lines"] = read.unreadable_lines
        return payload

    rows.sort(key=lambda r: r["_ts"], reverse=True)

    discoveries = [r for r in rows if r.get("event_type") == "discovery"]
    generations = [r for r in rows if r.get("event_type") == "generation"]

    schools = {r["school_name"] for r in rows if r.get("school_name")}
    funding_explored = sum(
        int(r["amount_high"]) for r in generations if r.get("amount_high")
    )
    conversion_pct = (
        round(100 * len(generations) / len(discoveries)) if discoveries else 0
    )
    sized = [int(r["amount_high"]) for r in generations if r.get("amount_high")]
    avg_amount = int(sum(sized) / len(sized)) if sized else 0

    bucket = _bucket_for(window_days)
    first_ts = rows[-1]["_ts"]
    start = first_ts.astimezone(UTC).date()
    if cutoff is not None:
        start = max(start, cutoff.astimezone(UTC).date())
    counts: dict[str, dict[str, int]] = {
        key: {"discoveries": 0, "generations": 0}
        for key in _bucket_starts(start, now.astimezone(UTC).date(), bucket)
    }
    for r in rows:
        key = _bucket_key(r["_ts"], bucket)
        if key in counts:
            slot = "generations" if r.get("event_type") == "generation" else "discoveries"
            counts[key][slot] += 1
    points = [{"date": key, **value} for key, value in counts.items()]

    sector_counter: Counter[str] = Counter(
        r["grant_type"] for r in rows if r.get("grant_type")
    )
    state_counter: Counter[str] = Counter(r["state"] for r in rows if r.get("state"))
    type_counter: Counter[str] = Counter(
        r["school_type"] for r in rows if r.get("school_type")
    )
    funder_counter: Counter[str] = Counter(
        r["selected_funder"] for r in generations if r.get("selected_funder")
    )

    school_counter: Counter[str] = Counter()
    school_state: dict[str, str] = {}
    for r in rows:
        if r.get("school_name"):
            school_counter[r["school_name"]] += 1
            if r.get("state"):
                school_state[r["school_name"]] = r["state"]

    return {
        "as_of": _iso(now),
        "window": _window_block(window_days, now, first_ts),
        "totals": {
            # Cada linha do log e uma execucao do pipeline. Nao chamamos isso
            # de "sessao": uma descoberta seguida da geracao na mesma escola e
            # uma visita so, contada aqui como duas execucoes -- que e o que
            # de fato aconteceu.
            "agent_runs": len(rows),
            "applications_drafted": len(generations),
            "schools_served": len(schools),
            "funding_explored_usd": funding_explored,
            "conversion_pct": conversion_pct,
            # `amount_high` e o topo da faixa de premiacao do edital, nao um
            # valor que alguem pediu. Chamar isso de "requested" seria inventar
            # um numero que o produto nunca coletou.
            "avg_award_ceiling_usd": avg_amount,
        },
        "by_sector": [
            {"key": k, "label": _label(k), "count": c}
            for k, c in sector_counter.most_common()
        ],
        "by_state": [{"state": s, "count": c} for s, c in state_counter.most_common(10)],
        "by_school_type": [
            {"label": k.capitalize(), "count": c} for k, c in type_counter.most_common()
        ],
        "top_schools": [
            {"name": name, "count": c, "state": school_state.get(name)}
            for name, c in school_counter.most_common(8)
        ],
        "top_funders": [
            {"name": name, "count": c} for name, c in funder_counter.most_common(6)
        ],
        "activity": {"bucket": bucket, "points": points},
        "recent_activity": [
            {
                "ts": r["ts"],
                "event_type": r.get("event_type"),
                "sector": _label(r.get("grant_type")),
                "school_name": r.get("school_name"),
                "state": r.get("state"),
                "selected_grant_title": r.get("selected_grant_title"),
                "selected_funder": r.get("selected_funder"),
            }
            for r in rows[:12]
        ],
        "provenance": {
            "storage_configured": True,
            "events_in_window": len(rows),
            "history_started_on": history_started_on,
            "unreadable_lines": read.unreadable_lines,
            "source": (
                "Append-only event log on Azure Blob Storage (Discovery + Generation)."
            ),
        },
    }


# ------------------------------------------------------------- module singleton

_TRACKER: PulseTracker | None = None


def get_pulse_tracker() -> PulseTracker:
    global _TRACKER
    if _TRACKER is None:
        settings = get_settings()
        url = settings.pulse_storage_account_url.strip()
        conn = settings.pulse_storage_connection_string.strip()
        if url:
            if conn:
                logger.warning(
                    "pulse: PULSE_STORAGE_ACCOUNT_URL e "
                    "PULSE_STORAGE_CONNECTION_STRING definidos ao mesmo tempo; "
                    "usando a URL (Entra ID) e ignorando a chave"
                )
            log: DailyEventLog | None = DailyEventLog(
                url, settings.pulse_storage_container
            )
        elif conn:
            log = DailyEventLog(
                "", settings.pulse_storage_container, connection_string=conn
            )
        else:
            log = None
            logger.info(
                "pulse: PULSE_STORAGE_ACCOUNT_URL nao definido; "
                "nenhuma atividade sera registrada"
            )
        _TRACKER = PulseTracker(log)
    return _TRACKER
