"""
v2 workflow — six-agent pipeline orchestrated by Microsoft Agent Framework.

This module is the sole place that knows how the agents fit together.
The orchestration uses the SDK's :class:`agent_framework.WorkflowBuilder`
with one custom :class:`Executor` per pipeline step. Each executor binds a
single :class:`agent_framework.Agent` (the SDK type) and runs it with
streaming enabled, forwarding token-level events to the workflow stream
via the SDK's :meth:`WorkflowContext.add_event` channel.

What this gets us
-----------------
* The SDK owns transport, retries, message normalisation, and OTel
  instrumentation — we don't reinvent any of it.
* Token streaming arrives at the FastAPI layer through a single typed
  pipeline: SDK ``WorkflowEvent`` → translator → public
  :class:`v2.events.WorkflowEvent` → SSE adapter.
* A custom executor cleanly expresses our pattern (per-step prompt
  injection from cumulative context) without forcing it through the
  message-passing chain pattern, which is wrong for "fan-in of context".

Public entry points
-------------------
"""

import logging
import re
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from threading import Lock
from typing import Any

from agent_framework import (
    Executor,
    WorkflowContext,
    handler,
)
from agent_framework import (
    Workflow as SdkWorkflow,
)
from agent_framework import (
    WorkflowBuilder as SdkWorkflowBuilder,
)

from config import GRANT_TYPES
from services.foundations import get_foundations_service
from services.grants import Grant, get_multi_source_aggregator
from v2.agents import (
    AgentContext,
    BoundAgent,
    build_discovery_ranker,
    build_generation_agents,
)
from v2.events import EventType, WorkflowEvent
from v2.prompts_discovery import parse_discovery_ranking
from v2.router import ModelRouter, get_router
from v2.schemas import FoundationProspect, RankedGrant
from v2.school import SchoolData
from v2.telemetry import agent_span, estimate_cost_usd
from v2.usage import Usage

logger = logging.getLogger(__name__)


# Agents whose system prompt instructs them to return strict JSON. Only
# these get their output parsed into ``AgentContext.typed_outputs`` after
# completion (see :class:`_GrantAgentExecutor`). Narrative and Writer
# return polished markdown by design; parsing those would fail loudly.
_JSON_OUTPUT_AGENTS: frozenset[str] = frozenset({"budget", "compliance", "intelligence"})


def _parse_typed_output(text: str, model_cls: type) -> Any:
    """Best-effort JSON → Pydantic parser for typed agent handoffs.

    Tolerates the common stochastic-LLM artefacts: fenced code blocks,
    leading prose, trailing commas. Returns ``None`` if nothing
    JSON-shaped can be recovered (caller logs and falls back to raw
    text).
    """

    import json as _json
    import re as _re

    # Strip ```json fences if the model added them despite instructions.
    stripped = text.strip()
    fence = _re.match(r"^```(?:json)?\s*\n(.*?)\n```\s*$", stripped, _re.DOTALL)
    if fence:
        stripped = fence.group(1).strip()

    # Find the outermost balanced {...} substring.
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    candidate = stripped[start : end + 1]

    # Drop trailing commas before } or ].
    candidate = _re.sub(r",(\s*[}\]])", r"\1", candidate)

    try:
        data = _json.loads(candidate)
    except _json.JSONDecodeError:
        return None
    return model_cls.model_validate(data)


# Custom-data envelope used to forward agent-level events (start, token,
# complete, error) through the SDK workflow stream. The workflow runner
# emits these as ``WorkflowEvent(type='executor_*')`` or as the executor's
# yielded output; we additionally publish per-token updates as the SDK's
# native ``executor_invoked``-style events would not give us a stream.
@dataclass(frozen=True, slots=True)
class _AgentEvent:
    kind: str  # "agent_start" | "token" | "agent_complete" | "agent_error"
    agent_index: int
    agent_name: str
    payload: Any = ""


