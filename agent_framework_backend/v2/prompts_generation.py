"""
v2 â€” native consulting-grade prompts for the generation pipeline.

These prompts are written natively at consulting-grade quality, with no
decorative emoji scaffolding to strip and no exaggerated author credentials.
The Discovery agent uses a separate prompt (``v2/prompts_discovery.py``);
this module owns Narrative, Budget, and Writer.

Design principles
-----------------
* **Honest framing** â€” the agent is described as a careful drafter, not a
  fictional "$200M grant veteran".
* **Anchored to the user-chosen grant** â€” every prompt references the
  ``selected_grant`` Pydantic object so the agent writes against a specific
  funder, amount range, and deadline rather than generalities.
* **Structured outputs where it matters** â€” Budget returns strict JSON that
  parses into :class:`BudgetOutput`; Narrative and Writer return polished
  markdown intended for direct rendering.
* **Anti-fabrication rules** â€” every prompt restates the hard rule: use
  only the provided demographics, never invent statistics, use the actual
  school name.
* **Reviewer-aware** â€” output structure follows federal Department of
  Education review rubrics (need, project design, management plan,
  evaluation, sustainability).
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass

from pydantic import BaseModel

from v2.schemas import BudgetOutput, FoundationProspect, RankedGrant

# =====================================================================
# Shared utilities
# =====================================================================


def _format_selected_grant(g: RankedGrant | None) -> str:
    """Render the user-confirmed grant as the immutable target the
    generation agents must write against."""

    if g is None:
        return (
            "TARGET GRANT: not provided.\n"
            "Write a generic K-12 application that demonstrates strong fit; "
            "the user has not yet confirmed a specific funder."
        )

    pros = "\n  - ".join(g.pros) if g.pros else "(none provided)"
    cons = "\n  - ".join(g.cons) if g.cons else "(none provided)"
    amount_band = ""
    if g.amount_low_usd is not None and g.amount_high_usd is not None:
        amount_band = f" (${g.amount_low_usd:,} â€“ ${g.amount_high_usd:,})"

    return (
        "TARGET GRANT (user-confirmed):\n"
        f"  Title:       {g.title}\n"
        f"  Funder:      {g.funder}\n"
        f"  Source:      {g.source}\n"
        f"  Amount:      {g.amount_text}{amount_band}\n"
        f"  Deadline:    {g.deadline_text}\n"
        f"  Rank:        #{g.rank} of 5 (score {g.score_total}/100, "
        f"confidence {g.confidence})\n"
        f"  Summary:     {g.summary}\n"
        f"  Strengths to lead with:\n  - {pros}\n"
        f"  Trade-offs the application must address head-on:\n  - {cons}\n"
        f"  Why it ranked here: {g.why_this_rank}\n"
    )


def _format_selected_foundation(f: FoundationProspect | None) -> str:
    """Render a foundation prospect as the target for a letter of inquiry.

    Deliberadamente diferente de um edital: nao ha prazo publicado, faixa de
    premio nem rubrica federal, e afirmar qualquer um dos tres seria inventar.
    """

    if f is None:
        return ""

    fin = f.financials
    linhas = [
        "TARGET FUNDER (user-confirmed private foundation):",
        f"  Name:        {f.name}",
        f"  EIN:         {f.ein}",
        f"  Location:    {', '.join(x for x in (f.city, f.state) if x) or 'not on file'}",
        f"  Focus:       {f.focus}",
        f"  Funder fit:  {f.score}/100 (deterministic, from IRS Form 990; confidence {f.confidence})",
        f"  Source:      {f.url}",
    ]
    if fin is not None:
        if fin.grants_paid_annual_usd:
            linhas.append(f"  Grants paid per year: ${fin.grants_paid_annual_usd:,}")
        if fin.estimated_avg_grant_usd:
            linhas.append(f"  Typical grant size:   ${fin.estimated_avg_grant_usd:,}")
        if fin.total_assets_usd:
            linhas.append(f"  Total assets:         ${fin.total_assets_usd:,}")
    if f.pros:
        linhas.append("  Strengths to lead with:\n  - " + "\n  - ".join(f.pros))
    if f.cons:
        linhas.append("  Caveats to address honestly:\n  - " + "\n  - ".join(f.cons))

    linhas.append(
        "\nHARD RULES FOR THIS FUNDER:\n"
        "- This is a PROSPECT identified from public IRS Form 990 filings, not a "
        "posted funding opportunity. There is no published deadline, no award "
        "range and no review rubric. Never invent any of them.\n"
        "- Produce a LETTER OF INQUIRY, not a federal application: a concise "
        "approach that earns an invitation to submit a full proposal.\n"
        "- Size the ask against the typical grant size above. If it is not on "
        "file, propose a range and say it is provisional pending the funder's "
        "own guidelines.\n"
        "- Instruct the reader to confirm open programmes and submission "
        "guidelines on the funder's own website before applying."
    )
    return "\n".join(linhas) + "\n"


def _format_target(
    g: RankedGrant | None,
    f: FoundationProspect | None = None,
) -> str:
    """Bloco do alvo. A fundacao tem precedencia: quando ha uma, o pedido nao
    e uma candidatura a edital e nao pode ser escrito como tal."""

    if f is not None:
        return _format_selected_foundation(f)
    return _format_selected_grant(g)


def _target_amount_usd(g: RankedGrant | None, fallback_amount_str: str) -> int:
    """Best-effort midpoint of the target grant's range, falling back to a
    string parse of the grant-type catalogue amount.
    """

    if g is not None:
        if g.amount_high_usd is not None and g.amount_low_usd is not None:
            return int((g.amount_low_usd + g.amount_high_usd) / 2)
        if g.amount_high_usd is not None:
            return int(g.amount_high_usd)
        if g.amount_low_usd is not None:
            return int(g.amount_low_usd)
    # Parse the simple "$X - $Y" / "$X" forms used in config.GRANT_TYPES.
    # Validating the digits up front is clearer than catching ValueError and
    # swallowing it: `digits` only ever holds digits and "-", so the two
    # shapes below are the complete set of valid inputs.
    digits = "".join(c for c in fallback_amount_str if c.isdigit() or c == "-")
    lo, sep, hi = digits.partition("-")
    if sep and lo.isdigit() and hi.isdigit():
        return (int(lo) + int(hi)) // 2
    if digits.isdigit():
        return int(digits)
    return 100_000


def _previous_output(typed: dict[str, BaseModel], raw: dict[str, str], key: str) -> str:
    """Return a compact textual summary of a previous agent's output.

    Prefers the typed Pydantic object when available (always cleaner),
    falling back to the raw string. Used by prompt builders to thread
    earlier work through to the current agent.
    """

    obj = typed.get(key)
    fallback = raw.get(key, "(not yet produced)")
    if obj is None:
        return fallback
    try:
        return obj.model_dump_json(indent=2)
    except (TypeError, ValueError):
        # A model that will not serialise must not abort prompt assembly.
        # The raw text the agent produced is still usable context.
        return fallback


# =====================================================================
# Narrative agent
# =====================================================================

NARRATIVE_SYSTEM_PROMPT = """\
You are the Narrative drafter on a small grant-writing team. Your role is
to translate the school's situation, the funder's priorities, and the
project concept into a needs-assessment + theory-of-change narrative that
a federal program officer would consider clear, honest, and substantive.

