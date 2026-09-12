"""
Structured outputs for v2 agents.

These Pydantic models describe the *shape* of each agent's contribution to
the application. In v2, downstream agents receive the typed model — not a
free-form string — which dramatically reduces parsing logic and makes the
pipeline easy to test.

For Phase 1 we accept *either* a structured object or a raw markdown string
from the model, depending on the agent. Strict structured-output enforcement
(via JSON schema) is wired in :class:`v2.agents.AgentSpec` for the agents
that benefit most from it (Budget, Compliance, Intelligence).
"""

from __future__ import annotations

from typing import ClassVar, Literal

from pydantic import BaseModel, Field, model_validator

# --------------------------------------------------------------------- Discovery


class GrantMatch(BaseModel):
    """One grant matched to the school by the Discovery agent (legacy)."""

    title: str
    funder: str
    amount_usd: str = Field(description="Award range or total, formatted for display")
    deadline_text: str
    fit_score: int = Field(ge=0, le=100, description="0–100 match score")
    rationale: str
    source: str = Field(description="grants.gov | ed.gov | k12grants | state-portal | foundation")


class DiscoveryOutput(BaseModel):
    """Discovery agent — top grant matches and selected target (legacy v2 shape).

    Retained for backward compatibility with the original combined workflow.
    New code should use :class:`DiscoveryRanking`.
    """

    summary: str
    matches: list[GrantMatch] = Field(default_factory=list)
    recommended_target: GrantMatch | None = None


# ------------------------------------------------------ Discovery rubric (HITL)


class RubricScore(BaseModel):
    """Transparent 100-point breakdown for one ranked grant.

    Weights are fixed and documented in the user-facing methodology tooltip
    so reviewers can audit every selection decision.
    """

    eligibility_fit: int = Field(ge=0, le=25, description="Hard match on type, state, grades, Title I, geography.")
    mission_alignment: int = Field(ge=0, le=20, description="Match to the school's stated purpose and existing programs.")
    demographic_resonance: int = Field(ge=0, le=15, description="Whether the funder prioritises this school's demographic profile.")
    award_size_fit: int = Field(ge=0, le=10, description="Is the award range realistic for the school's capacity?")
    competition_odds: int = Field(ge=0, le=10, description="Estimated funding rate for this grant family.")
    timeline_feasibility: int = Field(ge=0, le=10, description="Days to deadline vs. application complexity.")
    sustainability_potential: int = Field(ge=0, le=5, description="Multi-year, renewable, or follow-on potential.")
    strategic_upside: int = Field(ge=0, le=5, description="Door-opener for future funder relationships.")

    @property
    def total(self) -> int:
        return (
            self.eligibility_fit
            + self.mission_alignment
            + self.demographic_resonance
            + self.award_size_fit
            + self.competition_odds
            + self.timeline_feasibility
            + self.sustainability_potential
            + self.strategic_upside
        )


Confidence = Literal["high", "medium", "low"]


class RankedGrant(BaseModel):
    """One grant ranked for human review.

    The ``id`` is stable for the lifetime of one Discovery run; the frontend
    echoes it back when the user makes a selection.
    """

    id: str = Field(description="Stable client identifier for this candidate within a single run.")
    rank: int = Field(ge=1, le=10)
    title: str
    funder: str
    source: Literal["grants.gov", "ed.gov", "k12grants", "state-portal", "foundation", "other"]
    url: str | None = None
    amount_text: str = Field(description="Human-readable award range, e.g. '$50,000 – $250,000'.")
    amount_low_usd: int | None = Field(default=None, ge=0)
    amount_high_usd: int | None = Field(default=None, ge=0)
    deadline_text: str
    deadline_iso: str | None = Field(default=None, description="ISO-8601 date if known.")
    summary: str = Field(description="One- to two-sentence neutral summary of the grant itself.")
    score: RubricScore
    score_total: int = Field(ge=0, le=100, description="Sum of rubric dimensions. Validated to match.")
    pros: list[str] = Field(description="Exactly three concrete, school-specific positives.")
    cons: list[str] = Field(description="Exactly two honest trade-offs or risks.")
    why_this_rank: str = Field(description="One sentence tying the score to the specific school.")
    confidence: Confidence = Field(description="Confidence in the ranking given input data completeness.")

    @model_validator(mode="after")
    def _check_score_and_lists(self) -> RankedGrant:
        # Score sum must match the dimensions.
        if self.score_total != self.score.total:
            # Auto-correct silently — the model is a stochastic source.
            object.__setattr__(self, "score_total", self.score.total)
        # Enforce list sizes; trim or pad rather than failing the whole pipeline.
        if len(self.pros) > 3:
            object.__setattr__(self, "pros", self.pros[:3])
        if len(self.cons) > 2:
            object.__setattr__(self, "cons", self.cons[:2])
        return self