# -------------------------------------------------------------- prep executor


@dataclass(frozen=True, slots=True)
class _WorkflowInputs:
    grant_type: str
    custom_purpose: str | None = None
    school_data: dict | None = None
    # When set, Setup uses this directly and skips the live aggregator call.
    # Used by the generation stage of the HITL flow (the user has already
    # picked a grant, so we don't need to re-fetch the search pool).
    selected_grant: RankedGrant | None = None
    # Alternativa ao edital: uma fundacao escolhida na trilha de prospeccao.
    selected_foundation: FoundationProspect | None = None


class _Setup(Executor):
    """First executor: build the AgentContext from raw inputs.

    Receives a :class:`_WorkflowInputs` dataclass, builds the immutable
    context, fetches live grants (best-effort when ``fetch_live_grants`` is
    True), and forwards the context to the first agent executor.
    """

    def __init__(self, *, fetch_live_grants: bool = True) -> None:
        super().__init__(id="v2.setup")
        self._fetch = fetch_live_grants
        self._aggregator = get_multi_source_aggregator() if fetch_live_grants else None

    @handler
    async def setup(
        self,
        inputs: _WorkflowInputs,
        ctx: WorkflowContext[AgentContext],
    ) -> None:
        grant_info = GRANT_TYPES.get(inputs.grant_type, GRANT_TYPES["other"])
        grant_purpose = (
            inputs.custom_purpose if inputs.grant_type == "other" else grant_info["name"]
        )
        parsed_school = _parse_school(inputs.school_data)

        agent_ctx = AgentContext(
            grant_type=inputs.grant_type,
            grant_purpose=grant_purpose,
            school_data=parsed_school,
            selected_grant=inputs.selected_grant,
            selected_foundation=inputs.selected_foundation,
        )

        # Best-effort live grant aggregation (skipped when we already have a
        # selected grant — the search pool is no longer relevant).
        if self._fetch and self._aggregator is not None:
            try:
                keywords = _extract_keywords(grant_purpose)
                agent_ctx.live_grants, agent_ctx.source_stats = (
                    await self._aggregator.search_all_sources(
                        keyword=keywords,
                        state=parsed_school.state if parsed_school else None,
                    )
                )
                # Foundations are surfaced as a separate prospect rail in
                # the Discovery picker, not ranked by the rubric LLM.
                # Stash them off the LLM pool so the prompt isn't polluted
                # with deadline-less entities that the rubric is not
                # designed to score.
                foundations = [
                    g for g in agent_ctx.live_grants if g.source == "foundation"
                ]
                agent_ctx.live_grants = [
                    g for g in agent_ctx.live_grants if g.source != "foundation"
                ]
                agent_ctx.foundation_pool = foundations
                logger.info(
                    "v2_grants_fetched count=%d foundations=%d stats=%s",
                    len(agent_ctx.live_grants),
                    len(foundations),
                    agent_ctx.source_stats,
                )
            except Exception as exc:
                logger.warning("v2_grants_fetch_failed error=%s", exc)
                agent_ctx.live_grants = []
                agent_ctx.source_stats = {}
                agent_ctx.foundation_pool = []

        await ctx.send_message(agent_ctx)


# ------------------------------------------------------------- agent executor