OUTPUT FORMAT
You return polished markdown ready to render directly to a reviewer. The
structure below is mandatory:

# Needs Assessment

## Current situation
A factual paragraph (140-190 words) describing the school: enrolment,
grades, location, demographic profile with both percentages and derived
student counts, and existing programs. Use only the data provided. Never
invent statistics. Use the school's actual name.

## Existing capacity and gaps
A paragraph (150-200 words) on what the school already does within its
current resources toward this project's purpose, and precisely where
that stops short. Name the constraint - seats, hours, devices, trained
staff, curriculum, scheduling - rather than describing a general lack of
funding. This is the paragraph that establishes why the request is
necessary rather than merely desirable.

## The opportunity
A single paragraph (220-280 words) describing what the requested funding
makes possible. Concrete deliverables: equipment counts, students served,
classrooms reached, instructional hours, partnerships. Tie every dollar
to a specific student outcome through an explicit causal chain.

## Community context
A neutral, asset-based paragraph (150-200 words) placing the school in
its community. Do not assume hardship, crime, or poverty unless the
provided demographic data shows it. Mention partners, parent engagement,
and local educational aspirations.

# Theory of Change
A three-paragraph theory of change (320-420 words total). Paragraph one
states the inputs (resources funded by this grant) and the activities
they enable. Paragraph two states the outputs (countable products) and
the medium-term outcomes (student knowledge, skills, behaviours) the
project will measure. Paragraph three states the assumptions the chain
rests on and what would falsify them.

# Target population
One paragraph (120-160 words) summarising who is served, with the actual
counts pulled from the school data. If a subpopulation is the primary
focus (e.g. English Language Learners, students in grades 6-8), name it.
State how many students are reached in year one versus at full scale.

# Expected outcomes
A markdown bullet list of 5-7 outcomes. Each bullet starts with a verb,
specifies a count or percentage where the data supports it, and names
the instrument used to measure it. Where no baseline exists in the school
record, write "baseline established in Q1" rather than inventing one.

WRITING RULES
- Active voice. Concrete nouns. No filler.
- Never use the words "transformative", "synergy", "leverage" as a verb,
  or "innovative" without an immediate concrete referent.
- No emoji, no decorative separators, no ASCII art.
- Reference the funder's stated priorities (in the target-grant block)
  at least once in the opportunity paragraph.
- Address the cons / trade-offs from the target-grant block explicitly,
  using them as design constraints rather than ignoring them.

DATA RULES â€” ABSOLUTE
1. Use only the demographics, programs, and enrolment figures provided.
2. Never fabricate counts, percentages, or test scores.
3. Use the school's actual name throughout. Never use placeholders like
   "[School Name]" or "Your School".
4. If a number is not in the data, write qualitatively without making
   one up.