class DisqualifiedGrant(BaseModel):
    """A grant rejected before scoring, with a one-line reason."""

    title: str
    funder: str = ""
    reason: str = Field(description="Short reason code, e.g. 'Deadline passed', 'State mismatch', 'Generic landing page'.")


class FoundationFinancials(BaseModel):
    """Selected fields from the foundation's latest available IRS Form 990
    (or 990-PF / 990-EZ) as exposed by ProPublica Nonprofit Explorer.

    All amounts are USD. Fields are ``None`` when ProPublica has no
    machine-readable filing for that line item; the UI should display a
    "not reported" affordance rather than a zero.
    """

    latest_year: int | None = None
    form_type: str | None = Field(default=None, description="'990', '990-PF', or '990-EZ' inferred from the filing PDF name.")
    total_assets_usd: int | None = None
    total_revenue_usd: int | None = None
    total_expenses_usd: int | None = None
    grants_paid_annual_usd: int | None = Field(
        default=None,
        description="Best estimate of annual grants paid (PF: charitable disbursements; 990: grants paid out).",
    )
    estimated_avg_grant_usd: int | None = Field(
        default=None,
        description="Rough estimate when number-of-grants is not exposed; otherwise None.",
    )
    pdf_url: str | None = Field(default=None, description="Direct link to the original IRS Form 990 PDF on ProPublica.")
    years_on_record: int = 0


class FoundationScoreBreakdown(BaseModel):
    """Per-factor score for a foundation prospect, summing to ``score``."""

    capacity: int = Field(ge=0, le=25, description="Asset size: bigger funder = bigger possible check.")
    activity: int = Field(ge=0, le=20, description="Recent annual grants paid: are they actively writing checks?")
    recency: int = Field(ge=0, le=10, description="How fresh is the latest filing?")
    geographic_fit: int = Field(ge=0, le=20, description="State / region alignment with the school.")
    focus_fit: int = Field(ge=0, le=15, description="NTEE focus vs the school's funding intent.")
    scale_fit: int = Field(ge=0, le=10, description="Typical grant size vs what the school can absorb.")