class _GrantAgentExecutor(Executor):
    """Run one bound :class:`agent_framework.Agent` against the cumulative context.

    The executor streams the agent's response, forwarding tokens as
    custom workflow events, and updates the :class:`AgentContext` with
    the agent's full output before forwarding it downstream.
    """

    def __init__(self, bound: BoundAgent, agent_index: int, is_last: bool) -> None:
        super().__init__(id=f"v2.agent.{bound.spec.key}")
        self._bound = bound
        self._index = agent_index
        self._is_last = is_last

    @handler
    async def run_agent(
        self,
        agent_ctx: AgentContext,
        ctx: WorkflowContext[AgentContext, AgentContext],
    ) -> None:
        spec = self._bound.spec

        await _emit(
            ctx,
            _AgentEvent(
                kind="agent_start",
                agent_index=self._index,
                agent_name=spec.name,
                payload=f"Starting {spec.name}…",
            ),
            self.id,
        )

        user_prompt = spec.build_user_prompt(agent_ctx)
        full_text_parts: list[str] = []
        prompt_tokens = 0
        completion_tokens = 0
        started = time.perf_counter()

        with agent_span(
            agent_name=spec.key,
            agent_index=self._index,
            provider=self._bound.provider,
            deployment=self._bound.deployment,
        ) as span:
            try:
                stream = self._bound.agent.run(
                    user_prompt,
                    stream=True,
                )
                async for update in stream:
                    text = getattr(update, "text", None)
                    if text:
                        full_text_parts.append(text)
                        await _emit(
                            ctx,
                            _AgentEvent(
                                kind="token",
                                agent_index=self._index,
                                agent_name=spec.name,
                                payload=text,
                            ),
                            self.id,
                        )

                    # The SDK exposes optional usage on response updates.
                    usage_attr = getattr(update, "usage_details", None)
                    if usage_attr is not None:
                        prompt_tokens = (
                            getattr(usage_attr, "input_token_count", prompt_tokens)
                            or prompt_tokens
                        )
                        completion_tokens = (
                            getattr(usage_attr, "output_token_count", completion_tokens)
                            or completion_tokens
                        )

                span.record_usage(
                    Usage(prompt_tokens=prompt_tokens, completion_tokens=completion_tokens)
                )
            except Exception as exc:
                span.record_error(exc)
                logger.exception("v2_agent_error agent=%s", spec.key)
                await _emit(
                    ctx,
                    _AgentEvent(
                        kind="agent_error",
                        agent_index=self._index,
                        agent_name=spec.name,
                        payload=str(exc),
                    ),
                    self.id,
                )
                # Forward an empty completion so downstream agents still run.
                await _emit(
                    ctx,
                    _AgentEvent(
                        kind="agent_complete",
                        agent_index=self._index,
                        agent_name=spec.name,
                        payload="",
                    ),
                    self.id,
                )
                agent_ctx.outputs[spec.key] = ""
                if self._is_last:
                    await ctx.yield_output(agent_ctx)
                else:
                    await ctx.send_message(agent_ctx)
                return

        full_text = "".join(full_text_parts)
        agent_ctx.outputs[spec.key] = full_text

        # Typed handoff: when the spec declares a ``response_format``, try
        # to parse the agent's output and stash the Pydantic object under
        # ``typed_outputs[key]``. Failures are silent — downstream prompt
        # builders fall back to the raw text. We only attempt this for
        # agents whose prompt instructs them to return JSON (Budget today;
        # Compliance / Intelligence once Phase C rewrites them).
        if spec.response_format is not None and spec.key in _JSON_OUTPUT_AGENTS:
            try:
                parsed = _parse_typed_output(full_text, spec.response_format)
                if parsed is not None:
                    agent_ctx.typed_outputs[spec.key] = parsed
            except Exception as exc:
                logger.warning(
                    "v2_typed_parse_failed agent=%s error=%s", spec.key, exc
                )

        elapsed_ms = int((time.perf_counter() - started) * 1000)
        cost_usd = estimate_cost_usd(
            self._bound.deployment,
            Usage(prompt_tokens=prompt_tokens, completion_tokens=completion_tokens),
        )

        await _emit(
            ctx,
            _AgentEvent(
                kind="agent_complete",
                agent_index=self._index,
                agent_name=spec.name,
                payload={
                    "text": full_text,
                    "duration_ms": elapsed_ms,
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": completion_tokens,
                    "cost_usd": cost_usd,
                },
            ),
            self.id,
        )

        if self._is_last:
            await ctx.yield_output(agent_ctx)
        else:
            await ctx.send_message(agent_ctx)