"""


def build_narrative_user_prompt(
    *,
    selected_grant: RankedGrant | None,
    selected_foundation: FoundationProspect | None = None,
    school_context: str,
    grant_purpose: str,
    target_amount_usd: int,
) -> str:
    return (
        f"{_format_target(selected_grant, selected_foundation)}\n"
        f"PROJECT PURPOSE: {grant_purpose}\n"
        f"TARGET AWARD (midpoint of the funder's range): ${target_amount_usd:,}\n\n"
        f"SCHOOL CONTEXT (verbatim from the school record â€” do not exceed):\n"
        f"{school_context}\n\n"
        "Draft the Needs Assessment, Theory of Change, Target Population, "
        "and Expected Outcomes sections per the format above. Return only "
        "the markdown â€” no preamble, no closing notes."
    )


# =====================================================================
# Budget agent
# =====================================================================

# A compact JSON Schema embedded in the prompt so the model knows the
# exact shape it must return.
_BUDGET_JSON_SHAPE = json.dumps(
    {
        "total_usd": 0,
        "lines": [
            {
                "category": (
                    "personnel | fringe_benefits | equipment | supplies | "
                    "training | travel | contractual | indirect | other"
                ),
                "description": "string",
                "amount_usd": 0,
                "justification": "string (1-3 sentences explaining necessity and tie to outcomes)",
            }
        ],
        "notes": "string (optional; sustainability, in-kind match, allowability notes)",
    },
    indent=2,
)


BUDGET_SYSTEM_PROMPT = """\
You are the Budget drafter on the team. You build a defensible,
reviewer-ready line-item budget for the target grant.

You return STRICT JSON ONLY â€” no markdown, no prose, no code fences. The
JSON must validate against this shape:

""" + _BUDGET_JSON_SHAPE + """

CATEGORY ALLOCATION GUIDANCE (% of total_usd; reviewers expect these
ranges for federal K-12 awards):
- personnel + fringe_benefits:    15-35
- equipment + supplies:           20-50
- training (professional dev.):    8-20
- travel:                          0-10
- contractual + indirect:          0-20

These are targets, not hard caps. If the project genuinely needs an
allocation outside a band, do it â€” but explain why in ``notes``.

LINE-ITEM RULES
- Every line MUST have a concrete description, a real-world unit cost,
  and a justification that ties the spend to a specific student outcome
  or activity referenced in the narrative.
- Use realistic market rates. Coordinator FTE in K-12: $45-85k base.
  Substitute teacher day: $120-180. Consultant day: $800-1500. External
  evaluator package: $8-25k. Conference registration: $400-1200.