class FoundationProspect(BaseModel):
    """A private 501(c)(3) education foundation surfaced as a rolling
    prospect (not a posted RFP) from public ProPublica 990 data.

    Foundations are NOT scored by the rubric LLM (the rubric is built
    for posted RFPs with deadlines and award ranges). They get their own
    deterministic ``Funder fit`` score computed from the most recent
    IRS Form 990 — capacity, recent giving activity, recency, geo fit,
    focus fit, and typical-grant-size fit.
    """

    id: str
    name: str
    focus: str = Field(description="Human label for the foundation's NTEE focus, e.g. 'Scholarships & student aid'.")
    city: str | None = None
    state: str | None = None
    ein: str = Field(description="9-digit IRS Employer Identification Number, hyphenated for display.")
    url: str = Field(description="Public ProPublica Nonprofit Explorer detail page.")
    note: str = Field(
        default="Foundation prospect from public Form 990 data — verify open programs on the funder's own website before applying.",
    )
    # ---- Funder fit ranking (Phase H.2) ----------------------------------
    rank: int | None = Field(default=None, description="1-based rank within the prospect rail (after scoring).")
    score: int = Field(default=0, ge=0, le=100, description="Funder fit score 0-100.")
    score_breakdown: FoundationScoreBreakdown | None = None
    confidence: Literal["high", "medium", "low"] = Field(
        default="low",
        description="Data confidence — 'low' when ProPublica has no 990 financials on file.",
    )
    pros: list[str] = Field(default_factory=list, description="Up to 3 reasons this funder is a good prospect.")
    cons: list[str] = Field(default_factory=list, description="Up to 3 honest caveats or unknowns.")
    risk_flags: list[str] = Field(
        default_factory=list,
        description="Hard concerns: 'No filings on record', 'Out-of-state', 'Declining assets', etc.",
    )
    likely_give_range_usd: dict[str, int] | None = Field(
        default=None,
        description='Best-effort {"low": int, "high": int} estimate of what a school in this funder\'s region/focus might realistically receive.',
    )
    financials: FoundationFinancials | None = None
    recommended_next_step: str = Field(
        default="Visit the funder's own website; if no application portal, send a 1-2 page Letter of Inquiry (LOI) introducing the school.",
        description="Concrete action the grant coordinator should take next.",
    )


class DiscoveryRanking(BaseModel):
    """Full structured output of the rubric-based Discovery agent.

    This is what the HITL grant-picker UI consumes.
    """

    summary: str = Field(description="Two- to three-sentence overview of the search itself.")
    total_grants_searched: int = Field(ge=0)
    sources: dict[str, int] = Field(default_factory=dict)
    top_grants: list[RankedGrant] = Field(description="Up to 5 ranked candidates, ordered by score_total descending.")
    disqualified: list[DisqualifiedGrant] = Field(default_factory=list)
    rubric_explanation: str = Field(description="Short methodology summary shown in the UI tooltip.")
    foundation_prospects: list[FoundationProspect] = Field(
        default_factory=list,
        description="Private 501(c)(3) education foundations surfaced as rolling prospects (not rubric-ranked).",
    )

    @model_validator(mode="after")
    def _enforce_top5(self) -> DiscoveryRanking:
        # Trim to five and re-sort defensively.
        ranked = sorted(self.top_grants, key=lambda g: g.score_total, reverse=True)[:5]
        # Re-number rank field to match displayed order.
        for i, g in enumerate(ranked, start=1):
            if g.rank != i:
                object.__setattr__(g, "rank", i)
        object.__setattr__(self, "top_grants", ranked)
        return self


# --------------------------------------------------------------------- Narrative


class NarrativeOutput(BaseModel):
    """Narrative agent — needs assessment and theory of change."""

    needs_assessment: str
    theory_of_change: str
    target_population_summary: str
    expected_outcomes: list[str] = Field(default_factory=list)


# --------------------------------------------------------------------- Budget


BudgetCategory = Literal[
    "personnel",
    "fringe_benefits",
    "equipment",
    "supplies",
    "training",
    "travel",
    "contractual",
    "indirect",
    "other",
]


class BudgetLine(BaseModel):
    category: BudgetCategory
    description: str
    amount_usd: float = Field(ge=0)
    justification: str