async def _emit(ctx: WorkflowContext[Any, Any], event: _AgentEvent, executor_id: str) -> None:
    """Publish a custom agent event into the workflow stream."""

    from agent_framework import WorkflowEvent as SdkWorkflowEvent

    await ctx.add_event(
        SdkWorkflowEvent(
            type="data",
            data={
                "kind": event.kind,
                "agent_index": event.agent_index,
                "agent_name": event.agent_name,
                "payload": event.payload,
            },
            source_executor_id=executor_id,
        )
    )


# ------------------------------------------------------------------ translator


def _translate(sdk_event: Any, *, total_agents: int) -> WorkflowEvent | None:
    """Translate one SDK event into a public :class:`WorkflowEvent`."""

    sdk_type = getattr(sdk_event, "type", None)
    sdk_data = getattr(sdk_event, "data", None)

    # Our custom token / agent_start / agent_complete envelopes.
    if sdk_type == "data" and isinstance(sdk_data, dict) and "kind" in sdk_data:
        kind = sdk_data["kind"]
        agent_index = int(sdk_data.get("agent_index", 0))
        agent_name = str(sdk_data.get("agent_name", ""))
        payload = sdk_data.get("payload", "")

        if kind == "agent_start":
            return WorkflowEvent(
                type=EventType.AGENT_START,
                agent_index=agent_index,
                agent_name=agent_name,
                payload=payload if isinstance(payload, str) else "",
            )
        if kind == "token":
            return WorkflowEvent(
                type=EventType.TOKEN,
                agent_index=agent_index,
                agent_name=agent_name,
                payload=payload,
            )
        if kind == "agent_complete":
            # payload may be either the text (legacy) or a metrics dict.
            if isinstance(payload, dict):
                text = payload.get("text", "")
            else:
                text = str(payload)
            return WorkflowEvent(
                type=EventType.AGENT_COMPLETE,
                agent_index=agent_index,
                agent_name=agent_name,
                payload=text,
            )
        if kind == "agent_error":
            return WorkflowEvent(
                type=EventType.ERROR,
                agent_index=agent_index,
                agent_name=agent_name,
                payload=str(payload),
            )

    # Framework-level errors.
    if sdk_type in ("failed", "error"):
        details = getattr(sdk_event, "details", None)
        return WorkflowEvent(type=EventType.ERROR, payload=str(details or sdk_event))

    return None


# ------------------------------------------------------------------- helpers


def _parse_school(data: dict | None) -> SchoolData | None:
    if not data:
        return None
    return SchoolData(
        id=data.get("id", ""),
        name=data.get("name", ""),
        district=data.get("district", ""),
        city=data.get("city", ""),
        state=data.get("state", ""),
        zip=data.get("zip", ""),
        students=data.get("students", 0),
        grades=data.get("grades", ""),
        type=data.get("type", "Public"),
        demographics=data.get("demographics", {}) or {},
        programs=data.get("programs", {}) or {},
        contact=data.get("contact", {}) or {},
    )


# Palavras que so adicionam ruido a busca do Grants.gov: aparecem em quase todo
# edital e diluem os termos que realmente distinguem o pedido.
_KEYWORD_STOPWORDS: frozenset[str] = frozenset(
    {
        "all", "and", "any", "are", "buy", "can", "for", "from", "fund",
        "funding", "funds", "get", "grant", "grants", "have", "help", "into",
        "more", "need", "needs", "new", "our", "out", "please", "provide",
        "some", "support", "that", "the", "their", "them", "these", "this",
        "those", "want", "we", "with", "would", "your",
    }
)

# Se o pedido nao tiver nenhuma ancora de ensino, a busca federal devolve
# programas de pesquisa e de defesa que usam o mesmo vocabulario.
_EDUCATION_HINTS: tuple[str, ...] = (
    "education", "school", "student", "teacher", "classroom", "k-12", "learning", "literacy",
)


