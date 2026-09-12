"""
============================================================================
Grant Services - Grants.gov Integration
Python implementation matching your TypeScript grants-gov.ts service
============================================================================
"""

import asyncio
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import ClassVar
from urllib.parse import quote

import httpx
import structlog

from config import get_settings

logger = structlog.get_logger()


@dataclass
class Grant:
    """Normalized grant structure matching your TypeScript Grant interface."""
    id: str
    title: str
    agency: str
    amount: str
    deadline: datetime
    type: str  # 'Federal' | 'State' | 'Foundation' | 'Private'
    focus: list[str]
    eligibility: list[str]
    match_required: bool
    estimated_hours: int
    difficulty: str  # 'Easy' | 'Medium' | 'Hard'
    success_rate: int
    description: str
    source: str  # 'grants.gov' | 'ed.gov' | 'k12grants' | 'state-portal'
    url: str | None = None

    # Publicados no aviso do edital. None significa "o orgao nao publicou",
    # e nunca deve virar numero estimado: alimentam o ranking e a analise.
    award_ceiling_usd: int | None = None
    award_floor_usd: int | None = None
    estimated_funding_usd: int | None = None
    expected_awards: int | None = None
    eligibility_text: str | None = None


@dataclass
class GrantsGovGrant:
    """Raw grant data from Grants.gov API."""
    id: str
    opportunity_number: str
    title: str
    agency_code: str
    agency_name: str
    category: str
    posted_date: str
    close_date: str | None = None
    award_ceiling: int | None = None
    award_floor: int | None = None
    estimated_funding: int | None = None
    description: str | None = None
    eligibility: str | None = None


@dataclass
class CacheEntry:
    """Cache entry for grant search results."""
    data: list[Grant]
    timestamp: datetime
    total: int