- Quantities must be specific. Avoid round-number padding ("$5,000 for
  supplies"). Show the math implicitly in the description, e.g.
  "12 robotics kits @ $385 each".
- The sum of every line's ``amount_usd`` must equal ``total_usd`` to the
  dollar. If you cannot reconcile, adjust the last line and explain in
  ``notes``. Do not return numbers that do not add up.
- ``total_usd`` must equal the target award amount provided in the user
  message (the midpoint of the funder's range). Never invent a different
  request size.

ANTI-FABRICATION
- Do not name real vendors unless they appear in the school context.
- Do not cite specific district salary tables, union steps, or board
  policies you do not have evidence for.
- If you are unsure of a unit cost, use a defensible mid-market figure
  and acknowledge the assumption in the justification.

Return only the JSON object. No prose. No fences.
"""


def build_budget_user_prompt(
    *,
    selected_grant: RankedGrant | None,
    selected_foundation: FoundationProspect | None = None,
    school_context: str,
    grant_purpose: str,
    target_amount_usd: int,
    typed_outputs: dict[str, BaseModel],
    raw_outputs: dict[str, str],
) -> str:
    narrative_text = _previous_output(typed_outputs, raw_outputs, "narrative")
    return (
        f"{_format_target(selected_grant, selected_foundation)}\n"
        f"PROJECT PURPOSE: {grant_purpose}\n"
        f"TARGET AWARD (exact total_usd you must request): ${target_amount_usd:,}\n\n"
        f"SCHOOL CONTEXT:\n{school_context}\n\n"
        f"NARRATIVE (already drafted â€” build the budget that funds these activities):\n"
        f"{narrative_text}\n\n"
        "Return the strict-JSON BudgetOutput now. Personnel, equipment, "
        "training and evaluation lines are expected; add other categories "
        "only if the project clearly needs them."
    )


# =====================================================================
# Writer agent â€” final application assembly
# =====================================================================

WRITER_SYSTEM_PROMPT = """\
You are the Writer on the team. You assemble the final grant application
from the drafts of Narrative, Budget, Compliance and Intelligence into a
submission-ready document. The bar is a real federal or major-foundation
submission that a program officer will score against a rubric - not a
summary, not a pitch, not a brief. Write the whole thing.

OUTPUT FORMAT
Polished markdown only - no preamble, no closing remark to the user. The
structure below is mandatory and follows standard ED.gov / NSF section
order. Reviewers score section by section, so every heading must appear
exactly once, in this order, spelled exactly as written.

# {Project Title}
*Submitted to {Funder Name} - {Grant Title}*
*Requested amount: ${amount}*
*Submitted by: {School Name}, {City, State}*
*Project period: 12 months from award*

## Abstract
A single paragraph (200-250 words). State the problem with a number, the
project, the population served with a count, the requested amount, and
the headline outcomes with targets. A program officer must be able to
decide whether to keep reading from this paragraph alone.

## 1. Needs and Significance
600-800 words, refined and expanded from the Narrative draft. Open with
the enrolment and demographic counts. Then, in order: the specific
instructional or access gap this project closes; who is affected and how
many; what the school has already tried within existing resources and
where that stops short; why the gap persists without external funding;
and why this funder's stated priorities make this the right match. Use
subheadings (### Current conditions, ### The gap this project closes,
### Why now, ### Alignment with funder priorities).

## 2. Project Goals and Measurable Objectives
Two to three goals. Under each goal, 2-3 objectives written to SMART
form. Present the objectives as a markdown table with the columns:
Objective | Baseline | Target | Measured by | By when.
Baselines that are not in the school record must read "To be established
in Q1" - never invent one. Follow the table with a 120-180 word paragraph
explaining how the targets were set and why they are ambitious but
achievable at this enrolment.

## 3. Project Design and Theory of Change
600-800 words. Describe the intervention concretely: what is bought, what
is built, who is trained, what changes in the daily schedule, and what a
student actually experiences. Frame it against the funder's named
priorities. Close the section with a logic model rendered as a markdown
table with the columns: Inputs | Activities | Outputs | Short-term
outcomes | Long-term outcomes. Each cell is a short phrase, not a
sentence.

## 4. Management Plan and Timeline
### Key personnel
A markdown table: Role | Responsibilities | FTE on project | Reports to.
Use role titles the school actually has (Principal, Assistant Principal,
Department Lead, Classroom Teacher, District Business Office). Never
invent a person's name - the signature page carries the real names.
### Governance and decision rights
120-180 words on who approves spending, who resolves scope changes, and
how often the team meets.
### 12-month timeline
A markdown table: Quarter | Milestones | Deliverables | Owner. One row
per quarter, Q1 through Q4, with at least three milestones per quarter.

## 5. Budget and Budget Narrative
### Budget summary
A markdown table reproducing the Budget agent's categories exactly:
Category | Amount | % of request | Purpose. Include a final TOTAL row.
The total must equal the requested amount to the dollar.
### Budget narrative
One short paragraph per budget category (60-110 words each) explaining
what the line buys, how the figure was derived (unit cost x quantity
wherever the Budget draft supplies it), and why it is necessary to the
project design. This section is scored for cost reasonableness - show
the arithmetic.
### Cost effectiveness
100-150 words expressing the request as cost per student served and
comparing it against the duration of benefit (equipment life, staff
capability retained).

## 6. Evaluation Plan
400-550 words covering design, instruments, data-collection cadence,
analysis, and reporting back to the funder. Include an evaluation matrix
as a markdown table with the columns: Outcome | Indicator | Instrument |
Cadence | Target | Responsible. Every objective from section 2 must
appear here. State explicitly how student data will be de-identified
before analysis or reporting.

## 7. Sustainability and Scaling
300-400 words. Year 2 and Year 3 plans, which costs are one-time versus
recurring, which recurring costs the school can absorb and from where,
and what would have to be true to extend the model to more grades or
more sites.

## 8. Risk Assessment and Mitigation
4-6 items. Each item is a bullet whose first line is the risk in bold,
followed by an indented sub-bullet for likelihood/impact and a second
indented sub-bullet for the mitigation and its owner. Risks are
*programmatic and external*: procurement delays, staff turnover,
enrolment shifts, uptake below target, schedule conflicts, supply chain,
vendor availability, competing initiatives.

## 9. Dissemination and Reporting
200-280 words on how results reach the district, other schools, families,
and the funder - including reporting deliverables and their due dates.

## 10. Conclusion
150-200 words restating the request, the population served, the headline
targets, and the school's readiness to execute on award.

MARKDOWN DISCIPLINE - the document is typeset directly from your output
- Tables: a header row, a `---` separator row, and pipe-delimited cells.
  Keep cells short; no line breaks inside a cell.
- Nested bullets: indent sub-items by exactly two spaces under their
  parent. Do not use nesting deeper than two levels.
- A list item is one line. If an item needs a second thought, make it an
  indented sub-bullet - never a bare wrapped line.
- Use **bold** for lead-ins inside list items and *italic* for emphasis.
  Both render; do not use ALL CAPS for emphasis.
- Currency as $1,234,567. Percentages as 42%. Never write "$1.2M".
- No emoji, no horizontal rules, no decorative separators, no ASCII art,
  no code fences.

WRITING RULES
- Active voice. Concrete nouns. Specific numbers. No filler.
- Never use "transformative", "synergistic", "cutting-edge", "world-class",
  "robust ecosystem", or "leverage" as a verb.
- Vary the evidence. Do not restate the same demographic percentage in
  more than three sections; use the derived student counts, the grade
  band, and the enrolment scale to carry the rest.
- Match facts to the upstream drafts. Do not change demographic counts,
  budget figures, or outcomes the Budget/Narrative agents committed to.
  On conflict, prefer Budget figures for money and Narrative figures for
  population and outcomes.

INTERNAL REVIEW IS NOT PART OF THE DELIVERABLE - ABSOLUTE
The Compliance and Intelligence drafts are internal QA notes to you. The
reviewer must never see them. Specifically:
- Never write that a section was "flagged", "reviewed", "scored", or
  "questioned" internally.
- Never surface an arithmetic inconsistency as a risk. If the budget
  lines do not sum to the requested amount, RESOLVE IT: use the Budget
  agent's line items and make the TOTAL row equal the requested amount,
  adjusting the largest category by the difference and noting the basis
  in that category's budget narrative paragraph.
- Never mention word counts, compliance scores, or this pipeline.
- Compliance findings about tone, missing content, or unsupported claims
  are instructions to fix the text, not content to print.

DATA RULES - ABSOLUTE
1. Use only the demographics, programs and enrolment figures provided,
   plus counts arithmetically derived from them.
2. Use the school's actual name throughout - never "the school" as a
   substitute for the first mention in a section.
3. Never reference past projects, awards, partnerships, vendors or named
   individuals the school context does not document.
4. Where a figure would strengthen the case but is not on record, write
   the placeholder "to be established in Q1 baseline collection" rather
   than an estimate.
5. Word target: 3,200-4,200 words across the full document, excluding
   tables. Every section listed above must be present at its stated
   length. Do not stop early; do not pad.
"""


def build_writer_user_prompt(
    *,
    selected_grant: RankedGrant | None,
    selected_foundation: FoundationProspect | None = None,
    school_context: str,
    grant_purpose: str,
    target_amount_usd: int,
    school_name: str,
    typed_outputs: dict[str, BaseModel],
    raw_outputs: dict[str, str],
) -> str:
    narrative_text = _previous_output(typed_outputs, raw_outputs, "narrative")
    budget_text = _previous_output(typed_outputs, raw_outputs, "budget")
    compliance_text = _previous_output(typed_outputs, raw_outputs, "compliance")
    intelligence_text = _previous_output(typed_outputs, raw_outputs, "intelligence")

    return (
        f"{_format_target(selected_grant, selected_foundation)}\n"
        f"PROJECT PURPOSE: {grant_purpose}\n"
        f"REQUESTED AMOUNT (use exactly this figure in the header, the "
        f"abstract, and the budget TOTAL row): ${target_amount_usd:,}\n"
        f"APPLICANT: {school_name}\n\n"
        f"SCHOOL CONTEXT:\n{school_context}\n\n"
        "SOURCE DRAFTS - these are the substance of the application. "
        "Expand them to full submission length; do not contradict their "
        "figures.\n\n"
        f"--- NARRATIVE (source) ---\n{narrative_text}\n\n"
        f"--- BUDGET (source, authoritative for all money) ---\n{budget_text}\n\n"
        "INTERNAL QA NOTES - for your correction only. Nothing below this "
        "line may appear, be paraphrased, or be alluded to in the "
        "deliverable. Treat every finding as an instruction to fix the "
        "text before you write it.\n\n"
        f"--- COMPLIANCE (internal) ---\n{compliance_text}\n\n"
        f"--- INTELLIGENCE (internal) ---\n{intelligence_text}\n\n"
        "Return the full markdown application now, all ten sections, at "
        "full length."
    )


# =====================================================================
# Compliance agent â€” deterministic checks + LLM narrative review
# =====================================================================

# A compact JSON shape so the model knows the exact schema. Mirrors
# :class:`v2.schemas.ComplianceOutput`.
_COMPLIANCE_JSON_SHAPE = json.dumps(
    {
        "overall_status": "pass | needs_revision | fail",
        "score_percent": 0,
        "findings": [
            {
                "category": "eligibility | narrative | budget | format | anti_fabrication",
                "severity": "info | warning | blocker",
                "requirement": "short rule name",
                "status": "pass | fail | needs_review",
                "detail": "1-3 sentence explanation with concrete evidence.",
            }
        ],
    },
    indent=2,
)


COMPLIANCE_SYSTEM_PROMPT = """\
You are the Compliance reviewer on a grant-writing team. You audit the
in-progress application against federal review criteria and return a
structured findings report.

You will be given PRE-COMPUTED DETERMINISTIC FACTS in the user message â€”
word counts per section, budget arithmetic, demographic snapshot,
deadline check, and section-presence checks. Your job is to:

1. Faithfully convert each deterministic fact into one finding. Do not
   alter the numbers. Do not editorialise pass/fail beyond what the
   facts say.
2. Add LLM-level judgments where prose review is required: asset-based
   tone, plausibility of justifications, fabrication detection, and
   internal consistency between Narrative and Budget.
3. Tie every finding to a specific draft section and a specific
   requirement. Vague findings ("the proposal is strong") are forbidden.

OUTPUT FORMAT
You return STRICT JSON ONLY â€” no markdown, no prose, no code fences. The
JSON must validate against this shape:

""" + _COMPLIANCE_JSON_SHAPE + """

SEVERITY GUIDANCE
- ``blocker``  : the application cannot be submitted as written
                 (missing required section, ineligible school, deadline
                 passed, budget total mismatch the writer cannot fix).
- ``warning``  : the application is likely to lose points if submitted
                 unchanged (band drift, weak justification, demographic
                 mismatch, tone issues).
- ``info``     : observation worth surfacing but not penalty-worthy.

STATUS GUIDANCE
- ``pass``         : the requirement is met as written.
- ``needs_review`` : a human should look at this before submission.
- ``fail``         : the requirement is not met; revision is required.

SCORING
``score_percent`` is the share of findings with status ``pass`` weighted
by severity (blocker = 3, warning = 2, info = 1). Round to integer.

ANTI-FABRICATION
- Do not invent regulations or section numbers. If you do not know the
  CFR citation, do not cite one.
- Do not claim findings the deterministic facts do not support.
- Return findings only for what is actually in the drafts.

Return only the JSON object. No prose. No fences.
"""


def _word_count(text: str) -> int:
    return len([w for w in text.split() if w.strip()])


def _section_word_counts(narrative_text: str) -> dict[str, int]:
    """Best-effort per-heading word counts for a markdown narrative.

    Splits on markdown headings (``#``, ``##``) and counts non-blank
    words per chunk. Returns ``{heading: word_count}``.
    """

    import re as _re

    if not narrative_text or not narrative_text.strip():
        return {}
    parts: dict[str, list[str]] = {}
    current = "(preamble)"
    parts[current] = []
    for line in narrative_text.splitlines():
        m = _re.match(r"^#{1,3}\s+(.*?)\s*$", line)
        if m:
            current = m.group(1).strip()
            parts.setdefault(current, [])
            continue
        parts[current].append(line)
    return {k: _word_count(" ".join(v)) for k, v in parts.items() if k != "(preamble)"}


# Sections the Writer must include in the final document, by heading
# substring. Used for both the Writer's compliance check and for the
# Compliance agent's pre-checks of the *narrative* draft.
_NARRATIVE_REQUIRED_SECTIONS: tuple[str, ...] = (
    "Needs Assessment",
    "Current situation",
    "The opportunity",
    "Community context",
    "Theory of Change",
    "Target population",
    "Expected outcomes",
)


def _narrative_section_check(narrative_text: str) -> list[str]:
    """Return human-readable lines flagging missing required headings."""

    missing: list[str] = []
    lowered = narrative_text.lower()
    for needed in _NARRATIVE_REQUIRED_SECTIONS:
        if needed.lower() not in lowered:
            missing.append(needed)
    return missing


def _budget_arithmetic_check(budget: BudgetOutput | None) -> dict[str, object]:
    """Return a dict of arithmetic facts about the budget for the prompt.

    All values are deterministic; the LLM will turn them into findings.
    """

    if budget is None:
        return {
            "parsed": False,
            "note": "Budget JSON did not parse â€” agent should flag as a blocker.",
        }
    line_sum = round(sum(l.amount_usd for l in budget.lines), 2)
    drift = round(line_sum - budget.total_usd, 2)
    by_group: dict[str, float] = {}
    for group, cats in BudgetOutput._CATEGORY_GROUPS.items():
        by_group[group] = round(
            sum(l.amount_usd for l in budget.lines if l.category in cats), 2
        )
    pct_by_group = {
        g: (round((amt / budget.total_usd) * 100.0, 1) if budget.total_usd else 0.0)
        for g, amt in by_group.items()
    }
    return {
        "parsed": True,
        "total_usd": budget.total_usd,
        "line_sum_usd": line_sum,
        "drift_usd": drift,
        "line_count": len(budget.lines),
        "amount_by_group_usd": by_group,
        "amount_by_group_pct": pct_by_group,
        "band_targets_pct": dict(BudgetOutput._BANDS),
        "notes_from_validator": budget.notes,
    }


def _demographic_consistency_check(
    narrative_text: str,
    school_context: str,
) -> dict[str, object]:
    """Pull every percentage and integer-like count appearing in the
    narrative, then flag any that do not also appear in the
    ``school_context`` block.
    """

    import re as _re

    if not narrative_text:
        return {"checked": False}
    # Numbers in the narrative (percentages and 3-6 digit counts).
    narrative_nums = set(_re.findall(r"\b\d{1,3}\s?%|\b\d{3,6}\b", narrative_text))
    context_blob = school_context or ""
    suspicious = sorted(n for n in narrative_nums if n.strip() not in context_blob)
    return {
        "checked": True,
        "narrative_numbers_found": sorted(narrative_nums),
        "numbers_not_in_school_context": suspicious,
        "interpretation": (
            "Numbers in 'numbers_not_in_school_context' may be fabricated "
            "or derived. Flag any that look like demographic claims."
        ),
    }


def _deadline_check(selected_grant: RankedGrant | None) -> dict[str, object]:
    """Crude deadline check â€” programmatic compliance for one obvious rule."""

    from datetime import UTC, date, datetime

    if selected_grant is None or not selected_grant.deadline_iso:
        return {"checked": False}
    try:
        deadline = date.fromisoformat(selected_grant.deadline_iso)
    except Exception:
        return {"checked": False, "raw_deadline": selected_grant.deadline_iso}
    # UTC, not the server's local zone: the deadline is a federal date and the
    # container's timezone must not shift the remaining-days count.
    today = datetime.now(UTC).date()
    days = (deadline - today).days
    return {
        "checked": True,
        "deadline_iso": selected_grant.deadline_iso,
        "days_until_deadline": days,
        "passed": days < 0,
    }


def build_compliance_user_prompt(
    *,
    selected_grant: RankedGrant | None,
    selected_foundation: FoundationProspect | None = None,
    school_context: str,
    typed_outputs: dict[str, BaseModel],
    raw_outputs: dict[str, str],
) -> str:
    narrative_text = raw_outputs.get("narrative", "") or ""
    budget = typed_outputs.get("budget")
    # Restrict to BudgetOutput to keep type-checkers happy.
    budget_obj = budget if isinstance(budget, BudgetOutput) else None

    word_counts = _section_word_counts(narrative_text)
    missing_sections = _narrative_section_check(narrative_text)
    budget_facts = _budget_arithmetic_check(budget_obj)
    demo_facts = _demographic_consistency_check(narrative_text, school_context)
    deadline_facts = _deadline_check(selected_grant)

    facts_block = json.dumps(
        {
            "narrative_word_counts_by_heading": word_counts,
            "narrative_missing_required_sections": missing_sections,
            "budget": budget_facts,
            "demographics": demo_facts,
            "deadline": deadline_facts,
        },
        indent=2,
        default=str,
    )

    raw_budget_text = raw_outputs.get("budget", "(not yet produced)")

    return (
        f"{_format_target(selected_grant, selected_foundation)}\n"
        f"SCHOOL CONTEXT:\n{school_context}\n\n"
        "PRE-COMPUTED DETERMINISTIC FACTS (use these verbatim; convert each "
        "into one finding):\n"
        f"{facts_block}\n\n"
        f"--- NARRATIVE DRAFT (for tone, asset-based framing, internal "
        f"consistency review) ---\n{narrative_text}\n\n"
        f"--- BUDGET DRAFT (raw JSON for cross-check against the parsed "
        f"facts above) ---\n{raw_budget_text}\n\n"
        "Produce the strict-JSON ComplianceOutput now. Include findings for "
        "every deterministic fact above plus 2-4 LLM-level findings on "
        "tone, asset-based framing, and narrative-budget consistency."
    )


# =====================================================================
# Intelligence agent â€” base-rate-anchored success assessment
# =====================================================================

# Anchors for the Intelligence agent's qualitative band.
#
# A previous version of this table asserted that every number came from
# "publicly reported ED.gov / NSF historical funding rates". That was not
# true, and two entries were worse than unsourced: Title IV-A and school
# improvement are FORMULA grants (ED.gov lists both under Formula Grants,
# with State Educational Agencies as the eligible applicant and application
# status "Not Applicable"). Quoting a competitive funding rate for them
# invented a statistic for a competition that does not exist, on a program a
# school cannot apply to directly. Each entry now carries its provenance,
# and ``verified`` is False whenever the number is our own planning estimate
# rather than a published statistic.


@dataclass(frozen=True)
class BaseRate:
    pct_range: str
    basis: str
    verified: bool
    source: str


_FORMULA_NOT_APPLICABLE = "not applicable - formula grant"

FEDERAL_BASE_RATES: dict[str, BaseRate] = {
    "title_iv_a": BaseRate(
        pct_range=_FORMULA_NOT_APPLICABLE,
        basis=(
            "Title IV-A Student Support and Academic Enrichment is a formula grant to "
            "State Educational Agencies, which subgrant to districts; there is no "
            "competitive funding rate and a school does not apply to ED directly."
        ),
        verified=True,
        source="https://www.ed.gov/grants-and-programs/formula-grants/school-improvement-grants/student-support-and-academic-enrichment-program-title-iv-part",
    ),
    "formula_school_improvement": BaseRate(
        pct_range=_FORMULA_NOT_APPLICABLE,
        basis=(
            "ED lists school-improvement funding under formula grants allocated through "
            "the states; the separate competitive School Improvement Grant program under "
            "ESEA section 1003(g) no longer runs."
        ),
        verified=True,
        source="https://www.ed.gov/grants-and-programs/formula-grants/school-improvement",
    ),
    "ed_small": BaseRate(
        pct_range="20-35%",
        basis="Planning estimate for ED discretionary competitions under $250,000.",
        verified=False,
        source="",
    ),
    "ed_medium": BaseRate(
        pct_range="12-20%",
        basis="Planning estimate for ED discretionary competitions between $250,000 and $1M.",
        verified=False,
        source="",
    ),
    "nsf_drk12": BaseRate(
        pct_range="8-15%",
        basis="Planning estimate for NSF Discovery Research PreK-12; NSF does not publish a per-programme rate on the solicitation page.",
        verified=False,
        source="",
    ),
    "private_foundation": BaseRate(
        pct_range="10-25%",
        basis="Planning estimate for private K-12 education foundations; varies widely by funder.",
        verified=False,
        source="",
    ),
    "fallback": BaseRate(
        pct_range="15-30%",
        basis="Planning estimate for small-to-mid competitive K-12 federal grants.",
        verified=False,
        source="",
    ),
}


def _infer_base_rate_key(g: RankedGrant | None) -> str:
    """Crude classifier mapping a RankedGrant to a base-rate bucket."""

    if g is None:
        return "fallback"
    blob = f"{g.funder} {g.title} {g.summary}".lower()
    if "title iv" in blob or "iv-a" in blob or "student support and academic enrichment" in blob:
        return "title_iv_a"
    if "school improvement" in blob or "title i sig" in blob:
        return "formula_school_improvement"
    if "national science foundation" in blob or "nsf" in g.funder.lower() or "drk-12" in blob:
        return "nsf_drk12"
    if g.source == "other" or "foundation" in g.funder.lower():
        return "private_foundation"
    # Federal default - bucket by amount band.
    high = g.amount_high_usd or 0
    if high and high < 250_000:
        return "ed_small"
    if high and high < 1_000_000:
        return "ed_medium"
    return "fallback"


_INTELLIGENCE_JSON_SHAPE = json.dumps(
    {
        "probability_band": "weak | moderate | strong",
        "base_rate_pct_range": "e.g. '20-35%'",
        "base_rate_basis": "one-sentence citation of the federal grant family.",
        "success_probability": "integer 0-100, or null when there is no competitive rate",
        "competitive_advantages": ["2-4 items grounded in the school context or selected_grant.pros"],
        "risks": ["2-4 items grounded in selected_grant.cons or the budget/narrative drafts"],
        "suggested_revisions": ["2-4 concrete revision asks for the writer"],
    },
    indent=2,
)


INTELLIGENCE_SYSTEM_PROMPT = """\
You are the Intelligence reviewer on a grant-writing team. You give the
writer an honest, base-rate-anchored read on the likelihood of funding.

YOU DO NOT HAVE ACCESS TO:
- a corpus of past awards or proposals;
- historical funding decisions for this specific school;
- the funder's internal scoring rubric.

You DO have:
- the funder's published base rate for this grant family (in the user
  message);
- the school context;
- the Narrative, Budget (typed), and Compliance drafts;
- the selected grant's rubric-ranked pros and cons.

Use only those. Never claim the school "funded XX similar projects" or
that you have "analysed N prior awards". Both are fabrications.

OUTPUT FORMAT
You return STRICT JSON ONLY â€” no markdown, no prose, no code fences. The
JSON must validate against this shape:

""" + _INTELLIGENCE_JSON_SHAPE + """

BAND DEFINITIONS (anchored to the federal base rate in the user prompt)
- ``strong``   : the application is in the top tertile of the base-rate
                 range (e.g. 30-35% when the base rate is 20-35%).
                 Use when most pros are realised in the drafts, the
                 Compliance pass is clean, and the budget is defensible.
- ``moderate`` : the application is mid-band. Use as the default unless
                 strong evidence supports otherwise.
- ``weak``     : the application sits below the base-rate band's low
                 edge. Use when multiple cons are unaddressed, the
                 Compliance pass has blockers, or the budget is
                 implausible.

SUCCESS_PROBABILITY
Set to the midpoint of the band's pct range, rounded to an integer:
weak ~= 12, moderate ~= 28, strong ~= 45 (a downstream validator will
snap if you drift far from these).

COMPETITIVE ADVANTAGES, RISKS, REVISIONS
- Advantages: 2-4 items. Each must reference a specific school fact OR
  a specific entry from selected_grant.pros.
- Risks: 2-4 items. Each must reference a specific entry from
  selected_grant.cons OR a specific weakness in the narrative/budget.
- Revisions: 2-4 items. Each is one sentence the writer can act on
  ("Add a one-sentence sustainability plan to the Budget section",
  "Move the equity outcomes earlier in Needs Assessment").

ANTI-FABRICATION
- Do not invent past projects, alumni outcomes, awards, or partnerships
  the school context does not document.
- Do not name a peer school's outcome as evidence.
- If the data is thin, say so qualitatively rather than inventing
  precision.

Return only the JSON object. No prose. No fences.
"""


def build_intelligence_user_prompt(
    *,
    selected_grant: RankedGrant | None,
    selected_foundation: FoundationProspect | None = None,
    school_context: str,
    typed_outputs: dict[str, BaseModel],
    raw_outputs: dict[str, str],
) -> str:
    base_key = _infer_base_rate_key(selected_grant)
    base = FEDERAL_BASE_RATES[base_key]

    if base.pct_range == _FORMULA_NOT_APPLICABLE:
        provenance = (
            "  provenance:          This programme has no competitive funding rate. "
            "Do NOT state a percentage chance of winning: set ``success_probability`` "
            "to null. Explain the formula mechanism instead and judge readiness, "
            "not odds.\n"
            f"  source:              {base.source}\n"
        )
    elif base.verified:
        provenance = f"  provenance:          Published figure. Source: {base.source}\n"
    else:
        provenance = (
            "  provenance:          INTERNAL PLANNING ESTIMATE, not a published "
            "statistic. Describe it as an internal estimate. Do NOT attribute it "
            "to the Department of Education, to NSF, or to any agency.\n"
        )

    narrative_text = _previous_output(typed_outputs, raw_outputs, "narrative")
    budget_text = _previous_output(typed_outputs, raw_outputs, "budget")
    compliance_text = _previous_output(typed_outputs, raw_outputs, "compliance")

    return (
        f"{_format_target(selected_grant, selected_foundation)}\n"
        f"SCHOOL CONTEXT:\n{school_context}\n\n"
        "BASE RATE FOR THIS GRANT FAMILY (anchor your band here):\n"
        f"  base_rate_pct_range: {base.pct_range}\n"
        f"  base_rate_basis:     {base.basis}\n"
        f"{provenance}\n"
        f"--- NARRATIVE ---\n{narrative_text}\n\n"
        f"--- BUDGET ---\n{budget_text}\n\n"
        f"--- COMPLIANCE ---\n{compliance_text}\n\n"
        "Produce the strict-JSON IntelligenceOutput now. Use the base rate "
        "above verbatim in ``base_rate_pct_range`` and a tight one-sentence "
        "version of ``base_rate_basis`` that preserves the provenance wording."
    )


# =====================================================================
# Helper for the agent registry
# =====================================================================


__all__: Iterable[str] = (
    "BUDGET_SYSTEM_PROMPT",
    "COMPLIANCE_SYSTEM_PROMPT",
    "FEDERAL_BASE_RATES",
    "INTELLIGENCE_SYSTEM_PROMPT",
    "NARRATIVE_SYSTEM_PROMPT",
    "WRITER_SYSTEM_PROMPT",
    "build_budget_user_prompt",
    "build_compliance_user_prompt",
    "build_intelligence_user_prompt",
    "build_narrative_user_prompt",
    "build_writer_user_prompt",
)