def _extract_keywords(purpose: str) -> str:
    """Termos de busca derivados do que o usuario pediu.

    Antes havia uma tabela que substituia o pedido por um termo generico: quem
    pedia laboratorio de informatica buscava por "education grant" e recebia
    Title X Family Planning. Medido contra a API, usar as palavras do proprio
    pedido derrubou o ruido de 5 em 10 para 1 em 10.
    """

    limpo = re.sub(r"[^a-z0-9\s-]", " ", (purpose or "").lower())
    termos = [t for t in limpo.split() if len(t) > 2 and t not in _KEYWORD_STOPWORDS]
    if not termos:
        return "K-12 education"

    termos = termos[:5]
    if not any(hint in t for t in termos for hint in _EDUCATION_HINTS):
        termos.append("education")
    return " ".join(termos)


_PP_LOC_RE = re.compile(r"based in\s+(?:([^,]+),\s*)?([A-Z]{2})\.", re.IGNORECASE)


def _to_foundation_prospects(grants: list[Grant]) -> list[FoundationProspect]:
    """Convert ProPublica-sourced :class:`Grant` rows into the
    deterministic :class:`FoundationProspect` rail consumed by the
    Discovery picker.
    """

    out: list[FoundationProspect] = []
    for g in grants:
        # ``Grant.id`` is ``pp-{9-digit-ein}`` per ``services/foundations.py``.
        raw_ein = (g.id or "").removeprefix("pp-").strip()
        if len(raw_ein) != 9 or not raw_ein.isdigit():
            continue
        display_ein = f"{raw_ein[:2]}-{raw_ein[2:]}"

        focus = "Education foundation"
        if g.focus and len(g.focus) >= 2:
            focus = g.focus[1]
        elif g.focus:
            focus = g.focus[0]

        city: str | None = None
        state: str | None = None
        if g.description:
            m = _PP_LOC_RE.search(g.description)
            if m:
                city = (m.group(1) or "").strip() or None
                state = (m.group(2) or "").strip().upper() or None

        out.append(
            FoundationProspect(
                id=g.id,
                name=g.title,
                focus=focus,
                city=city,
                state=state,
                ein=display_ein,
                url=g.url or "",
            )
        )
    return out


# =========================================================================
# HITL workflows — Phase A
#
# O fluxo HITL separa a Discovery da geracao para que o usuario escolha o
# edital antes de qualquer texto ser escrito:
#
#   1. ``DiscoveryWorkflow``  — Setup + Discovery only. Streams the agent
#      for UX feedback, then emits a parsed :class:`DiscoveryRanking` as a
#      typed event the frontend renders as the grant-picker UI.
#
#   2. ``GenerationWorkflow`` — Setup (no aggregator) + Narrative → Budget
#      → Compliance → Intelligence → Writer. Takes the user-selected
#      :class:`RankedGrant` as input and writes the full application
#      against it.
#
# Both stages produce the same SSE event vocabulary, so the frontend reuses
# its stream-parsing code unchanged.
# =========================================================================