class BudgetOutput(BaseModel):
    """Structured budget with self-correcting validators.

    Two invariants are enforced at parse time:

    1. **Sum integrity** — ``sum(lines.amount_usd)`` must equal ``total_usd``
       within one dollar. Drift is silently corrected (the line items are
       the source of truth) so a small rounding error from the model does
       not abort the workflow. Larger drift is appended to ``notes`` as a
       warning the Compliance agent can surface.

    2. **Category bands** — federal K-12 reviewers expect a recognisable
       allocation pattern. Lines outside the bands are not rejected
       (program economics vary widely), but a one-line audit string is
       appended to ``notes`` so downstream agents and the UI can flag it.

    Bands (% of ``total_usd``):

    +-----------------------+-------+
    | Personnel + fringe    | 15-35 |
    | Equipment + supplies  | 20-50 |
    | Training (PD)         |  8-20 |
    | Travel                |  0-10 |
    | Contractual + indirect|  0-20 |
    +-----------------------+-------+
    """

    total_usd: float = Field(ge=0)
    lines: list[BudgetLine]
    notes: str = ""

    # Category percentage bands. ``None`` means "no upper bound enforced".
    _BANDS: ClassVar[dict[str, tuple[float, float]]] = {
        "personnel+fringe": (15.0, 35.0),
        "equipment+supplies": (20.0, 50.0),
        "training": (8.0, 20.0),
        "travel": (0.0, 10.0),
        "contractual+indirect": (0.0, 20.0),
    }

    _CATEGORY_GROUPS: ClassVar[dict[str, tuple[str, ...]]] = {
        "personnel+fringe": ("personnel", "fringe_benefits"),
        "equipment+supplies": ("equipment", "supplies"),
        "training": ("training",),
        "travel": ("travel",),
        "contractual+indirect": ("contractual", "indirect"),
    }

    @model_validator(mode="after")
    def _check_sum_and_bands(self) -> BudgetOutput:
        line_sum = round(sum(l.amount_usd for l in self.lines), 2)
        warnings: list[str] = []

        # ---------------------------------------------------- sum integrity
        if self.lines:
            drift = round(line_sum - self.total_usd, 2)
            if abs(drift) <= 1.0:
                # Trivial rounding — snap silently.
                object.__setattr__(self, "total_usd", line_sum)
            else:
                # Meaningful drift — trust the line items and warn.
                warnings.append(
                    f"Budget total auto-corrected from ${self.total_usd:,.0f} "
                    f"to ${line_sum:,.0f} (line items are source of truth; "
                    f"drift was ${drift:+,.0f})."
                )
                object.__setattr__(self, "total_usd", line_sum)

        # ---------------------------------------------------- category bands
        if self.total_usd > 0:
            for group, (lo, hi) in self._BANDS.items():
                cats = self._CATEGORY_GROUPS[group]
                amt = sum(l.amount_usd for l in self.lines if l.category in cats)
                pct = (amt / self.total_usd) * 100.0
                if pct < lo or pct > hi:
                    warnings.append(
                        f"{group.replace('+', ' + ')} is {pct:.1f}% of budget "
                        f"(typical range {lo:.0f}-{hi:.0f}%)."
                    )

        if warnings:
            existing = self.notes.rstrip()
            audit = "Budget audit:\n- " + "\n- ".join(warnings)
            merged = f"{existing}\n\n{audit}" if existing else audit
            object.__setattr__(self, "notes", merged)

        return self


# --------------------------------------------------------------------- Compliance


ComplianceCategory = Literal[
    "eligibility",       # State, type, grades, Title I, deadline
    "narrative",         # Section presence, word-count bands, demographic consistency
    "budget",            # Sum integrity, category bands, line-justification quality
    "format",            # Required sections, headings, required attachments referenced
    "anti_fabrication",  # Use of school data only; no invented stats or vendors
]


class ComplianceFinding(BaseModel):
    """One concrete check, traceable to a specific requirement."""

    category: ComplianceCategory = Field(
        default="narrative",
        description="Which review dimension the finding belongs to.",
    )
    severity: Literal["info", "warning", "blocker"]
    requirement: str = Field(
        description="Short name of the rule being checked (e.g. 'Budget arithmetic', 'Demographic match')."
    )
    status: Literal["pass", "fail", "needs_review"]
    detail: str = Field(
        description="One- to three-sentence explanation referencing concrete evidence from the drafts."
    )


