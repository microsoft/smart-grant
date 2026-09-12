"""
Rubric-based Discovery prompt + structured output parser.

The v2 Discovery agent does **not** silently pick one grant. It produces a
top-5 ranking against a transparent 100-point rubric, and a human selects
which grant the rest of the pipeline writes against.

This module is a hard fork of the v1 ``DISCOVERY_AGENT_PROMPT`` in
:mod:`agents.prompts`. The v1 prompt is left untouched — it still serves
the legacy ``/workflow/run`` endpoint. v2's HITL flow imports from here.

Design choices
--------------
* **No decorative glyphs.** The prompt is written natively for consulting-
  grade output. The pipeline-wide ``_strip_emojis`` safety net still runs
  but should never have anything to do.
* **Strict JSON envelope.** The model produces a single JSON object that
  parses cleanly into :class:`v2.schemas.DiscoveryRanking`. The parser is
  tolerant of fenced code blocks and leading/trailing prose.
* **Hard disqualifiers first.** The rubric only scores grants that pass
  every eligibility check. Disqualified candidates land in a separate
  ``disqualified`` list with a one-line reason — never silently dropped.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable

from pydantic import ValidationError

from services.grants import Grant
from v2.schemas import DiscoveryRanking

# ---------------------------------------------------------------- system prompt


RUBRIC_EXPLANATION = (
    "Each candidate grant is scored on a transparent 100-point rubric: "
    "Eligibility fit (25), Mission alignment (20), Demographic resonance (15), "
    "Award size fit (10), Competition odds (10), Timeline feasibility (10), "
    "Sustainability potential (5), Strategic upside (5). "
    "Grants that fail any hard eligibility check are listed as disqualified "
    "with a one-line reason and are never scored."
)


RANKED_DISCOVERY_SYSTEM_PROMPT = """You are the Discovery Agent for Smart Grant Request — a senior federal grants strategist with 20 years of K-12 funding experience. You are advising a school's grant coordinator.

Your task: from the live list of grants surfaced by federated search (Grants.gov, ED.gov, K12Grants, state portals), produce a transparent, audit-ready Top 5 ranking for this specific school and this specific funding intent. A human will then select which grant to pursue.

You do not invent grants. You do not embellish. You name trade-offs honestly. You disqualify before you rank.

================ HARD DISQUALIFIERS — APPLY FIRST ================

Reject any grant whose listing is clearly NOT an actual funding opportunity:
- Grants.gov navigation, terminology, eligibility, or agency-landing pages
  (titles like "Grant Terminology", "Grant Eligibility", "U.S. Department of X | Grants.gov", "Other Grant-Making Agencies", "Grants.gov Releases")
- Pages whose title is only an agency name and the suffix "| Grants.gov"
- Search-result placeholders, FAQ pages, fraud-reporting pages

Reject any actual grant that fails a hard eligibility check for THIS school:
- Geographic ineligibility (wrong state for a state-restricted grant)
- School type mismatch (Public-only grant + non-Public school, or vice versa)
- Grade level mismatch (e.g., HS-only grant + K-5 elementary)
- Deadline already passed
- Required prerequisite the school lacks (e.g., must be existing 21st CCLC site, must have current Title I status when school is not Title I)

For every rejected grant, record it in ``disqualified`` with a SHORT reason
(≤ 6 words), e.g. "Generic landing page", "State mismatch", "Deadline passed",
"Title I required, school is not".

================ SCORING RUBRIC — 100 POINTS ================

Apply ONLY to grants that pass every disqualifier. Each dimension uses the
full range; do not bunch every grant around the same number.

  Eligibility fit            0–25  Hard match on school type, state, grades,
                                   Title I, geography. 25 = perfect, 15 =
                                   minor friction, 5 = stretch.
  Mission alignment          0–20  How well the grant's stated purpose
                                   matches the school's grant_purpose AND
                                   existing programs.
  Demographic resonance      0–15  Funder priority alignment with this
                                   school's FRL %, ELL %, minority %, rurality.
  Award size fit             0–10  Is the award range realistic for the
                                   school's enrollment and capacity? Too
                                   small = noise (low score), too large =
                                   capacity risk (medium score), goldilocks =
                                   full score.
  Competition odds           0–10  Estimated funding rate for this grant
                                   family. Formula grants and small federal
                                   programs score higher than open competitive
                                   pools.
  Timeline feasibility       0–10  Days to deadline vs. application
                                   complexity. < 14 days for a complex federal
                                   grant = heavy penalty.
  Sustainability potential   0–5   Multi-year? Renewable? Follow-on funding?
  Strategic upside           0–5   Door-opener to a new funder relationship,
                                   signals capacity for larger future asks.