class DiscoveryWorkflow:
    """Stage 1 of the HITL pipeline - rubric ranking only.

    O grafo do SDK e reconstruido a cada execucao porque carrega estado por
    run; o agente ligado fica em cache porque carrega cliente HTTP e
    credencial.
    """

    def __init__(self, *, router: ModelRouter | None = None) -> None:
        self._router = router or get_router()
        self._bound = build_discovery_ranker(self._router)

    def _build_graph(self) -> SdkWorkflow:
        setup = _Setup(fetch_live_grants=True)
        agent = _GrantAgentExecutor(self._bound, agent_index=0, is_last=True)
        builder = SdkWorkflowBuilder(start_executor=setup, name="grant-discovery-v2")
        builder.add_chain([setup, agent])
        return builder.build()

    async def stream(
        self,
        *,
        grant_type: str,
        custom_purpose: str | None = None,
        school_data: dict | None = None,
    ) -> AsyncIterator[WorkflowEvent]:
        """Run Discovery, yielding events including the structured ranking."""

        yield WorkflowEvent(
            type=EventType.WORKFLOW_START,
            payload={"stage": "discovery", "grant_type": grant_type},
        )

        inputs = _WorkflowInputs(
            grant_type=grant_type,
            custom_purpose=custom_purpose,
            school_data=school_data,
        )

        # Accumulate the agent's raw text so we can parse the JSON ranking
        # after streaming completes. We still forward every token event so
        # the UI can show a live indicator while Discovery is thinking.
        discovery_text_parts: list[str] = []

        run = self._build_graph().run(inputs, stream=True, include_status_events=False)
        try:
            async for sdk_event in run:
                public = _translate(sdk_event, total_agents=1)
                if public is None:
                    continue
                if public.type is EventType.TOKEN and public.agent_index == 0:
                    discovery_text_parts.append(str(public.payload))
                if public.type is EventType.AGENT_COMPLETE and public.agent_index == 0:
                    # Suppress the raw JSON from the visible stream — we emit
                    # the parsed ranking event right after.
                    public = WorkflowEvent(
                        type=EventType.AGENT_COMPLETE,
                        agent_index=0,
                        agent_name=public.agent_name,
                        payload="",
                    )
                yield public
        except Exception as exc:
            logger.exception("v2_discovery_workflow_failed")
            yield WorkflowEvent(type=EventType.ERROR, payload=str(exc))
            return

        full_text = "".join(discovery_text_parts)
        logger.info(
            "v2_discovery_agent_completed text_len=%d parts=%d",
            len(full_text), len(discovery_text_parts),
        )
        try:
            ranking = parse_discovery_ranking(full_text)
        except ValueError as exc:
            logger.warning(
                "v2_discovery_parse_failed reason=%s text_len=%d head=%r",
                exc, len(full_text), full_text[:300],
            )
            yield WorkflowEvent(
                type=EventType.DISCOVERY_RANKING_FAILED,
                agent_index=0,
                agent_name="Discovery Agent",
                payload={"reason": str(exc), "raw": full_text[:4000]},
            )
            yield WorkflowEvent(type=EventType.WORKFLOW_COMPLETE, agent_index=0, agent_name="Discovery")
            return

        # Hydrate the foundation-prospect rail from the cached ProPublica
        # service. We keep foundations out of the LLM rubric (they have
        # no deadline or award range and would never win the top-5
        # fight), and surface them deterministically here instead.
        try:
            grant_info = GRANT_TYPES.get(grant_type, GRANT_TYPES["other"])
            purpose = (
                custom_purpose if grant_type == "other" else grant_info["name"]
            )
            parsed_school = _parse_school(school_data)
            keywords = _extract_keywords(purpose)
            foundation_grants = await get_foundations_service().search_foundations(
                keyword=keywords,
                state=parsed_school.state if parsed_school else None,
                limit=12,
            )
            enriched = await get_foundations_service().enrich_and_rank(
                grants=foundation_grants,
                school_data=parsed_school,
                grant_type=grant_type,
            )
            ranking.foundation_prospects = [
                FoundationProspect.model_validate(row) for row in enriched
            ]
            logger.info(
                "v2_discovery_foundation_prospects count=%d top_score=%s",
                len(ranking.foundation_prospects),
                ranking.foundation_prospects[0].score if ranking.foundation_prospects else None,
            )
        except Exception:
            logger.warning(
                "v2_discovery_foundation_prospects_failed", exc_info=True
            )

        yield WorkflowEvent(
            type=EventType.DISCOVERY_RANKING_READY,
            agent_index=0,
            agent_name="Discovery Agent",
            payload=ranking.model_dump(mode="json"),
        )
        yield WorkflowEvent(
            type=EventType.WORKFLOW_COMPLETE,
            agent_index=0,
            agent_name="Discovery",
            payload="",
        )