class ComplianceOutput(BaseModel):
    """Reviewer-style audit of the in-progress application.

    The Compliance agent is given pre-computed deterministic facts (word
    counts, budget sums, demographic snapshot, deadline check) in its
    user prompt and is asked to (a) faithfully report those checks as
    findings, and (b) add LLM-level judgments where prose review is
    required (tone, asset-based framing, plausible justifications).
    """

    overall_status: Literal["pass", "needs_revision", "fail"]
    score_percent: int = Field(ge=0, le=100)
    findings: list[ComplianceFinding]

    @model_validator(mode="after")
    def _normalise(self) -> ComplianceOutput:
        if not self.findings:
            return self
        has_blocker = any(f.severity == "blocker" or f.status == "fail" for f in self.findings)
        has_warning = any(
            f.severity == "warning" or f.status == "needs_review" for f in self.findings
        )
        # Auto-derive overall_status when the model contradicts its own findings.
        if has_blocker and self.overall_status == "pass":
            object.__setattr__(self, "overall_status", "fail")
        elif has_warning and self.overall_status == "pass":
            object.__setattr__(self, "overall_status", "needs_revision")
        return self


# ------------------------------------------------------------------ Intelligence


ProbabilityBand = Literal["weak", "moderate", "strong"]


class IntelligenceOutput(BaseModel):
    """Honest, base-rate-anchored success assessment.

    Federal funding rates vary by program family. The Intelligence agent
    is required to:

    * pick one qualitative band (``weak`` / ``moderate`` / ``strong``)
      anchored to the real funding-rate range for the selected grant
      family (provided in the prompt);
    * cite that base-rate range in ``base_rate_pct_range`` and explain
      it in ``base_rate_basis`` (one sentence);
    * never claim the school has "funded similar projects" or that the
      agent has analysed a corpus of past awards — the only inputs are
      the drafts of Narrative + Budget + Compliance.

    ``success_probability`` is retained as a coarse integer (midpoint of
    the band's pct range) for backwards-compatibility with v1 callers
    that display a single number, but ``probability_band`` is the
    canonical field for v2. It is null for formula grants, which have no
    competition and therefore no chance of winning to quote.
    """

    probability_band: ProbabilityBand = Field(
        description="weak | moderate | strong, anchored to federal base rates for this grant family.",
    )
    base_rate_pct_range: str = Field(
        description="e.g. '20-35%' — the real funding-rate range for this grant family.",
    )
    base_rate_basis: str = Field(
        description="One sentence citing the federal grant family this base rate applies to.",
    )
    success_probability: int | None = Field(
        default=None,
        ge=0,
        le=100,
        description=(
            "Midpoint of the band's pct range; coarse v1-compat single number. "
            "Null when the programme is a formula grant with no competitive rate."
        ),
    )
    competitive_advantages: list[str] = Field(
        description="2-4 advantages grounded in the school context and the selected_grant.pros.",
    )
    risks: list[str] = Field(
        description="2-4 risks grounded in the selected_grant.cons and the budget/narrative drafts.",
    )
    suggested_revisions: list[str] = Field(
        description="2-4 concrete, sentence-level revision asks for the writer agent.",
    )

    @model_validator(mode="after")
    def _bound_lists_and_align_probability(self) -> IntelligenceOutput:
        # Cap list lengths defensively.
        if len(self.competitive_advantages) > 4:
            object.__setattr__(self, "competitive_advantages", self.competitive_advantages[:4])
        if len(self.risks) > 4:
            object.__setattr__(self, "risks", self.risks[:4])
        if len(self.suggested_revisions) > 4:
            object.__setattr__(self, "suggested_revisions", self.suggested_revisions[:4])

        # Snap probability into the band's canonical midpoint when the
        # model returns an inconsistent integer.
        if self.success_probability is not None:
            band_midpoints = {"weak": 12, "moderate": 28, "strong": 45}
            target = band_midpoints[self.probability_band]
            if abs(self.success_probability - target) > 20:
                object.__setattr__(self, "success_probability", target)
        return self



# ---------------------------------------------------------------------- Writer


class ApplicationOutput(BaseModel):
    title: str
    abstract: str
    full_application_markdown: str
    word_count: int = Field(ge=0)
