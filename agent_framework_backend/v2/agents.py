"""
v2 agent definitions â€” the six specialists, expressed declaratively.

Each :class:`AgentSpec` is *static metadata* about one role in the
pipeline (key, name, system prompt, user-prompt builder, token budget).
At workflow build time the spec is bound to a concrete
:class:`agent_framework.Agent` via :func:`build_sdk_agents`.

Prompt builders are reused verbatim from :mod:`agents.prompts` so the
v2 pipeline produces output of the same calibre as v1.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field

from agent_framework import Agent as SdkAgent
from pydantic import BaseModel

# v1 prompts contain decorative emojis ("ðŸ” DISCOVERY COMPLETE", "ðŸ’° Amount").
# In the v2 surface we render output as consulting-grade typography, so we
# strip every pictographic codepoint at the prompt layer to stop the model
# from emitting them in the first place. v1 prompts are left untouched.
_EMOJI_RE = re.compile(
    "["
    "\U0001F000-\U0001FFFF"   # supplementary pictographs
    "\u2600-\u27BF"            # miscellaneous symbols + dingbats
    "\u2300-\u23FF"            # technical
    "\u2500-\u25FF"            # box drawing + geometric shapes
    "\u2B00-\u2BFF"            # arrows + extended shapes
    "\uFE00-\uFE0F"            # variation selectors
    "\u200D"                    # zero-width joiner
    "]",
    flags=re.UNICODE,
)


def _strip_emojis(text: str) -> str:
    """Remove pictographic glyphs and collapse whitespace they leave behind."""
    cleaned = _EMOJI_RE.sub("", text)
    # Collapse blank space left at the start of lines.
    cleaned = re.sub(r"^[ \t]+", "", cleaned, flags=re.MULTILINE)
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    return cleaned

# Reuse v1 prompt assets (untouched).
from config import GRANT_TYPES
from services.grants import Grant
from v2.prompts_discovery import (
    RANKED_DISCOVERY_SYSTEM_PROMPT,
    build_ranked_discovery_user_prompt,
)
from v2.prompts_generation import (
    BUDGET_SYSTEM_PROMPT,
    COMPLIANCE_SYSTEM_PROMPT,
    INTELLIGENCE_SYSTEM_PROMPT,
    NARRATIVE_SYSTEM_PROMPT,
    WRITER_SYSTEM_PROMPT,
    build_budget_user_prompt,
    build_compliance_user_prompt,
    build_intelligence_user_prompt,
    build_narrative_user_prompt,
    build_writer_user_prompt,
)
from v2.prompts_generation import _target_amount_usd as _midpoint_amount
from v2.router import ModelRouter
from v2.schemas import (
    ApplicationOutput,
    BudgetOutput,
    ComplianceOutput,
    DiscoveryRanking,
    FoundationProspect,
    IntelligenceOutput,
    NarrativeOutput,
    RankedGrant,
)
from v2.school import SchoolData, format_school_context

# A prompt builder takes the cumulative agent context and returns the user
# message string. Keeping it as a callable lets each agent compose its prompt
# from the previous agents' outputs without coupling to a global state object.
PromptBuilder = Callable[["AgentContext"], str]


@dataclass
class AgentContext:
    """Mutable view of everything the workflow has produced so far.

    The context flows from one executor to the next as the workflow's
    message payload, accumulating outputs in place.
    """

    grant_type: str
    grant_purpose: str
    school_data: SchoolData | None
    live_grants: list[Grant] = field(default_factory=list)
    source_stats: dict = field(default_factory=dict)
    # Foundation prospects partitioned off the rubric LLM pool. Surfaced
    # to the Discovery UI as a separate rail (real 501(c)(3) education
    # funders from ProPublica 990 data).
    foundation_pool: list[Grant] = field(default_factory=list)
    outputs: dict[str, str] = field(default_factory=dict)
    # Typed pass-through. When an agent's output parses cleanly into its
    # declared ``response_format``, the parsed Pydantic object is stored
    # here under the same key. Downstream prompt builders prefer this over
    # ``outputs`` (raw text) when present.
    typed_outputs: dict[str, BaseModel] = field(default_factory=dict)
    # HITL grant selection â€” set after the user picks one from the rubric
    # ranking. Generation-stage agents (Narrative onward) read this when
    # composing their prompts so they target the chosen funder explicitly.
    selected_grant: RankedGrant | None = None
    # Uma fundacao nao e um edital: nao tem prazo, faixa de premio nem rubrica
    # federal. Vem por um campo proprio para que os prompts nunca a tratem
    # como RFP nem inventem notas de rubrica para ela.
    selected_foundation: FoundationProspect | None = None

    @property
    def school_context(self) -> str:
        return format_school_context(self.school_data)

    @property
    def grant_info(self) -> dict:
        return GRANT_TYPES.get(self.grant_type, GRANT_TYPES["other"])


@dataclass(frozen=True)
class AgentSpec:
    """Static description of one agent in the pipeline."""

    key: str
    name: str
    system_prompt: str
    build_user_prompt: PromptBuilder
    response_format: type[BaseModel] | None = None
    """When set, downstream consumers may request structured output."""

    # Sem teto de tokens de proposito: em modelo de raciocinio o orcamento
    # inclui os tokens de raciocinio e um teto trunca a aplicacao final.


# ----------------------------------------------------------------- builders


def _ranked_discovery_prompt(ctx: AgentContext) -> str:
    """Rubric Discovery prompt â€” emits strict JSON for the HITL picker."""

    return build_ranked_discovery_user_prompt(
        grant_purpose=ctx.grant_purpose,
        school_context=ctx.school_context,
        live_grants=ctx.live_grants,
        source_stats=ctx.source_stats,
    )


# ---- v2 generation prompt builders (consulting-grade, target-anchored) ----


def _narrative_prompt_v2(ctx: AgentContext) -> str:
    return build_narrative_user_prompt(
        selected_grant=ctx.selected_grant,
        selected_foundation=ctx.selected_foundation,
        school_context=ctx.school_context,
        grant_purpose=ctx.grant_purpose,
        target_amount_usd=_midpoint_amount(ctx.selected_grant, ctx.grant_info["amount"]),
    )


def _budget_prompt_v2(ctx: AgentContext) -> str:
    return build_budget_user_prompt(
        selected_grant=ctx.selected_grant,
        selected_foundation=ctx.selected_foundation,
        school_context=ctx.school_context,
        grant_purpose=ctx.grant_purpose,
        target_amount_usd=_midpoint_amount(ctx.selected_grant, ctx.grant_info["amount"]),
        typed_outputs=ctx.typed_outputs,
        raw_outputs=ctx.outputs,
    )


def _writer_prompt_v2(ctx: AgentContext) -> str:
    school_name = ctx.school_data.name if ctx.school_data else "the applicant school"
    return build_writer_user_prompt(
        selected_grant=ctx.selected_grant,
        selected_foundation=ctx.selected_foundation,
        school_context=ctx.school_context,
        grant_purpose=ctx.grant_purpose,
        target_amount_usd=_midpoint_amount(ctx.selected_grant, ctx.grant_info["amount"]),
        school_name=school_name,
        typed_outputs=ctx.typed_outputs,
        raw_outputs=ctx.outputs,
    )


def _compliance_prompt_v2(ctx: AgentContext) -> str:
    return build_compliance_user_prompt(
        selected_grant=ctx.selected_grant,
        selected_foundation=ctx.selected_foundation,
        school_context=ctx.school_context,
        typed_outputs=ctx.typed_outputs,
        raw_outputs=ctx.outputs,
    )


def _intelligence_prompt_v2(ctx: AgentContext) -> str:
    return build_intelligence_user_prompt(
        selected_grant=ctx.selected_grant,
        selected_foundation=ctx.selected_foundation,
        school_context=ctx.school_context,
        typed_outputs=ctx.typed_outputs,
        raw_outputs=ctx.outputs,
    )


# ------------------------------------------------------------------- catalogue


# ------------------------------------------------------------------- specs

# Rubric Discovery â€” used by the HITL `DiscoveryWorkflow`. Emits strict JSON
# that parses into :class:`DiscoveryRanking`.
DISCOVERY_RANKER_SPEC: AgentSpec = AgentSpec(
    key="discovery",
    name="Discovery Agent",
    # Native consulting-grade prompt â€” no emoji scaffolding to strip.
    system_prompt=RANKED_DISCOVERY_SYSTEM_PROMPT,
    build_user_prompt=_ranked_discovery_prompt,
    response_format=DiscoveryRanking,
)


# --------------------------------------------------------------- SDK binding


@dataclass(frozen=True, slots=True)
class BoundAgent:
    """An :class:`AgentSpec` bound to a real :class:`agent_framework.Agent`.

    Carries the provider/deployment alongside so telemetry can label spans
    without poking into SDK internals.
    """

    spec: AgentSpec
    agent: SdkAgent
    provider: str
    deployment: str


def _bind(spec: AgentSpec, router: ModelRouter) -> BoundAgent:
    """Bind one :class:`AgentSpec` to a concrete SDK agent via the router.

    Resolution rule:
        ``router.per_agent()`` returns the model key for each agent
        (driven by ``AGENT_MODEL_*`` env vars). The router builds and
        caches a chat client per key. We wrap each client in an SDK
        :class:`agent_framework.Agent` whose ``instructions`` are the
        spec's system prompt.
    """

    per_agent = router.per_agent()
    model_key = per_agent.get(spec.key)
    if not model_key:
        raise ValueError(f"No AGENT_MODEL_* configured for {spec.key!r}")
    resolved = router.for_key(model_key)
    sdk_agent = SdkAgent(
        client=resolved.client,
        instructions=spec.system_prompt,
        name=spec.name,
        id=f"v2.{spec.key}",
    )
    return BoundAgent(
        spec=spec,
        agent=sdk_agent,
        provider=resolved.provider,
        deployment=resolved.deployment,
    )


def build_discovery_ranker(router: ModelRouter) -> BoundAgent:
    """Bind the rubric Discovery agent used by the HITL ``DiscoveryWorkflow``."""

    return _bind(DISCOVERY_RANKER_SPEC, router)


def build_generation_agents(router: ModelRouter) -> list[BoundAgent]:
    """Bind every pipeline spec *except* Discovery, in order.

    Used by ``GenerationWorkflow`` after the user has picked a grant from
    the Discovery ranker's output. Uses the v2 consulting-grade specs
    (:data:`GENERATION_PIPELINE_V2`) rather than the legacy emoji-stripped
    v1 prompts.
    """

    return [_bind(spec, router) for spec in GENERATION_PIPELINE_V2]


# ----------------------------------------------------------- v2 specs

# Native consulting-grade Narrative â€” no emoji scaffolding to strip, written
# to anchor every paragraph to the user-confirmed RankedGrant.
NARRATIVE_SPEC_V2: AgentSpec = AgentSpec(
    key="narrative",
    name="Narrative Agent",
    system_prompt=NARRATIVE_SYSTEM_PROMPT,
    build_user_prompt=_narrative_prompt_v2,
    response_format=NarrativeOutput,  # documented intent; output is markdown
)

# Budget â€” strict JSON. Output parses into BudgetOutput, which self-corrects
# sum drift and appends a category-band audit to ``notes``.
BUDGET_SPEC_V2: AgentSpec = AgentSpec(
    key="budget",
    name="Budget Agent",
    system_prompt=BUDGET_SYSTEM_PROMPT,
    build_user_prompt=_budget_prompt_v2,
    response_format=BudgetOutput,
)

# Writer â€” final assembly. Consumes the typed Narrative + Budget outputs
# via ``ctx.typed_outputs`` so it never drifts from the upstream numbers.
WRITER_SPEC_V2: AgentSpec = AgentSpec(
    key="writer",
    name="Application Writer",
    system_prompt=WRITER_SYSTEM_PROMPT,
    build_user_prompt=_writer_prompt_v2,
    response_format=ApplicationOutput,
)

# Compliance â€” strict JSON. Consumes pre-computed deterministic facts
# (word counts, budget arithmetic, demographic check, deadline check)
# rendered into the user prompt by ``build_compliance_user_prompt``,
# and adds LLM-level findings on tone and consistency.
COMPLIANCE_SPEC_V2: AgentSpec = AgentSpec(
    key="compliance",
    name="Compliance Agent",
    system_prompt=COMPLIANCE_SYSTEM_PROMPT,
    build_user_prompt=_compliance_prompt_v2,
    response_format=ComplianceOutput,
)

# Intelligence â€” strict JSON. Anchors its band to the federal base rate
# for the inferred grant family (see ``FEDERAL_BASE_RATES``). Never
# claims access to a corpus of past awards.
INTELLIGENCE_SPEC_V2: AgentSpec = AgentSpec(
    key="intelligence",
    name="Intelligence Agent",
    system_prompt=INTELLIGENCE_SYSTEM_PROMPT,
    build_user_prompt=_intelligence_prompt_v2,
    response_format=IntelligenceOutput,
)


GENERATION_PIPELINE_V2: tuple[AgentSpec, ...] = (
    NARRATIVE_SPEC_V2,
    BUDGET_SPEC_V2,
    COMPLIANCE_SPEC_V2,
    INTELLIGENCE_SPEC_V2,
    WRITER_SPEC_V2,
)
