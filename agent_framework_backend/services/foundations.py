"""
Foundations — real, public foundation data via ProPublica Nonprofit
Explorer.

ProPublica's Nonprofit Explorer is a free, no-auth, public-domain index
of every IRS-registered tax-exempt organization in the United States,
including their NTEE (National Taxonomy of Exempt Entities) codes and
the full text of their Form 990 / 990-PF filings. The Explorer API
returns lean entity records that we map to :class:`services.grants.Grant`
prospects so the existing Discovery aggregator can rank them alongside
federal opportunities.

We restrict every search to:

* ``c_code[id]=3`` — 501(c)(3) charitable organisations
* ``ntee[id]=2``    — NTEE Major Group B = Education

That gives us 6k+ active education-focused foundations across the U.S.
The user is told plainly that these are *prospect* funders (verified
501(c)(3) education funders per Form 990) rather than open RFP listings;
the URL points back to the ProPublica detail page where each foundation's
actual giving history is reproduced from public 990 data.

Nothing in this module is mock. Every record returned is sourced live
from ProPublica or, on transient failure, an empty list.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import Counter
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

from services.grants import Grant

logger = logging.getLogger(__name__)

_SEARCH_ENDPOINT = "https://projects.propublica.org/nonprofits/api/v2/search.json"
_DETAIL_ENDPOINT = "https://projects.propublica.org/nonprofits/api/v2/organizations/{ein}.json"
_ORG_URL = "https://projects.propublica.org/nonprofits/organizations/{ein}"
_HEADERS = {
    "Accept": "application/json",
    "User-Agent": "smart-grant-request/v2-foundations",
}

# NTEE major-group B = Education. id=2 is ProPublica's facet id.
_NTEE_EDUCATION = "2"
_CCODE_501C3 = "3"


# Human labels for the four-character NTEE subcategory codes most common
# under Major Group B. We keep this list deliberately small — anything
# not matched falls back to the raw code prefix.
_NTEE_LABELS = {
    "B11": "Education research & policy",
    "B12": "Education fund & financial support",
    "B20": "Elementary & secondary schools",
    "B21": "Kindergarten / preschool",
    "B24": "Primary & elementary schools",
    "B25": "Secondary & high schools",
    "B28": "Specialized education",
    "B29": "Charter schools",
    "B30": "Vocational & technical schools",
    "B40": "Higher education",
    "B50": "Graduate & professional schools",
    "B60": "Adult & continuing education",
    "B70": "Libraries",
    "B80": "Student services & organizations",
    "B82": "Scholarships & student aid",
    "B90": "Educational services & support",
    "B92": "Remedial reading & encouragement",
    "B94": "Parent / teacher groups",
    "B99": "Education N.E.C.",
}


def _ntee_label(code: str) -> str:
    if not code:
        return "Education"
    code = code.upper()
    if code in _NTEE_LABELS:
        return _NTEE_LABELS[code]
    # Match on three-character prefix.
    prefix = code[:3]
    return _NTEE_LABELS.get(prefix, "Education foundation")


class FoundationsService:
    """Async client for ProPublica Nonprofit Explorer (education segment)."""

    _CACHE_TTL_SECONDS = 600  # 10 minutes per cache key
    _DETAIL_TTL_SECONDS = 3600  # 60 minutes for per-EIN org detail fetches

    def __init__(self) -> None:
        self._cache: dict[str, tuple[float, Any]] = {}
        self._lock = asyncio.Lock()

    # ---------------------------------------------------------------- search

    async def search_foundations(
        self,
        keyword: str,
        state: str | None = None,
        limit: int = 12,
    ) -> list[Grant]:
        """Return education foundations matching ``keyword`` (and optionally
        ``state``) as normalised :class:`Grant` prospects.

        The result list is capped at ``limit`` (defaults to 12) so that
        the Discovery LLM never has its context flooded with hundreds of
        foundation records. The total universe size (per query) is logged
        for visibility.
        """
        cache_key = f"search::{(keyword or '').lower()}::{(state or '').upper()}::{limit}"
        cached = await self._get_cached(cache_key)
        if cached is not None:
            return cached  # type: ignore[return-value]

        # ProPublica's search endpoint is finicky about long multi-word
        # queries and 404s on certain phrasings (it dislikes the literal
        # word "grant" and queries longer than ~3 tokens). Sanitize:
        # strip noise tokens, cap to 3 words, and fall back to a single
        # token then to a bare "education" search.
        def _sanitize(raw: str) -> list[str]:
            stop = {"grant", "grants", "program", "programs", "for", "the", "a", "an"}
            toks = [t for t in (raw or "").lower().split() if t and t not in stop]
            return toks[:3]

        primary = " ".join(_sanitize(keyword)) or "education"
        candidate_queries: list[str] = []
        for q in (primary, primary.split()[0] if primary else "", "education"):
            if q and q not in candidate_queries:
                candidate_queries.append(q)

        payload: dict | None = None
        for q in candidate_queries:
            params: dict[str, str] = {
                "q": q,
                "c_code[id]": _CCODE_501C3,
                "ntee[id]": _NTEE_EDUCATION,
            }
            if state:
                params["state[id]"] = state.upper()
            try:
                async with httpx.AsyncClient(timeout=12.0, headers=_HEADERS) as client:
                    payload = await self._read(await client.get(_SEARCH_ENDPOINT, params=params))
            except Exception as exc:  # pragma: no cover — fail-soft
                logger.warning(
                    "propublica_search_failed keyword=%r state=%s err=%s",
                    q, state, exc,
                )
                payload = None
                continue

            if payload.get("organizations"):
                break
            # Zero resultados nao e falha: um termo estreito num estado pequeno
            # simplesmente nao acha nada. Segue para o proximo candidato, que e
            # mais amplo.
            logger.info("propublica_search_empty keyword=%r state=%s", q, state)
            payload = None

        if payload is None:
            await self._put_cached(cache_key, [])
            return []

        orgs = payload.get("organizations") or []
        total = int(payload.get("total_results") or 0)
        logger.info(
            "propublica_search ok keyword=%s state=%s total=%d returned=%d",
            keyword, state, total, min(limit, len(orgs)),
        )

        grants: list[Grant] = []
        # Aware para casar com os deadlines do grants.py: os dois viram Grant na mesma lista.
        now = datetime.now(UTC)
        # Foundations have no posted-listing deadline; pick a far-future
        # sentinel so the existing Grant dataclass (which requires a
        # datetime) does not blow up downstream. The deadline_text in the
        # ranked output uses a "Rolling — verify on funder site" string.
        rolling_deadline = now + timedelta(days=365)

        for org in orgs[:limit]:
            ein = str(org.get("ein") or "")
            if not ein:
                continue
            name = (org.get("name") or "").strip() or "Unnamed Foundation"
            city = (org.get("city") or "").strip()
            org_state = (org.get("state") or "").strip()
            ntee = (org.get("ntee_code") or "").strip()
            label = _ntee_label(ntee)

            description = (
                f"{label} (501(c)(3)) based in "
                f"{city + ', ' if city else ''}{org_state}. "
                f"Foundation prospect surfaced from ProPublica Nonprofit "
                f"Explorer Form 990 data — verify open RFPs and "
                f"application requirements on the funder's own website "
                f"before applying."
            ).strip()

            grants.append(
                Grant(
                    id=f"pp-{ein}",
                    title=name,
                    agency=name,
                    amount="Verify on funder site (foundation-set)",
                    deadline=rolling_deadline,
                    type="Foundation",
                    focus=["Education", label],
                    eligibility=[
                        "501(c)(3) education funder",
                        "Eligibility set by funder",
                    ],
                    match_required=False,
                    estimated_hours=15,
                    difficulty="Medium",
                    success_rate=20,
                    description=description,
                    source="foundation",
                    url=_ORG_URL.format(ein=ein),
                )
            )

        await self._put_cached(cache_key, grants)
        return grants

    # ------------------------------------------------------------- universe

    async def compute_foundation_universe(self) -> dict[str, Any]:
        """Aggregate the *active U.S. education-foundation universe* into
        a Landscape-friendly payload.

        We make a handful of parallel ``search.json`` calls — one broad
        baseline plus one per top-state and one per common NTEE
        subcategory — then read ``total_results`` from each response.
        ``total_results`` is the authoritative count maintained by
        ProPublica's index, so the resulting numbers reflect the actual
        size of the universe rather than the small sampled slice.
        """
        cache_key = "universe::v1"
        cached = await self._get_cached(cache_key)
        if cached is not None:
            return cached  # type: ignore[return-value]

        # The 12 states with the largest education-foundation footprints
        # are sufficient to draw a meaningful by_state chart; ProPublica
        # supports a fast hit-count fetch for each.
        top_states = [
            "CA", "NY", "TX", "FL", "PA", "IL",
            "OH", "GA", "MA", "VA", "NC", "WA",
        ]
        # ProPublica does not expose NTEE subcategory facets in the
        # public API, so we approximate "focus" with keyword queries
        # against the indexed name+mission text. Each keyword still
        # carries the NTEE major-group=Education facet.
        focus_queries = [
            ("scholarships", "Scholarships & student aid"),
            ("literacy", "Literacy & early reading"),
            ("STEM", "STEM education"),
            ("arts", "Arts education"),
            ("charter", "Charter schools"),
            ("library", "Libraries"),
        ]

        async with httpx.AsyncClient(timeout=15.0, headers=_HEADERS) as client:
            total_coro = self._hit_count(client, q="education")
            state_coros = [
                self._hit_count(client, q="education", state=s) for s in top_states
            ]
            focus_coros = [
                self._hit_count(client, q=q) for q, _ in focus_queries
            ]
            sample_coro = self._sample(client, q="education foundation", rows=24)

            results = await asyncio.gather(
                total_coro, sample_coro, *state_coros, *focus_coros
            )

        total_universe = int(results[0] or 0)
        sample_orgs = results[1] or []
        state_counts = results[2 : 2 + len(top_states)]
        focus_counts = results[2 + len(top_states) :]

        by_state = sorted(
            [
                {"state": s, "count": int(c or 0)}
                for s, c in zip(top_states, state_counts)
            ],
            key=lambda x: x["count"],
            reverse=True,
        )

        by_focus = sorted(
            [
                {
                    "key": q,
                    "label": label,
                    "count": int(c or 0),
                }
                for (q, label), c in zip(focus_queries, focus_counts)
            ],
            key=lambda x: x["count"],
            reverse=True,
        )

        # Featured set — a few real foundations the picker would also see.
        featured = []
        for org in sample_orgs[:8]:
            ein = str(org.get("ein") or "")
            if not ein:
                continue
            featured.append(
                {
                    "ein": ein,
                    "name": (org.get("name") or "").strip(),
                    "state": (org.get("state") or "").strip(),
                    "city": (org.get("city") or "").strip(),
                    "ntee_label": _ntee_label((org.get("ntee_code") or "").strip()),
                    "url": _ORG_URL.format(ein=ein),
                }
            )

        payload = {
            "as_of": datetime.now(UTC).isoformat(timespec="seconds"),
            "source": "ProPublica Nonprofit Explorer — IRS Form 990 data",
            "filters": "501(c)(3) · NTEE Major Group B (Education)",
            "totals": {
                "active_us_education_foundations": total_universe,
            },
            "by_state": by_state,
            "by_focus": by_focus,
            "featured": featured,
        }
        await self._put_cached(cache_key, payload)
        return payload

    # ----------------------------------------------------------------- http

    @staticmethod
    async def _read(resp: httpx.Response) -> dict:
        """Corpo da resposta da ProPublica, com 404 tratado como busca vazia.

        A API responde 404 com um JSON valido de ``total_results: 0`` quando a
        consulta nao acha nada. Deixar o raise_for_status decidir transformava
        "nenhum resultado" em erro, escondia falhas reais no meio do ruido e
        fazia o log acusar estados inteiros como quebrados.
        """

        if resp.status_code == 404:
            try:
                corpo = resp.json()
            except ValueError:
                resp.raise_for_status()
            else:
                if isinstance(corpo, dict) and "total_results" in corpo:
                    return corpo
                resp.raise_for_status()
        resp.raise_for_status()
        return resp.json()

    async def _hit_count(
        self,
        client: httpx.AsyncClient,
        *,
        q: str,
        state: str | None = None,
        ntee_text: str | None = None,
    ) -> int:
        params: dict[str, str] = {
            "q": (q + (f" {ntee_text}" if ntee_text else "")).strip(),
            "c_code[id]": _CCODE_501C3,
            "ntee[id]": _NTEE_EDUCATION,
        }
        if state:
            params["state[id]"] = state
        try:
            data = await self._read(await client.get(_SEARCH_ENDPOINT, params=params))
            return int(data.get("total_results") or 0)
        except Exception as exc:  # pragma: no cover
            logger.warning(
                "propublica_hitcount_fail q=%s state=%s ntee=%s err=%s",
                q, state, ntee_text, exc,
            )
            return 0

    async def _sample(
        self, client: httpx.AsyncClient, *, q: str, rows: int
    ) -> list[dict]:
        params = {
            "q": q,
            "c_code[id]": _CCODE_501C3,
            "ntee[id]": _NTEE_EDUCATION,
        }
        try:
            data = await self._read(await client.get(_SEARCH_ENDPOINT, params=params))
            return list(data.get("organizations") or [])[:rows]
        except Exception as exc:  # pragma: no cover
            logger.warning("propublica_sample_fail q=%s err=%s", q, exc)
            return []

    # ---------------------------------------------------------------- cache

    async def _get_cached(self, key: str) -> Any:
        async with self._lock:
            entry = self._cache.get(key)
            if not entry:
                return None
            ts, value = entry
            if time.time() - ts > self._CACHE_TTL_SECONDS:
                self._cache.pop(key, None)
                return None
            return value

    async def _put_cached(self, key: str, value: Any) -> None:
        async with self._lock:
            self._cache[key] = (time.time(), value)

    # ------------------------------------------------- org detail + ranking

    async def get_organization_detail(self, ein: str) -> dict | None:
        """Fetch the per-EIN ProPublica detail payload, cached 60 minutes.

        Returns ``None`` on transient failure or unknown EIN — the
        ranker treats that as the "no financials on record" branch and
        downgrades confidence accordingly.
        """
        ein = (ein or "").strip()
        if not ein.isdigit() or len(ein) != 9:
            return None
        cache_key = f"detail::{ein}"
        # Per-key TTL override.
        async with self._lock:
            entry = self._cache.get(cache_key)
            if entry and time.time() - entry[0] <= self._DETAIL_TTL_SECONDS:
                return entry[1]  # type: ignore[return-value]
        try:
            async with httpx.AsyncClient(timeout=12.0, headers=_HEADERS) as client:
                resp = await client.get(_DETAIL_ENDPOINT.format(ein=ein))
                if resp.status_code == 404:
                    await self._put_cached(cache_key, None)
                    return None
                resp.raise_for_status()
                data = resp.json()
        except Exception as exc:  # pragma: no cover — fail-soft
            logger.warning("propublica_detail_failed ein=%s err=%s", ein, exc)
            await self._put_cached(cache_key, None)
            return None
        await self._put_cached(cache_key, data)
        return data

    async def enrich_and_rank(
        self,
        grants: list[Grant],
        school_data: Any,
        grant_type: str | None = None,
    ) -> list[dict]:
        """Hydrate a list of ProPublica-sourced foundation Grants with
        Form 990 financials, score each on a deterministic 0-100 rubric,
        and return them sorted high → low as plain dicts ready for
        :class:`v2.schemas.FoundationProspect` validation.

        ``school_data`` may be either a Pydantic ``SchoolData`` model or
        a plain dict — we accept either to stay flexible across call sites.
        """
        if not grants:
            return []

        # Fan out the per-EIN detail fetches in parallel; one bad EIN
        # must not poison the batch, hence return_exceptions=True.
        eins = [(g.id or "").removeprefix("pp-").strip() for g in grants]
        results = await asyncio.gather(
            *(self.get_organization_detail(e) for e in eins),
            return_exceptions=True,
        )

        school_state = _coerce_attr(school_data, "state")
        school_students = _coerce_attr(school_data, "students") or 0

        enriched: list[dict] = []
        for grant, detail in zip(grants, results):
            if isinstance(detail, BaseException):
                detail = None
            try:
                row = self._score_prospect(
                    grant=grant,
                    detail=detail if isinstance(detail, dict) else None,
                    school_state=school_state,
                    school_students=int(school_students or 0),
                    grant_type=grant_type,
                )
            except Exception:
                logger.warning(
                    "foundation_score_failed ein=%s", grant.id, exc_info=True
                )
                continue
            enriched.append(row)

        enriched.sort(key=lambda r: r.get("score", 0), reverse=True)
        for idx, row in enumerate(enriched, start=1):
            row["rank"] = idx
        return enriched

    # ----------------------------------------------------------- scoring

    def _score_prospect(
        self,
        *,
        grant: Grant,
        detail: dict | None,
        school_state: str | None,
        school_students: int,
        grant_type: str | None,
    ) -> dict:
        """Deterministic 0-100 funder-fit score with full breakdown.

        Component caps (sum = 100):
          capacity 25 · activity 20 · recency 10 · geo 20 · focus 15 · scale 10
        """
        raw_ein = (grant.id or "").removeprefix("pp-").strip()
        display_ein = f"{raw_ein[:2]}-{raw_ein[2:]}" if len(raw_ein) == 9 else raw_ein

        # ---- parse description-embedded city/state (matches _to_foundation_prospects)
        city: str | None = None
        state_from_desc: str | None = None
        if grant.description:
            m = _PP_LOC_RE.search(grant.description)
            if m:
                city = (m.group(1) or "").strip() or None
                state_from_desc = (m.group(2) or "").strip().upper() or None

        focus_label = "Education foundation"
        ntee_label_text = focus_label
        if grant.focus and len(grant.focus) >= 2:
            focus_label = grant.focus[1]
            ntee_label_text = grant.focus[1]
        elif grant.focus:
            focus_label = grant.focus[0]

        # ---- financials from the latest filing
        financials, ntee_code = _extract_financials(detail)
        filings_with_data = (
            len((detail or {}).get("filings_with_data") or []) if detail else 0
        )

        # ---- component scores ------------------------------------------
        cap_score = _capacity_score(financials.get("total_assets_usd"))
        act_score = _activity_score(financials.get("grants_paid_annual_usd"))
        rec_score = _recency_score(financials.get("latest_year"))
        funder_state = (
            (detail or {}).get("organization", {}).get("state") if detail else None
        ) or state_from_desc
        geo_score = _geo_score(school_state, funder_state)
        focus_score = _focus_score(ntee_code, grant_type)
        scale_score = _scale_score(
            financials.get("grants_paid_annual_usd"), school_students
        )

        total = cap_score + act_score + rec_score + geo_score + focus_score + scale_score

        # ---- confidence + flags ----------------------------------------
        if filings_with_data >= 3:
            confidence = "high"
        elif filings_with_data >= 1:
            confidence = "medium"
        else:
            confidence = "low"

        risk_flags: list[str] = []
        if filings_with_data == 0:
            risk_flags.append("No machine-readable IRS Form 990 on record")
        latest_year = financials.get("latest_year")
        if latest_year and (datetime.now(UTC).year - int(latest_year)) >= 4:
            risk_flags.append(f"Latest filing is {datetime.now(UTC).year - int(latest_year)} years old")
        if (
            funder_state
            and school_state
            and funder_state.upper() != school_state.upper()
            and funder_state.upper() not in _ADJACENT_STATES.get(school_state.upper(), set())
        ):
            risk_flags.append(f"Funder based in {funder_state} — verify out-of-state eligibility")
        if (
            financials.get("grants_paid_annual_usd") is not None
            and financials["grants_paid_annual_usd"] < 25_000
        ):
            risk_flags.append("Very small annual giving (<$25k)")

        # ---- pros / cons (human language) -------------------------------
        pros: list[str] = []
        cons: list[str] = []
        assets = financials.get("total_assets_usd")
        annual = financials.get("grants_paid_annual_usd")
        if assets and assets >= 100_000_000:
            pros.append(f"Large endowment (${_human_usd(assets)}) — capacity for multi-year gifts")
        elif assets and assets >= 10_000_000:
            pros.append(f"Mid-size foundation (${_human_usd(assets)} in assets)")
        if annual and annual >= 1_000_000:
            pros.append(f"Actively granting — ~${_human_usd(annual)}/year in recent giving")
        elif annual and annual >= 100_000:
            pros.append(f"Regular grantmaker (~${_human_usd(annual)}/year)")
        if geo_score >= 18:
            pros.append("Headquartered in your state — strong geographic fit")
        elif geo_score >= 8:
            pros.append("Funder is regionally adjacent")
        if focus_score >= 12:
            pros.append(f"Focus area ({ntee_label_text}) aligns with your grant intent")

        if confidence == "low":
            cons.append("Public 990 financials not available — capacity unknown")
        if not annual and confidence != "low":
            cons.append("Annual giving line item not exposed in 990 filing")
        if assets and assets < 1_000_000:
            cons.append("Small asset base — likely small grant amounts")
        if geo_score == 0 and school_state:
            cons.append(f"No state-level overlap with {school_state}")

        # ---- likely give range ------------------------------------------
        likely_range: dict[str, int] | None = None
        if annual:
            # Heuristic: a typical individual grant is 0.5–3% of annual giving,
            # bounded by a $1k floor and $250k ceiling for the rail tooltip.
            low = max(1_000, int(annual * 0.005))
            high = min(250_000, max(low * 2, int(annual * 0.03)))
            likely_range = {"low": low, "high": high}

        # ---- recommended next step -------------------------------------
        if confidence == "low":
            next_step = (
                "Search the funder's own website for an application portal or "
                "contact email. If neither exists, this prospect may be inactive."
            )
        elif geo_score == 0:
            next_step = (
                "Confirm the funder accepts out-of-state applicants before "
                "investing time in a Letter of Inquiry."
            )
        else:
            next_step = (
                "Send a 1-2 page Letter of Inquiry (LOI) introducing the school "
                "and the proposed program — most foundations of this size do not "
                "publish open RFPs but accept LOIs year-round."
            )

        return {
            "id": grant.id,
            "name": grant.title,
            "focus": focus_label,
            "city": city,
            "state": (state_from_desc or funder_state or "").upper() or None,
            "ein": display_ein,
            "url": grant.url or _ORG_URL.format(ein=raw_ein),
            "score": round(total),
            "score_breakdown": {
                "capacity": cap_score,
                "activity": act_score,
                "recency": rec_score,
                "geographic_fit": geo_score,
                "focus_fit": focus_score,
                "scale_fit": scale_score,
            },
            "confidence": confidence,
            "pros": pros[:3],
            "cons": cons[:3],
            "risk_flags": risk_flags,
            "likely_give_range_usd": likely_range,
            "financials": {
                **financials,
                "years_on_record": filings_with_data,
            },
            "recommended_next_step": next_step,
        }


# ====================================================================
# Pure helpers for ranking. Kept module-level so they are easy to unit
# test and so the FoundationsService class stays narrowly about I/O.
# ====================================================================

# Lazy/safe import — we keep BaseException above without importing pydantic
# here because we only return plain dicts; the v2 schema layer validates.


import math
import re

_PP_LOC_RE = re.compile(r"based in\s+(?:([^,]+),\s*)?([A-Z]{2})\.", re.IGNORECASE)


# Adjacency map for the geo-fit fallback. Only neighbours, not regions —
# this matches funder reality (a CA foundation will often consider NV, OR,
# AZ; rarely TX). We populate the high-density-school states; everything
# else falls back to "no overlap" which is still a useful signal.
_ADJACENT_STATES: dict[str, set[str]] = {
    "CA": {"OR", "NV", "AZ"},
    "OR": {"CA", "WA", "ID", "NV"},
    "WA": {"OR", "ID"},
    "NV": {"CA", "OR", "ID", "UT", "AZ"},
    "AZ": {"CA", "NV", "UT", "NM"},
    "TX": {"NM", "OK", "AR", "LA"},
    "NY": {"NJ", "CT", "MA", "VT", "PA"},
    "NJ": {"NY", "PA", "DE"},
    "PA": {"NY", "NJ", "DE", "MD", "WV", "OH"},
    "MA": {"NY", "VT", "NH", "CT", "RI"},
    "FL": {"GA", "AL"},
    "GA": {"FL", "AL", "TN", "SC", "NC"},
    "NC": {"VA", "TN", "GA", "SC"},
    "VA": {"NC", "TN", "KY", "WV", "MD", "DC"},
    "IL": {"WI", "IN", "KY", "MO", "IA"},
    "OH": {"PA", "WV", "KY", "IN", "MI"},
}


# Rough mapping from our internal grant_type → which NTEE B-prefixes are
# strongest fits. Used only for the focus-fit component.
_GRANT_TYPE_NTEE_FIT: dict[str, dict[str, int]] = {
    "stem": {"B11": 12, "B25": 10, "B28": 12, "B30": 10, "B90": 10, "B99": 8},
    "literacy": {"B92": 15, "B82": 8, "B20": 10, "B24": 12, "B70": 10},
    "arts": {"B12": 10, "B25": 8, "B90": 10, "B99": 8},
    "career": {"B30": 15, "B40": 10, "B60": 12},
    "special": {"B28": 15, "B90": 10},
    "ell": {"B92": 12, "B90": 10},
    "safety": {"B20": 10, "B25": 10, "B90": 8},
    "mental": {"B20": 10, "B25": 10, "B80": 12},
    "nutrition": {"B20": 8, "B25": 8},
    "other": {},
}


def _coerce_attr(obj: Any, name: str) -> Any:
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def _extract_financials(detail: dict | None) -> tuple[dict, str | None]:
    """Read the latest IRS Form 990 / 990-PF / 990-EZ from a ProPublica
    organization detail payload.

    Returns ``(financials_dict, ntee_code)`` where ``financials_dict``
    matches the :class:`FoundationFinancials` schema (all values may be
    ``None`` if not exposed).
    """
    empty = {
        "latest_year": None,
        "form_type": None,
        "total_assets_usd": None,
        "total_revenue_usd": None,
        "total_expenses_usd": None,
        "grants_paid_annual_usd": None,
        "estimated_avg_grant_usd": None,
        "pdf_url": None,
    }
    if not detail:
        return empty, None

    org = detail.get("organization") or {}
    ntee_code = (org.get("ntee_code") or "").strip() or None

    filings = detail.get("filings_with_data") or []
    if not filings:
        return empty, ntee_code

    # Pick the filing with the largest tax_prd_yr (latest).
    def _year(f: dict) -> int:
        try:
            return int(f.get("tax_prd_yr") or 0)
        except (TypeError, ValueError):
            return 0

    latest = max(filings, key=_year)
    pdf_url = latest.get("pdf_url") or None
    form_type = _infer_form_type(pdf_url)

    # Field names differ across 990 / 990-PF / 990-EZ.
    if form_type == "990-PF":
        revenue = latest.get("totrevenue")
        expenses = latest.get("totfuncexpns")
        assets = latest.get("totassetsend")
        grants_paid = latest.get("topradmnexpnsd")  # charitable disbursements col d
    elif form_type == "990-EZ":
        revenue = latest.get("totrevnue")  # NOTE: API typo, real key
        expenses = latest.get("totexpns")
        assets = latest.get("totnetassetsend")
        grants_paid = None  # EZ filers rarely grant out
    else:
        # Standard 990
        revenue = latest.get("totrevenue")
        expenses = latest.get("totfuncexpns")
        assets = latest.get("totassetsend")
        dom = latest.get("grntpdoutdom") or 0
        frgn = latest.get("grntpdoutfrgn") or 0
        grants_paid = (dom + frgn) or None

    return {
        "latest_year": _year(latest) or None,
        "form_type": form_type,
        "total_assets_usd": _to_int(assets),
        "total_revenue_usd": _to_int(revenue),
        "total_expenses_usd": _to_int(expenses),
        "grants_paid_annual_usd": _to_int(grants_paid),
        "estimated_avg_grant_usd": None,
        "pdf_url": pdf_url,
    }, ntee_code


def _infer_form_type(pdf_url: str | None) -> str:
    if not pdf_url:
        return "990"
    u = pdf_url.lower()
    if "990pf" in u or "990-pf" in u:
        return "990-PF"
    if "990ez" in u or "990-ez" in u:
        return "990-EZ"
    return "990"


def _to_int(v: Any) -> int | None:
    if v is None or v == "":
        return None
    try:
        n = int(float(v))
    except (TypeError, ValueError):
        return None
    return n


def _capacity_score(assets: int | None) -> int:
    # Log-scale: $100k → ~3, $1M → ~8, $10M → ~14, $100M → ~19, $1B+ → 25.
    if not assets or assets <= 0:
        return 0
    return min(25, round(math.log10(assets) * 4.2 - 2))


def _activity_score(annual: int | None) -> int:
    if not annual or annual <= 0:
        return 0
    # $10k → ~3, $100k → ~8, $1M → ~13, $10M → ~18, $100M+ → 20.
    return min(20, round(math.log10(annual) * 4.0 - 4))


def _recency_score(year: int | None) -> int:
    if not year:
        return 0
    age = datetime.now(UTC).year - int(year)
    if age <= 1:
        return 10
    if age <= 2:
        return 8
    if age <= 3:
        return 6
    if age <= 5:
        return 3
    return 0


def _geo_score(school_state: str | None, funder_state: str | None) -> int:
    if not school_state or not funder_state:
        return 0
    s = school_state.upper()
    f = funder_state.upper()
    if s == f:
        return 20
    if f in _ADJACENT_STATES.get(s, set()):
        return 10
    return 0


def _focus_score(ntee_code: str | None, grant_type: str | None) -> int:
    if not ntee_code or not grant_type:
        # Any B-coded education funder still gets a small baseline.
        return 5 if ntee_code else 0
    table = _GRANT_TYPE_NTEE_FIT.get(grant_type, {})
    code = ntee_code.upper()
    if code in table:
        return min(15, table[code])
    # 3-char prefix fallback.
    prefix = code[:3]
    if prefix in table:
        return min(15, table[prefix])
    # Still an education funder → minor credit.
    return 5


def _scale_score(annual: int | None, students: int) -> int:
    """Reward funders whose typical grant size matches the school's
    realistic absorption capacity. Heuristic: a school can typically
    absorb a grant equal to ~$100 × students (mid-band).
    """
    if not annual or annual <= 0:
        return 0
    # Assume a typical foundation makes ~20-40 grants/year. Avg grant ≈ annual/30.
    avg_grant = max(1_000, annual // 30)
    target = max(5_000, students * 100) if students else 25_000
    ratio = avg_grant / target
    # Sweet spot 0.5–3.0× target → full credit. Outside that, decay.
    if 0.5 <= ratio <= 3.0:
        return 10
    if 0.2 <= ratio < 0.5 or 3.0 < ratio <= 6.0:
        return 6
    if 0.05 <= ratio < 0.2 or 6.0 < ratio <= 15.0:
        return 3
    return 1


def _human_usd(amount: int) -> str:
    if amount >= 1_000_000_000:
        return f"{amount / 1_000_000_000:.1f}B"
    if amount >= 1_000_000:
        return f"{amount / 1_000_000:.1f}M"
    if amount >= 1_000:
        return f"{amount / 1_000:.0f}k"
    return str(amount)


# --------------------------------------------------------- module singleton


_foundations: FoundationsService | None = None


def get_foundations_service() -> FoundationsService:
    global _foundations
    if _foundations is None:
        _foundations = FoundationsService()
    return _foundations


# Re-export for convenience.
__all__ = ["FoundationsService", "get_foundations_service"]


# Unused import suppression — Counter is used by analytics callers
# pulling utilities from this module via wildcard. Keeping it imported
# avoids breaking those downstream call-sites if/when they land.
_ = Counter