class GrantsGovService:
    """
    Grants.gov API Service using GSA Search.gov
    Python implementation of your TypeScript grants-gov.ts
    """

    # Codigo de elegibilidade do Grants.gov para "Independent school
    # districts". E o unico tipo de requerente que descreve as escolas deste
    # produto: o indice e o CCD do NCES, que cobre escolas publicas.
    #
    # Sem este filtro a busca devolvia sobretudo editais de universidade. Numa
    # execucao real (Lincoln High School, STEM) vieram 26 candidatos e o
    # ranqueador desqualificou 25 -- 12 por "higher ed only", 7 por
    # "eligibility not school-based", alem de SBIR e programas de pos-graduacao.
    # Todas as recusas estavam certas: o problema nunca foi o rubrica, era a
    # pergunta feita ao Grants.gov.
    #
    # Medido no proprio search2 para "stem": 153 resultados sem filtro, 43 com.
    # Incluir tambem o codigo 99 ("unrestricted") devolve os editais de
    # universidade a lista e foi descartado. Nenhuma das categorias do produto
    # fica sem resultados -- a menor, literacy, mantem 11.
    ELIGIBILITY_SCHOOL_DISTRICTS = "05"

    def __init__(self):
        self.settings = get_settings()
        self.search_url = "https://api.gsa.gov/technology/searchgov/v2/results/i14y"
        self.affiliate = self.settings.gsa_search_affiliate
        self.access_key = self.settings.gsa_search_api_key
        self._cache: dict[str, CacheEntry] = {}
        self._cache_ttl = timedelta(minutes=self.settings.grants_gov_cache_ttl_minutes)
    
    async def search_grants(
        self,
        keyword: str = "education",
        page_size: int = 25
    ) -> list[Grant]:
        """Search for federal grants — real funding opportunities only.

        Primary path: the official Grants.gov ``search2`` opportunities API.
        It returns *structured funding records* (opportunity number, title,
        post/close dates, agency code) and never returns marketing or help
        pages. This is what the rubric Discovery agent expects.

        Fallback: the legacy GSA Search.gov website index, which is
        keyword-flexible but indexes Grants.gov *pages* (department
        directories, "Grant Eligibility" help pages, etc.). The HITL
        rubric correctly disqualifies those, but they pollute the picker.
        """

        cache_key = f"{keyword}_{page_size}"
        if cache_key in self._cache:
            entry = self._cache[cache_key]
            if datetime.now(UTC) - entry.timestamp < self._cache_ttl:
                logger.info("grants_cache_hit", keyword=keyword, count=len(entry.data))
                return entry.data

        grants: list[Grant] = []
        try:
            grants = await self._search_opportunities_api(keyword, page_size)
            logger.info("grants_search_v1_complete", keyword=keyword, count=len(grants))
        except Exception as exc:
            logger.warning("grants_search_v1_failed", keyword=keyword, error=str(exc))

        if not grants:
            try:
                grants = await self._search_gsa_fallback(keyword, page_size)
                logger.info("grants_search_gsa_fallback", keyword=keyword, count=len(grants))
            except Exception as exc:
                logger.error("grants_search_all_failed", keyword=keyword, error=str(exc))
                raise

        if grants:
            self._cache[cache_key] = CacheEntry(
                data=grants,
                timestamp=datetime.now(UTC),
                total=len(grants),
            )

        return grants

    async def _search_opportunities_api(
        self,
        keyword: str,
        page_size: int,
    ) -> list[Grant]:
        """Call the official Grants.gov search2 API and parse opportunities.

        Endpoint: ``POST https://api.grants.gov/v1/api/search2``. No auth
        required. Returns ``{"data": {"oppHits": [...]}}`` where each hit
        is a real funding opportunity (never a help page).
        """

        endpoint = "https://api.grants.gov/v1/api/search2"
        # Restrict to currently-actionable opportunities so the picker
        # never shows closed or archived records, and to opportunities a
        # school district can actually apply for.
        payload = {
            "keyword": keyword,
            "rows": page_size,
            "oppStatuses": "forecasted|posted",
            "eligibilities": self.ELIGIBILITY_SCHOOL_DISTRICTS,
        }
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(
                endpoint,
                json=payload,
                headers={
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                    "User-Agent": "smart-grant-request/v2",
                },
            )
            response.raise_for_status()
            data = response.json()

        hits = (data.get("data") or {}).get("oppHits") or []
        grants: list[Grant] = []
        for opp in hits:
            grant = self._parse_v1_opportunity(opp)
            if grant is not None:
                grants.append(grant)
        await self._enrich_with_opportunity_details(grants)
        return grants

    # O search2 nao traz valores de premio; so o aviso completo traz. Sem isto
    # o ranking julgaria "award size fit" contra um numero inventado.
    _DETAIL_ENDPOINT: ClassVar[str] = "https://api.grants.gov/v1/api/fetchOpportunity"
    _DETAIL_CONCURRENCY: ClassVar[int] = 8

    async def _enrich_with_opportunity_details(self, grants: list[Grant]) -> None:
        """Preenche os valores reais de premio a partir do aviso de cada edital."""

        alvos = [g for g in grants if g.id.startswith("grants-gov-")]
        if not alvos:
            return

        limite = asyncio.Semaphore(self._DETAIL_CONCURRENCY)

        async with httpx.AsyncClient(timeout=15.0) as client:

            async def carregar(grant: Grant) -> None:
                opp_id = grant.id.removeprefix("grants-gov-")
                async with limite:
                    try:
                        resp = await client.post(
                            self._DETAIL_ENDPOINT,
                            json={"opportunityId": int(opp_id)},
                            headers={
                                "Accept": "application/json",
                                "Content-Type": "application/json",
                                "User-Agent": "smart-grant-request/v2",
                            },
                        )
                        resp.raise_for_status()
                        synopsis = ((resp.json().get("data") or {}).get("synopsis")) or {}
                    except Exception as exc:
                        logger.warning(
                            "grants_detail_fetch_failed", opportunity_id=opp_id, error=str(exc)
                        )
                        return

                grant.award_ceiling_usd = self._parse_usd(synopsis.get("awardCeiling"))
                grant.award_floor_usd = self._parse_usd(synopsis.get("awardFloor"))
                grant.estimated_funding_usd = self._parse_usd(synopsis.get("estimatedFunding"))
                grant.expected_awards = self._parse_usd(synopsis.get("numberOfAwards"))
                elegibilidade = str(synopsis.get("applicantEligibilityDesc") or "").strip()
                grant.eligibility_text = self._clean_html(elegibilidade) or None
                grant.amount = self._format_amount(grant)

            await asyncio.gather(*(carregar(g) for g in alvos))

    @staticmethod
    def _parse_usd(raw: object) -> int | None:
        """O aviso usa 0 e a string 'none' para 'nao publicado'."""

        if raw is None:
            return None
        texto = str(raw).strip().lower()
        if not texto or texto == "none":
            return None
        try:
            valor = int(float(texto.replace(",", "").replace("$", "")))
        except ValueError:
            return None
        return valor or None

    @staticmethod
    def _format_amount(grant: Grant) -> str:
        piso, teto = grant.award_floor_usd, grant.award_ceiling_usd
        if piso and teto:
            return f"${piso:,} - ${teto:,}"
        if teto:
            return f"Up to ${teto:,}"
        if piso:
            return f"From ${piso:,}"
        if grant.estimated_funding_usd:
            return f"${grant.estimated_funding_usd:,} total program funding"
        return "Award amount not published"

    async def _search_gsa_fallback(
        self,
        keyword: str,
        page_size: int,
    ) -> list[Grant]:
        """Legacy GSA Search.gov path. Kept as a defensive fallback only;
        the rubric Discovery agent will disqualify the marketing/help
        pages this index returns.
        """

        if not self.access_key:
            logger.warning("grants_gsa_fallback_unconfigured", keyword=keyword)
            return []

        encoded_query = quote(keyword, safe="")
        search_url = (
            f"{self.search_url}"
            f"?affiliate={self.affiliate}"
            f"&query={encoded_query}"
            f"&access_key={self.access_key}"
            f"&limit={page_size}"
            f"&offset=0"
        )
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(
                search_url,
                headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    "Accept": "application/json",
                    "Accept-Language": "en-US,en;q=0.9",
                    "Referer": "https://www.grants.gov/",
                    "Cache-Control": "no-cache",
                },
            )
            response.raise_for_status()
            data = response.json()
        results = data.get("web", {}).get("results", [])
        grants: list[Grant] = []
        for result in results:
            grant = self._parse_grant_result(result)
            if grant is not None:
                grants.append(grant)
        return grants

    # ------------------------------------------------------------------
    # Grants.gov search2 parsing
    # ------------------------------------------------------------------

    # Map of OPPORTUNITY-NUMBER prefixes to a human-readable agency name.
    # Used because ``search2`` returns ``agencyName`` blank on most hits;
    # the number prefix is the most reliable signal we have.
    _AGENCY_PREFIX_MAP: ClassVar[dict[str, str]] = {
        "ED-": "U.S. Department of Education",
        "EDGRANTS": "U.S. Department of Education",
        "ED-GRANTS": "U.S. Department of Education",
        "OESE": "U.S. Department of Education",
        "DOL-": "U.S. Department of Labor",
        "ETA-": "U.S. Department of Labor",
        "OESE-": "U.S. Department of Education",
        "NSF": "National Science Foundation",
        "HHS": "U.S. Department of Health and Human Services",
        "HRSA": "Health Resources and Services Administration",
        "CDC": "Centers for Disease Control and Prevention",
        "USDA": "U.S. Department of Agriculture",
        "NIFA": "USDA National Institute of Food and Agriculture",
        "USDOJ": "U.S. Department of Justice",
        "OJJDP": "Office of Juvenile Justice and Delinquency Prevention",
        "BJA": "Bureau of Justice Assistance",
        "EPA": "U.S. Environmental Protection Agency",
        "NEH": "National Endowment for the Humanities",
        "NEA": "National Endowment for the Arts",
        "NASA": "National Aeronautics and Space Administration",
        "IMLS": "Institute of Museum and Library Services",
        "DOE-": "U.S. Department of Energy",
        "DOI-": "U.S. Department of the Interior",
        "DOT-": "U.S. Department of Transportation",
        "HUD-": "U.S. Department of Housing and Urban Development",
        "PA-": "U.S. Department of Health and Human Services",
    }

    def _parse_v1_opportunity(self, opp: dict) -> Grant | None:
        """Convert one Grants.gov ``search2`` hit into a normalised Grant."""

        try:
            opp_id = str(opp.get("id") or "").strip()
            number = str(opp.get("number") or "").strip()
            title = self._clean_html(str(opp.get("title") or "").strip())
            if not opp_id or not title:
                return None

            agency_name = self._derive_agency(
                number=number,
                title=title,
                # O search2 devolve `agencyName` nulo, mas `agency` traz o nome
                # completo em todos os hits observados; o mapa por prefixo do
                # numero e so a rede de seguranca.
                fallback=str(opp.get("agency") or opp.get("agencyName") or "").strip(),
            )

            close_date = self._parse_mdy(str(opp.get("closeDate") or "")) or (
                datetime.now(UTC) + timedelta(days=90)
            )

            url = f"https://www.grants.gov/search-results-detail/{opp_id}"

            return Grant(
                id=f"grants-gov-{opp_id}",
                title=title,
                agency=agency_name,
                # Preenchido por _enrich_with_opportunity_details a partir do aviso.
                amount="Award amount not published",
                deadline=close_date,
                type="Federal",
                focus=self._parse_categories(title, ""),
                eligibility=["Public K-12 Schools", "School Districts", "Educational Agencies"],
                match_required=False,
                estimated_hours=self._estimate_hours(500_000),
                difficulty=self._estimate_difficulty(500_000),
                success_rate=55,
                description=(
                    f"Opportunity number: {number}. Posted on Grants.gov. "
                    f"Status: {opp.get('oppStatus', 'posted')}. "
                    f"Open {opp.get('openDate', '')} - close "
                    f"{opp.get('closeDate', '')}."
                ),
                source="grants.gov",
                url=url,
            )
        except Exception as exc:
            logger.warning("v1_opportunity_parse_error", error=str(exc))
            return None

    def _derive_agency(self, *, number: str, title: str, fallback: str) -> str:
        """Derive the responsible agency from the opportunity metadata.

        Order of evidence (most reliable first):

        1. CFDA / ALN ``84.*`` codes in the title — these are the
           definitive U.S. Department of Education program identifiers.
        2. OESE / OII / IES substrings in the opportunity number — ED
           offices that may be wrapped inside a longer prefix.
        3. Longest-matching prefix from ``_AGENCY_PREFIX_MAP``.
        4. The funder's own ``agencyName`` if Grants.gov populated it.
        5. ``Federal Agency`` as the last-resort label.
        """

        # 1. CFDA / ALN 84.* — definitive ED marker.
        if re.search(r"\b84\.\d{3}[A-Z]?\b", title):
            return "U.S. Department of Education"

        upper_num = number.upper()

        # 2. ED office substrings that may sit inside a longer prefix
        # (e.g. ``DOL-OESE-33831`` is an ED OESE program, not DOL).
        for token, agency in (
            ("OESE", "U.S. Department of Education"),
            ("OII", "U.S. Department of Education"),
            ("OPE-", "U.S. Department of Education"),
            ("IES-", "Institute of Education Sciences (ED)"),
        ):
            if token in upper_num:
                return agency

        # 3. Longest-prefix-first match against the catalogue.
        for prefix, name in sorted(
            self._AGENCY_PREFIX_MAP.items(),
            key=lambda kv: len(kv[0]),
            reverse=True,
        ):
            if upper_num.startswith(prefix):
                return name

        # 4. Fall back to whatever Grants.gov returned.
        if fallback:
            return fallback
        return "Federal Agency"


    def _parse_mdy(self, raw: str) -> datetime | None:
        raw = raw.strip()
        if not raw:
            return None
        for fmt in ("%m/%d/%Y", "%Y-%m-%d"):
            try:
                # Federal deadline strings carry no offset. They are UTC dates,
                # and they get compared against `datetime.now(UTC)` below, so
                # they must be attached to a timezone here or the comparison
                # raises TypeError.
                return datetime.strptime(raw, fmt).replace(tzinfo=UTC)
            except ValueError:
                continue
        return None

    
    def _parse_grant_result(self, result: dict) -> Grant | None:
        """Parse a single grant from GSA Search.gov results."""
        try:
            url = result.get("url", "")
            title = self._clean_html(result.get("title", "Grant Opportunity"))
            snippet = result.get("snippet", result.get("description", ""))
            
            # Extract opportunity number from URL if available
            # Try multiple patterns: search-results-detail, grants/view, etc
            url_match = re.search(r"/search-results-detail/(\d+)", url)
            if url_match:
                opportunity_number = url_match.group(1)
            else:
                # Generate a unique ID from the URL or title
                import hashlib
                unique_str = f"{url}{title}"
                opportunity_number = hashlib.sha256(unique_str.encode()).hexdigest()[:10]

            # Extract agency name
            agency_name = self._extract_agency_name(snippet, title)

            # Extract amounts
            amount_min = self._extract_amount(snippet, "min") or 50000
            amount_max = self._extract_amount(snippet, "max") or 500000
            
            # Extract close date
            close_date = self._extract_close_date(snippet)
            
            # Build the grant object - matching your TypeScript normalizeGrant()
            grant = Grant(
                id=f"grants-gov-{opportunity_number}",
                title=title,
                agency=agency_name,
                amount=f"${amount_min:,} - ${amount_max:,}",
                deadline=close_date,
                type="Federal",
                focus=self._parse_categories(title, snippet),
                eligibility=["Public K-12 Schools", "School Districts", "Educational Agencies"],
                match_required=False,
                estimated_hours=self._estimate_hours(amount_max),
                difficulty=self._estimate_difficulty(amount_max),
                success_rate=55,
                description=self._clean_html(snippet),
                source="grants.gov",
                url=url if url else f"https://www.grants.gov/search-results-detail/{opportunity_number}"
            )
            
            logger.debug("grant_parsed", title=title[:50], agency=agency_name)
            return grant
            
        except Exception as e:
            logger.warning("grant_parse_error", error=str(e))
            return None
    
    def _extract_agency_name(self, text: str, title: str) -> str:
        """Extract agency name from text."""
        combined = f"{text} {title}".lower()
        
        agency_map = {
            "education": "Department of Education",
            "nsf": "National Science Foundation",
            "science foundation": "National Science Foundation",
            "labor": "Department of Labor",
            "dol": "Department of Labor",
            "health": "Health and Human Services",
            "hhs": "Health and Human Services",
            "justice": "Department of Justice",
            "doj": "Department of Justice",
            "agriculture": "Department of Agriculture",
            "usda": "Department of Agriculture",
        }
        
        for key, agency in agency_map.items():
            if key in combined:
                return agency
        
        return "Federal Agency"
    
    def _extract_close_date(self, text: str) -> datetime:
        """Extract close date from text."""
        date_match = re.search(
            r"(?:Close Date|Closing Date|Deadline):\s*(\d{1,2}/\d{1,2}/\d{4})",
            text,
            re.IGNORECASE
        )
        if date_match:
            try:
                return datetime.strptime(date_match.group(1), "%m/%d/%Y").replace(tzinfo=UTC)
            except ValueError:
                pass
        
        # Default: 90 days from now
        return datetime.now(UTC) + timedelta(days=90)
    
    def _extract_amount(self, text: str, amount_type: str) -> int | None:
        """Extract grant amount from text."""
        # Look for patterns like "$50,000 - $500,000"
        range_match = re.search(r"\$?([\d,]+)\s*-\s*\$?([\d,]+)", text)
        if range_match:
            min_str = range_match.group(1).replace(",", "")
            max_str = range_match.group(2).replace(",", "")
            if min_str and max_str:
                return int(min_str) if amount_type == "min" else int(max_str)
        
        # Look for single amount (must contain at least one digit)
        single_match = re.search(r"\$?(\d[\d,]*)", text)
        if single_match:
            val_str = single_match.group(1).replace(",", "")
            if val_str:
                return int(val_str)
        
        return None
    
    def _parse_categories(self, title: str, description: str) -> list[str]:
        """Parse grant focus categories."""
        text = f"{title} {description}".lower()
        categories = []
        
        category_map = {
            "stem": ["stem", "science", "technology", "engineering", "math"],
            "Special Education": ["special education", "disabilities", "idea"],
            "CTE": ["cte", "career", "technical", "vocational"],
            "Title I": ["title i", "disadvantaged", "low-income"],
            "Technology": ["technology", "equipment", "devices", "computer"],
            "Literacy": ["literacy", "reading", "writing"],
            "Arts": ["arts", "music", "theater", "visual"],
            "Safety": ["safety", "security", "emergency"],
        }
        
        for category, keywords in category_map.items():
            if any(kw in text for kw in keywords):
                categories.append(category)
        
        return categories if categories else ["Education"]
    
    def _estimate_hours(self, amount: int) -> int:
        """Estimate hours based on grant amount."""
        if amount < 100000:
            return 30
        elif amount < 500000:
            return 45
        elif amount < 1000000:
            return 60
        return 80
    
    def _estimate_difficulty(self, amount: int) -> str:
        """Estimate difficulty based on amount."""
        if amount < 100000:
            return "Easy"
        elif amount < 500000:
            return "Medium"
        return "Hard"
    
    def _clean_html(self, text: str) -> str:
        """Clean HTML tags and special characters from text."""
        text = re.sub(r"<[^>]+>", "", text)
        # Strip Unicode Private Use Area characters (e.g. \ue000 used for hit highlighting)
        text = re.sub(r'[\ue000-\uf8ff]', '', text)
        text = text.replace("&nbsp;", " ")
        text = text.replace("&amp;", "&")
        text = text.replace("&lt;", "<")
        text = text.replace("&gt;", ">")
        text = text.replace("&quot;", '"')
        return text.strip()
    
    def clear_cache(self):
        """Clear the grants cache."""
        self._cache.clear()
        logger.info("grants_cache_cleared")


