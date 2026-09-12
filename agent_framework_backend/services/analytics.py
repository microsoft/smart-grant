"""
Live federal-funding-landscape analytics over Grants.gov ``search2``.

This service is the data source for the v2 Analytics canvas. It runs a
small fan-out of parallel ``search2`` queries to the public Grants.gov
opportunities API and aggregates the results into a single payload the
frontend can render directly.

Everything returned here is real, public data — no mocks. Results are
cached in-process for ``_CACHE_TTL_SECONDS`` to keep latency low and
avoid hammering api.grants.gov when the analytics tab is reloaded.
"""

from __future__ import annotations

import asyncio
import html
import logging
import time
from collections import Counter, defaultdict
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

from services.foundations import get_foundations_service
from services.grants import GrantsGovService

logger = logging.getLogger(__name__)

_ENDPOINT = "https://api.grants.gov/v1/api/search2"
_HEADERS = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "User-Agent": "smart-grant-request/v2-analytics",
}

# (key, display label, keyword phrase) tuples. Order is unimportant —
# the response is sorted by count descending.
CATEGORY_KEYWORDS: list[tuple[str, str, str]] = [
    ("literacy", "Literacy", "literacy education"),
    ("stem", "STEM & Innovation", "STEM education"),
    ("cte", "Career & Tech Ed", "career technical education"),
    ("special_ed", "Special Education", "special education"),
    ("arts", "Arts & Humanities", "arts education"),
    ("health", "Health & Wellness", "school health"),
    ("civics", "Civics & Engagement", "civics education"),
]