class GenerationWorkflow:
    """Stage 2 of the HITL pipeline — writes against a user-selected grant.

    Runs Narrative → Budget → Compliance → Intelligence → Writer.
    Agent indices are offset by 1 so the frontend's six-slot timeline
    (Discovery is slot 0) lines up.
    """

    def __init__(self, *, router: ModelRouter | None = None) -> None:
        self._router = router or get_router()
        self._bound = build_generation_agents(self._router)  # 5 agents

    def _build_graph(self) -> SdkWorkflow:
        setup = _Setup(fetch_live_grants=False)
        # Offset indices by 1: Narrative=1, Budget=2, Compliance=3, Intel=4, Writer=5
        steps = [
            _GrantAgentExecutor(b, agent_index=i + 1, is_last=(i == len(self._bound) - 1))
            for i, b in enumerate(self._bound)
        ]
        builder = SdkWorkflowBuilder(start_executor=setup, name="grant-generation-v2")
        builder.add_chain([setup, *steps])
        return builder.build()

    async def stream(
        self,
        *,
        grant_type: str,
        custom_purpose: str | None,
        school_data: dict | None,
        selected_grant: RankedGrant | None = None,
        selected_foundation: FoundationProspect | None = None,
    ) -> AsyncIterator[WorkflowEvent]:
        """Stream the five generation agents against the selected funder."""

        if selected_grant is None and selected_foundation is None:
            raise ValueError("selected_grant or selected_foundation is required")

        alvo = selected_grant.title if selected_grant else selected_foundation.name  # type: ignore[union-attr]
        yield WorkflowEvent(
            type=EventType.WORKFLOW_START,
            payload={
                "stage": "generation",
                "grant_type": grant_type,
                "selected_grant_title": alvo,
            },
        )

        # Mirror the Discovery agent's completion into the cumulative
        # ``outputs`` map so downstream prompt builders (which read
        # ``outputs["discovery"]``) still see a discovery summary — this
        # time anchored to the human-chosen grant rather than a free
        # narrative.
        discovery_summary_for_downstream = (
            _selected_grant_brief(selected_grant)
            if selected_grant is not None
            else _selected_foundation_brief(selected_foundation)  # type: ignore[arg-type]
        )

        inputs = _WorkflowInputs(
            grant_type=grant_type,
            custom_purpose=custom_purpose,
            school_data=school_data,
            selected_grant=selected_grant,
            selected_foundation=selected_foundation,
        )

        # Inject the discovery summary by patching the AgentContext after Setup
        # but before the first agent runs. Cleanest path: subclass `_Setup`
        # to seed `outputs['discovery']` on its way out — done below.
        # (Implemented inline by wrapping inputs through a one-shot setter.)

        run = self._build_graph().run(inputs, stream=True, include_status_events=False)
        first_message_patched = False
        try:
            async for sdk_event in run:
                # Patch the in-flight AgentContext exactly once, when the
                # Setup executor emits its outbound message (we observe this
                # indirectly: the next agent_start event with index 1).
                if not first_message_patched:
                    first_message_patched = self._seed_discovery_output(
                        sdk_event, discovery_summary_for_downstream
                    )

                public = _translate(sdk_event, total_agents=len(self._bound) + 1)
                if public is not None:
                    yield public
        except Exception as exc:
            logger.exception("v2_generation_workflow_failed")
            yield WorkflowEvent(type=EventType.ERROR, payload=str(exc))
            return

        yield WorkflowEvent(
            type=EventType.WORKFLOW_COMPLETE,
            agent_index=len(self._bound),  # = 5 (the Writer's index)
            agent_name="Workflow",
            payload="",
        )

    @staticmethod
    def _seed_discovery_output(sdk_event: Any, brief: str) -> bool:
        """Best-effort: attach a synthetic Discovery summary to the AgentContext
        the moment Setup forwards it. Returns True once patched.
        """

        # Setup forwards an AgentContext via ``send_message`` — the SDK
        # surfaces these as ``executor_completed`` events whose ``output``
        # holds the message. Hook into that exactly once.
        if getattr(sdk_event, "type", None) != "executor_completed":
            return False
        if getattr(sdk_event, "executor_id", None) != "v2.setup":
            return False
        msg = getattr(sdk_event, "output", None)
        if msg is None or not hasattr(msg, "outputs"):
            return False
        try:
            msg.outputs["discovery"] = brief
        except Exception:  # pragma: no cover — defensive
            return False
        return True