class StatePortalsService:
    """
    State Portals Grant Service
    Searches state-specific grant opportunities from CA, TX, NY, FL, IL
    """
    
    STATE_CONFIGS: ClassVar[dict[str, dict]] = {
        "CA": {
            "name": "California",
            "keywords": ["california", "ca state", "california department of education"],
            "focus": ["Technology", "STEM", "Arts", "Equity", "Innovation"]
        },
        "TX": {
            "name": "Texas",
            "keywords": ["texas", "tx state", "texas education agency"],
            "focus": ["STEM", "Technology", "CTE", "Rural Education"]
        },
        "NY": {
            "name": "New York",
            "keywords": ["new york", "ny state", "nysed"],
            "focus": ["Urban Education", "Special Education", "Arts", "STEM"]
        },
        "FL": {
            "name": "Florida",
            "keywords": ["florida", "fl state", "florida department of education"],
            "focus": ["Charter Schools", "Innovation", "Technology", "Reading"]
        },
        "IL": {
            "name": "Illinois",
            "keywords": ["illinois", "il state", "illinois state board"],
            "focus": ["Urban Education", "Equity", "STEM", "Literacy"]
        },
        "VA": {
            "name": "Virginia",
            "keywords": ["virginia", "va state", "virginia department of education"],
            "focus": ["STEM", "Technology", "CTE", "Literacy", "Special Education"]
        },
        "PA": {
            "name": "Pennsylvania",
            "keywords": ["pennsylvania", "pa state", "pennsylvania department of education"],
            "focus": ["STEM", "Literacy", "Special Education", "CTE"]
        },
        "OH": {
            "name": "Ohio",
            "keywords": ["ohio", "oh state", "ohio department of education"],
            "focus": ["STEM", "Literacy", "CTE", "Technology"]
        },
        "GA": {
            "name": "Georgia",
            "keywords": ["georgia", "ga state", "georgia department of education"],
            "focus": ["STEM", "Technology", "Literacy", "Equity"]
        },
        "NC": {
            "name": "North Carolina",
            "keywords": ["north carolina", "nc state", "north carolina department of education"],
            "focus": ["STEM", "Technology", "Literacy", "Rural Education"]
        },
        "NJ": {
            "name": "New Jersey",
            "keywords": ["new jersey", "nj state", "new jersey department of education"],
            "focus": ["STEM", "Special Education", "Arts", "Equity"]
        },
        "MA": {
            "name": "Massachusetts",
            "keywords": ["massachusetts", "ma state", "massachusetts department of education"],
            "focus": ["STEM", "Innovation", "Literacy", "Technology"]
        },
    }
    
    def __init__(self):
        self.grants_gov = GrantsGovService()
    
    async def search_by_state(
        self,
        state: str,
        keyword: str | None = None
    ) -> list[Grant]:
        """Search for grants from a specific state portal."""
        state_code = state.upper()
        config = self.STATE_CONFIGS.get(state_code)
        
        if not config:
            logger.warning("unsupported_state", state=state_code)
            return []
        
        logger.info("state_search_start", state=config["name"])
        
        try:
            # Use simpler search query with state name
            search_query = f"{config['keywords'][0]} education grant"
            raw_grants = await self.grants_gov.search_grants(keyword=search_query)
            
            # All results from state search are considered state-portal grants
            state_grants = []
            for grant in raw_grants:
                grant.source = "state-portal"
                state_grants.append(grant)
            
            logger.info("state_search_complete", state=config["name"], count=len(state_grants))
            return state_grants
            
        except Exception as e:
            logger.error("state_search_error", state=state_code, error=str(e))
            return []
    
    async def search_all_states(self, keyword: str | None = None) -> list[Grant]:
        """Search all supported state portals."""
        logger.info("all_states_search_start")
        
        tasks = [
            self.search_by_state(state, keyword)
            for state in self.STATE_CONFIGS
        ]
        
        results = await asyncio.gather(*tasks, return_exceptions=True)
        
        all_grants = []
        for result in results:
            if isinstance(result, list):
                all_grants.extend(result)
        
        # Deduplicate
        unique_grants = self._deduplicate_grants(all_grants)
        
        logger.info("all_states_search_complete", total=len(all_grants), unique=len(unique_grants))
        return unique_grants
    
    def _deduplicate_grants(self, grants: list[Grant]) -> list[Grant]:
        """Deduplicate grants by title + agency."""
        seen = set()
        unique = []
        
        for grant in grants:
            key = f"{grant.title.lower()}_{grant.agency.lower()}"
            if key not in seen:
                seen.add(key)
                unique.append(grant)
        
        return unique