The ``score_total`` you emit MUST equal the sum of the eight dimensions.

================ PROS / CONS / CONFIDENCE ================

For every ranked grant, surface:
- ``pros``: EXACTLY 3 concrete, school-specific reasons this grant is a fit.
  Reference the school by name, the demographics, or named existing programs.
  Never generic ("good opportunity"). Always specific ("Aligns with the
  school's existing CTE program and serves the 38% FRL population.").
- ``cons``: EXACTLY 2 honest trade-offs or risks. Examples: "Tight 30-day
  deadline limits review cycles", "Requires 25% local match", "Pre-application
  letter of intent required by [date]".
- ``why_this_rank``: ONE sentence explicitly tying the total score to the
  specific school.
- ``confidence``: "high" if amount, deadline, eligibility, and funder priorities
  are all clearly stated in the source; "medium" if 1–2 are inferred; "low" if
  the listing is sparse or the funder is unfamiliar.

Honest ranking matters more than flattering the user. If the best available
grant is mediocre, give it a mediocre score and say so in ``why_this_rank``.

================ TIE-BREAKING ================

If two grants tie on ``score_total``: the earlier deadline wins, then larger
maximum award, then alphabetical funder. Apply deterministically.

================ OUTPUT — STRICT JSON ONLY ================

Return a SINGLE JSON object. No prose before or after. No markdown code
fences. No commentary. This object MUST validate against this schema:

{
  "summary": "<2–3 sentences describing the search itself, e.g. 'Reviewed 21 grants from four sources; 14 were generic landing pages or ineligible. 5 qualified candidates were scored against the school's STEM profile.'>",
  "total_grants_searched": <int — count of raw inputs>,
  "sources": { "<source>": <int>, ... },
  "rubric_explanation": "<one short sentence reminding the reader of the 100-point methodology>",
  "top_grants": [
    {
      "id": "<short stable id, e.g. 'g1'>",
      "rank": 1,
      "title": "<exact title>",
      "funder": "<exact funder/agency>",
      "source": "grants.gov | ed.gov | k12grants | state-portal | foundation | other",
      "url": "<URL or null>",
      "amount_text": "<e.g. '$50,000 – $250,000' or 'Up to $200,000'>",
      "amount_low_usd": <int or null>,
      "amount_high_usd": <int or null>,
      "deadline_text": "<as listed, or 'Rolling'>",
      "deadline_iso": "<YYYY-MM-DD or null>",
      "summary": "<1–2 neutral sentences about the grant itself>",
      "score": {
        "eligibility_fit": <0–25>,
        "mission_alignment": <0–20>,
        "demographic_resonance": <0–15>,
        "award_size_fit": <0–10>,
        "competition_odds": <0–10>,
        "timeline_feasibility": <0–10>,
        "sustainability_potential": <0–5>,
        "strategic_upside": <0–5>
      },
      "score_total": <int 0–100 — MUST equal sum of score>,
      "pros": ["<pro 1>", "<pro 2>", "<pro 3>"],
      "cons": ["<con 1>", "<con 2>"],
      "why_this_rank": "<one sentence>",
      "confidence": "high | medium | low"
    }
    // up to 5 entries, sorted by score_total DESC, with tie-break applied
  ],
  "disqualified": [
    { "title": "<as listed>", "funder": "<as listed or ''>", "reason": "<≤6 words>" }
  ]
}

If after disqualification fewer than 5 grants remain, return what you have.
If ZERO qualify, return an empty ``top_grants`` array with the disqualified
list fully populated and a ``summary`` that explains why nothing qualified.

You will be evaluated on: rubric discipline, honesty of cons, accuracy of
disqualifiers, and adherence to the JSON contract. There is no reward for
verbosity."""


# --------------------------------------------------------------- prompt builder


def build_ranked_discovery_user_prompt(
    *,
    grant_purpose: str,
    school_context: str,
    live_grants: Iterable[Grant],
    source_stats: dict,
) -> str:
    """Build the user message for the rubric Discovery agent.

    Mirrors the shape of :func:`agents.prompts.build_discovery_prompt` but
    is purpose-built for structured JSON output.
    """

    grants = list(live_grants)
    grant_lines: list[str] = []
    for i, g in enumerate(grants, start=1):
        deadline = g.deadline.isoformat() if hasattr(g.deadline, "isoformat") else str(g.deadline)
        url_part = f"\n   URL: {g.url}" if getattr(g, "url", None) else ""
        awards = getattr(g, "expected_awards", None)
        awards_part = f"\n   Awards expected: {awards}" if awards else ""
        # Verbatim do aviso: e o unico lugar que revela quando uma escola K-12
        # sequer pode se candidatar.
        elig = (getattr(g, "eligibility_text", None) or "").strip()
        elig_part = f"\n   Eligibility (verbatim): {elig[:400]}" if elig else ""
        grant_lines.append(
            f"{i:2}. [{g.source}] {g.title}\n"
            f"   Funder: {g.agency}\n"
            f"   Amount: {g.amount} | Deadline: {deadline} | Difficulty: {g.difficulty}\n"
            f"   Focus: {', '.join(g.focus[:5]) if g.focus else '(unspecified)'}"
            f"{awards_part}"
            f"{elig_part}"
            f"{url_part}"
        )
    grants_block = "\n\n".join(grant_lines) if grant_lines else "(no live grants returned)"

    source_summary = ", ".join(f"{k}: {v}" for k, v in sorted(source_stats.items())) or "(no source breakdown)"

    return f"""GRANT PURPOSE (school's funding intent):
{grant_purpose}

{school_context}

SOURCE BREAKDOWN: {source_summary}
TOTAL RAW GRANTS SURFACED: {len(grants)}

LIVE GRANT POOL — score the qualified candidates, disqualify the rest:

{grants_block}

Produce the strict JSON object now. No prose before or after."""


# -------------------------------------------------------------------- parser


_FENCE_RE = re.compile(r"```(?:json|JSON)?\s*(\{.*?\})\s*```", re.DOTALL)


def parse_discovery_ranking(text: str) -> DiscoveryRanking:
    """Parse a Discovery-agent response into a :class:`DiscoveryRanking`.

    Tolerates:
      * ```json … ``` fenced blocks
      * Leading or trailing prose around a single JSON object
      * Pretty-printed multi-line JSON

    Raises :class:`ValueError` on unrecoverable parse failure.
    """

    if not text or not text.strip():
        raise ValueError("Discovery agent returned empty output.")

    raw = text.strip()

    # 1. Prefer the first fenced JSON block.
    fence_match = _FENCE_RE.search(raw)
    if fence_match:
        candidate = fence_match.group(1)
    else:
        # 2. Otherwise, take the widest balanced substring between the first
        #    '{' and the matching final '}'.
        start = raw.find("{")
        end = raw.rfind("}")
        if start == -1 or end == -1 or end <= start:
            raise ValueError("Discovery agent did not return a JSON object.")
        candidate = raw[start : end + 1]

    try:
        data = json.loads(candidate)
    except json.JSONDecodeError as exc:
        # One more pass: strip JS-style trailing commas, which models sometimes emit.
        cleaned = re.sub(r",\s*([}\]])", r"\1", candidate)
        try:
            data = json.loads(cleaned)
        except json.JSONDecodeError:
            raise ValueError(f"Discovery JSON was not parseable: {exc}") from exc

    try:
        return DiscoveryRanking.model_validate(data)
    except ValidationError as exc:
        raise ValueError(f"Discovery JSON failed schema validation: {exc}") from exc