def _selected_foundation_brief(f: FoundationProspect) -> str:
    """Equivalente ao brief do edital para uma fundacao. Nao ha prazo, faixa de
    premio nem rubrica: afirmar qualquer um seria inventar."""

    linhas = [
        "SELECTED FUNDER (user-confirmed private foundation prospect):",
        "",
        f"**Name:** {f.name}",
        f"**EIN:** {f.ein}",
        f"**Focus:** {f.focus}",
        f"**Location:** {', '.join(x for x in (f.city, f.state) if x) or 'not on file'}",
        f"**Funder fit:** {f.score}/100 (deterministic, from IRS Form 990; confidence {f.confidence})",
        f"**Source:** {f.url}",
        "",
        (
            "**This is a prospect, not a posted opportunity.** It was identified from "
            "public IRS Form 990 filings. There is no published deadline, award range "
            "or review rubric, and none may be invented. The deliverable is a letter "
            "of inquiry."
        ),
    ]
    if f.pros:
        linhas += ["", "**Strengths:**", *(f"- {p}" for p in f.pros)]
    if f.cons:
        linhas += ["", "**Caveats:**", *(f"- {c}" for c in f.cons)]
    return "\n".join(linhas)


def _selected_grant_brief(g: RankedGrant) -> str:
    """Render the user-selected grant as a markdown brief the downstream
    prompt builders (which expect a plain string under ``outputs['discovery']``)
    can use verbatim.
    """

    pros = "\n".join(f"- {p}" for p in g.pros)
    cons = "\n".join(f"- {c}" for c in g.cons)
    return (
        f"SELECTED GRANT (user-confirmed from rubric ranking #{g.rank}):\n\n"
        f"**Title:** {g.title}\n"
        f"**Funder:** {g.funder}\n"
        f"**Source:** {g.source}\n"
        f"**Amount:** {g.amount_text}\n"
        f"**Deadline:** {g.deadline_text}\n\n"
        f"**Summary:** {g.summary}\n\n"
        f"**Why it ranked #{g.rank} (score {g.score_total}/100, confidence {g.confidence}):** "
        f"{g.why_this_rank}\n\n"
        f"**Strengths for this school:**\n{pros}\n\n"
        f"**Known trade-offs to address in the application:**\n{cons}\n"
    )


# --------------------------------------------------------------------- singleton


_workflow_lock = Lock()
_discovery_workflow: DiscoveryWorkflow | None = None
_generation_workflow: GenerationWorkflow | None = None


def get_discovery_workflow() -> DiscoveryWorkflow:
    """Return the process-wide :class:`DiscoveryWorkflow` singleton."""

    global _discovery_workflow
    with _workflow_lock:
        if _discovery_workflow is None:
            _discovery_workflow = DiscoveryWorkflow()
    return _discovery_workflow


def get_generation_workflow() -> GenerationWorkflow:
    """Return the process-wide :class:`GenerationWorkflow` singleton."""

    global _generation_workflow
    with _workflow_lock:
        if _generation_workflow is None:
            _generation_workflow = GenerationWorkflow()
    return _generation_workflow