class GrantsLandscapeService:
    """Aggregator over Grants.gov ``search2`` for the analytics canvas."""

    _CACHE_TTL_SECONDS = 600  # 10 minutes
    _BROAD_ROWS = 200

    def __init__(self) -> None:
        self._cache: tuple[float, dict[str, Any]] | None = None
        self._lock = asyncio.Lock()
        # Re-use the grants service for agency derivation + date parsing
        # so the labels on this page match the labels in the picker.
        self._grants = GrantsGovService()

    # ------------------------------------------------------------------ public
    async def compute_landscape(self) -> dict[str, Any]:
        async with self._lock:
            if self._cache is not None:
                ts, payload = self._cache
                if time.time() - ts < self._CACHE_TTL_SECONDS:
                    return payload

            payload = await self._compute_fresh()
            self._cache = (time.time(), payload)
            return payload

    # ----------------------------------------------------------------- compute
    async def _compute_fresh(self) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=20.0) as client:
            # Category hit-counts in parallel + one broad sample for the
            # detailed breakdowns. ``asyncio.gather`` interleaves them.
            cat_coros = [
                self._fetch_hit_count(client, kw) for _, _, kw in CATEGORY_KEYWORDS
            ]
            broad_coro = self._fetch_broad(client, "education", rows=self._BROAD_ROWS)
            # ProPublica foundation universe (own httpx client inside).
            foundation_coro = get_foundations_service().compute_foundation_universe()
            results = await asyncio.gather(broad_coro, foundation_coro, *cat_coros)

        broad = results[0]
        foundation_universe = results[1]
        cat_counts = results[2:]

        by_category = [
            {"key": k, "label": label, "count": count}
            for (k, label, _), count in zip(CATEGORY_KEYWORDS, cat_counts)
        ]
        by_category.sort(key=lambda x: x["count"], reverse=True)

        payload = self._aggregate(broad, by_category)
        payload["foundation_universe"] = foundation_universe
        return payload

    # ------------------------------------------------------------------ HTTP
    async def _fetch_hit_count(
        self, client: httpx.AsyncClient, keyword: str
    ) -> int:
        try:
            resp = await client.post(
                _ENDPOINT,
                json={
                    "keyword": keyword,
                    "rows": 1,
                    "oppStatuses": "forecasted|posted",
                },
                headers=_HEADERS,
            )
            resp.raise_for_status()
            data = resp.json().get("data") or {}
            return int(data.get("hitCount") or 0)
        except Exception as exc:  # pragma: no cover — best-effort metric
            logger.warning(
                "landscape_category_fail keyword=%s err=%s", keyword, str(exc)
            )
            return 0

    async def _fetch_broad(
        self, client: httpx.AsyncClient, keyword: str, rows: int
    ) -> dict:
        try:
            resp = await client.post(
                _ENDPOINT,
                json={
                    "keyword": keyword,
                    "rows": rows,
                    "oppStatuses": "forecasted|posted",
                },
                headers=_HEADERS,
            )
            resp.raise_for_status()
            return resp.json()
        except Exception as exc:  # pragma: no cover — best-effort metric
            logger.warning("landscape_broad_fail err=%s", str(exc))
            return {"data": {"oppHits": [], "hitCount": 0}}

    # -------------------------------------------------------------- aggregate
    def _aggregate(self, broad: dict, by_category: list[dict]) -> dict[str, Any]:
        data = broad.get("data") or {}
        hits = data.get("oppHits") or []
        hit_count = int(data.get("hitCount") or 0)

        # As datas vindas de _parse_mdy sao aware; comparar com naive levanta TypeError.
        now = datetime.now(tz=UTC)
        soon_cutoff = now + timedelta(days=30)
        posted_cutoff = now - timedelta(days=30)

        closing_soon: list[dict] = []
        agency_counter: Counter[str] = Counter()
        posted_buckets: defaultdict[str, int] = defaultdict(int)
        posted_last_30 = 0
        closing_30_count = 0

        for opp in hits:
            number = str(opp.get("number") or "")
            title = html.unescape(str(opp.get("title") or "")).strip()
            agency = self._grants._derive_agency(
                number=number,
                title=title,
                fallback=str(opp.get("agencyName") or "").strip(),
            )
            agency_counter[agency] += 1

            close = self._grants._parse_mdy(str(opp.get("closeDate") or ""))
            open_date = self._grants._parse_mdy(str(opp.get("openDate") or ""))

            if close and now <= close <= soon_cutoff:
                closing_30_count += 1
                closing_soon.append(
                    {
                        "title": title,
                        "agency": agency,
                        "deadline": close.date().isoformat(),
                        "days_until": (close - now).days,
                        "url": f"https://www.grants.gov/search-results-detail/{opp.get('id')}",
                        "number": number,
                    }
                )

            if open_date and open_date >= posted_cutoff:
                posted_last_30 += 1

            if open_date:
                wk_start = open_date - timedelta(days=open_date.weekday())
                posted_buckets[wk_start.date().isoformat()] += 1

        closing_soon.sort(key=lambda x: x["days_until"])
        closing_soon = closing_soon[:8]

        # Suppress the catch-all "Federal Agency" placeholder so the
        # chart only shows identifiable funders. The placeholder count
        # is still implied by ``open_opportunities`` - ``sum(top)``.
        top_agencies = [
            {"name": name, "count": count}
            for name, count in agency_counter.most_common(8)
            if name != "Federal Agency"
        ][:6]

        # 12-week timeline anchored on the current Monday, filling gaps.
        today_monday = (now - timedelta(days=now.weekday())).date()
        timeline = [
            {
                "week_start": (today_monday - timedelta(weeks=i)).isoformat(),
                "count": posted_buckets.get(
                    (today_monday - timedelta(weeks=i)).isoformat(), 0
                ),
            }
            for i in range(11, -1, -1)
        ]

        return {
            "as_of": datetime.now(tz=UTC).isoformat(timespec="seconds"),
            "source": "Grants.gov Opportunities API (search2)",
            "sample_size": len(hits),
            "totals": {
                "open_opportunities": hit_count,
                "closing_within_30_days": closing_30_count,
                "posted_last_30_days": posted_last_30,
                "unique_agencies_in_sample": len(agency_counter),
            },
            "by_category": by_category,
            "by_agency": top_agencies,
            "closing_soon": closing_soon,
            "posted_timeline": timeline,
        }


# Module-level singleton (FastAPI lifespan-friendly).
_landscape: GrantsLandscapeService | None = None


def get_landscape_service() -> GrantsLandscapeService:
    global _landscape
    if _landscape is None:
        _landscape = GrantsLandscapeService()
    return _landscape