class MultiSourceAggregator:
    """
    Multi-Source Grant Aggregator
    Integrates grants from Grants.gov, ED.gov, K12Grants, State Portals,
    and the ProPublica Nonprofit Explorer (private education foundations).
    """
    
    def __init__(self):
        self.grants_gov = GrantsGovService()
        self.state_portals = StatePortalsService()
        # Lazy-imported to avoid a circular dependency at module-load
        # time (foundations imports ``Grant`` from this module).
        from services.foundations import get_foundations_service
        self.foundations = get_foundations_service()
    
    async def search_all_sources(
        self,
        keyword: str,
        state: str | None = None
    ) -> list[Grant]:
        """
        Search grants across ALL enabled sources.
        Returns aggregated and deduplicated grants.
        """
        logger.info("multi_source_search_start", keyword=keyword)
        
        all_grants: list[Grant] = []
        source_stats = {}
        
        # Source 1: Grants.gov (Federal)
        try:
            grants_gov_results = await self.grants_gov.search_grants(keyword=keyword)
            all_grants.extend(grants_gov_results)
            source_stats["grants.gov"] = len(grants_gov_results)
        except Exception as e:
            logger.warning("grants_gov_failed", error=str(e))
            source_stats["grants.gov"] = 0
        
        # Source 2: ED.gov (via Grants.gov with ED filter)
        try:
            ed_results = await self._search_ed_gov(keyword)
            all_grants.extend(ed_results)
            source_stats["ed.gov"] = len(ed_results)
        except Exception as e:
            logger.warning("ed_gov_failed", error=str(e))
            source_stats["ed.gov"] = 0
        
        # Source 3: K12Grants (K-12 specific)
        try:
            k12_results = await self._search_k12_grants(keyword)
            all_grants.extend(k12_results)
            source_stats["k12grants"] = len(k12_results)
        except Exception as e:
            logger.warning("k12grants_failed", error=str(e))
            source_stats["k12grants"] = 0
        
        # Source 4: State Portals
        try:
            if state:
                state_results = await self.state_portals.search_by_state(state, keyword)
            else:
                state_results = await self.state_portals.search_all_states(keyword)
            all_grants.extend(state_results)
            source_stats["state-portal"] = len(state_results)
        except Exception as e:
            logger.warning("state_portals_failed", error=str(e))
            source_stats["state-portal"] = 0

        # Source 5: Private foundations via ProPublica Nonprofit Explorer.
        # Capped at 12 prospects per query so the Discovery LLM's context
        # stays focused on a rankable shortlist.
        try:
            foundation_results = await self.foundations.search_foundations(
                keyword=keyword,
                state=state,
                limit=12,
            )
            all_grants.extend(foundation_results)
            source_stats["foundation"] = len(foundation_results)
        except Exception as e:
            logger.warning("foundations_failed", error=str(e))
            source_stats["foundation"] = 0
        
        # Deduplicate
        unique_grants = self._deduplicate_grants(all_grants)
        
        logger.info(
            "multi_source_search_complete",
            total_raw=len(all_grants),
            total_unique=len(unique_grants),
            sources=source_stats
        )
        
        return unique_grants, source_stats
    
    async def _search_ed_gov(self, keyword: str) -> list[Grant]:
        """Search ED.gov via Grants.gov with education filter."""
        # Combine the user keyword with education department context
        ed_keyword = f"{keyword} department of education"
        results = await self.grants_gov.search_grants(
            keyword=ed_keyword,
            page_size=15
        )
        
        ed_grants = []
        for grant in results:
            text = f"{grant.title} {grant.description}".lower()
            if "education" in text:
                grant.source = "ed.gov"
                ed_grants.append(grant)
        
        return ed_grants
    
    async def _search_k12_grants(self, keyword: str) -> list[Grant]:
        """Search for K-12 specific grants."""
        # Combine the user keyword with K-12 school context
        k12_keyword = f"{keyword} school K-12"
        results = await self.grants_gov.search_grants(
            keyword=k12_keyword,
            page_size=15
        )
        
        k12_grants = []
        for grant in results:
            text = f"{grant.title} {grant.description}".lower()
            if any(kw in text for kw in ["school", "k-12", "k12", "elementary", "education"]):
                grant.source = "k12grants"
                k12_grants.append(grant)
        
        return k12_grants
    
    def _deduplicate_grants(self, grants: list[Grant]) -> list[Grant]:
        """Deduplicate grants from multiple sources."""
        seen = set()
        unique = []
        
        for grant in grants:
            key = f"{grant.title.lower()}_{grant.agency.lower()}"
            if key not in seen:
                seen.add(key)
                unique.append(grant)
        
        return unique


# Singleton instances
_grants_gov_service: GrantsGovService | None = None
_multi_source_aggregator: MultiSourceAggregator | None = None


def get_grants_gov_service() -> GrantsGovService:
    """Get singleton Grants.gov service."""
    global _grants_gov_service
    if _grants_gov_service is None:
        _grants_gov_service = GrantsGovService()
    return _grants_gov_service


def get_multi_source_aggregator() -> MultiSourceAggregator:
    """Get singleton multi-source aggregator."""
    global _multi_source_aggregator
    if _multi_source_aggregator is None:
        _multi_source_aggregator = MultiSourceAggregator()
    return _multi_source_aggregator
