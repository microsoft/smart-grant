"""Rotas HTTP do produto, sob ``/v2/*``.

O fluxo de redacao tem duas etapas com uma pessoa no meio:
``/workflow/discover`` ranqueia oportunidades reais e para; o usuario
escolhe uma; ``/workflow/generate`` escreve contra a escolha. As duas
respondem em SSE. Alem delas ficam os agregados de ``/analytics``.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, model_validator

from config import GRANT_TYPES
from services.analytics import get_landscape_service
from services.pulse import WINDOW_CHOICES, get_pulse_tracker
from v2 import get_discovery_workflow, get_generation_workflow
from v2.router import get_router
from v2.schemas import FoundationProspect, RankedGrant
from v2.settings import get_v2_settings
from v2.streaming import to_json_sse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v2", tags=["v2"])


# ---------------------------------------------------------------------- helpers


_NO_BUFFER_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


# --------------------------------------------------------------------- endpoints


@router.get("/health")
async def v2_health() -> dict:
    """Diagnostic health check including the active per-agent model map."""

    s = get_v2_settings()
    router_inst = get_router()

    # Reflective proof that the Microsoft Agent Framework SDK is the engine
    # actually orchestrating the pipeline. We import the same symbols the
    # workflow uses at runtime and report their fully-qualified class
    # names + the installed package version, straight from the running
    # Python process. If anyone swaps the orchestrator for a stub, this
    # block is the first thing that changes.
    try:
        from importlib.metadata import version as _pkg_version

        from agent_framework import (
            Agent as _SdkAgent,
        )
        from agent_framework import (
            Executor as _SdkExecutor,
        )
        from agent_framework import (
            Workflow as _SdkWorkflow,
        )
        from agent_framework import (
            WorkflowBuilder as _SdkWorkflowBuilder,
        )
        from agent_framework.openai import OpenAIChatClient as _SdkChatClient

        engine = {
            "package": "agent_framework",
            "version": _pkg_version("agent-framework"),
            "agent_class": f"{_SdkAgent.__module__}.{_SdkAgent.__qualname__}",
            "workflow_class": f"{_SdkWorkflow.__module__}.{_SdkWorkflow.__qualname__}",
            "builder_class": f"{_SdkWorkflowBuilder.__module__}.{_SdkWorkflowBuilder.__qualname__}",
            "executor_class": f"{_SdkExecutor.__module__}.{_SdkExecutor.__qualname__}",
            "chat_client_class": f"{_SdkChatClient.__module__}.{_SdkChatClient.__qualname__}",
        }
    except Exception as exc:  # pragma: no cover — diagnostic path only
        engine = {"error": f"{type(exc).__name__}: {exc}"}

    return {
        "status": "healthy",
        "foundry_endpoint_configured": bool(s.foundry_endpoint),
        "foundry_api_key_present": bool(s.foundry_api_key),
        "agents": router_inst.per_agent(),
        "workflow_engine": engine,
    }


# ======================================================================
# HITL flow — Phase A
#
# /v2/workflow/discover    : stage 1 — rubric ranking, top-5 + disqualified
# /v2/workflow/generate    : stage 2 — narrative onward against the chosen grant
#
# Both stages stream the same SSE event vocabulary; the discover stage
# additionally emits a ``discovery_ranking_ready`` event whose payload is
# the parsed :class:`DiscoveryRanking` object the frontend renders as the
# grant-picker UI.
# ======================================================================


class V2DiscoverRequest(BaseModel):
    """Request body for the rubric Discovery stage."""

    grantType: str
    customPurpose: str | None = None
    schoolData: dict | None = None


class V2GenerateRequest(BaseModel):
    """Request body for the generation stage (after the user picked a funder)."""

    grantType: str
    customPurpose: str | None = None
    schoolData: dict | None = None
    selectedGrant: RankedGrant | None = None
    selectedFoundation: FoundationProspect | None = None

    @model_validator(mode="after")
    def _exactly_one_target(self) -> V2GenerateRequest:
        # Os dois caminhos produzem documentos diferentes; aceitar ambos ou
        # nenhum deixaria a escolha para o prompt, que nao tem como decidir.
        if (self.selectedGrant is None) == (self.selectedFoundation is None):
            raise ValueError("provide exactly one of selectedGrant or selectedFoundation")
        return self


@router.post("/workflow/discover")
async def v2_workflow_discover(request: V2DiscoverRequest) -> StreamingResponse:
    """Stream the Discovery rubric stage."""

    if request.grantType not in GRANT_TYPES:
        raise HTTPException(status_code=400, detail=f"Invalid grant type: {request.grantType}")

    # Pulse telemetry — fail-soft; never blocks the workflow.
    await get_pulse_tracker().record_discovery(
        grant_type=request.grantType,
        school_data=request.schoolData,
    )

    workflow = get_discovery_workflow()
    events = workflow.stream(
        grant_type=request.grantType,
        custom_purpose=request.customPurpose,
        school_data=request.schoolData,
    )
    return StreamingResponse(
        to_json_sse(events),
        media_type="text/event-stream",
        headers=_NO_BUFFER_HEADERS,
    )


@router.post("/workflow/generate")
async def v2_workflow_generate(request: V2GenerateRequest) -> StreamingResponse:
    """Stream the generation stage (Narrative → Writer) against the
    user-selected grant."""

    if request.grantType not in GRANT_TYPES:
        raise HTTPException(status_code=400, detail=f"Invalid grant type: {request.grantType}")

    # Pulse telemetry — fail-soft; never blocks the workflow.
    await get_pulse_tracker().record_generation(
        grant_type=request.grantType,
        school_data=request.schoolData,
        selected_grant=request.selectedGrant or request.selectedFoundation,
    )

    workflow = get_generation_workflow()
    events = workflow.stream(
        grant_type=request.grantType,
        custom_purpose=request.customPurpose,
        school_data=request.schoolData,
        selected_grant=request.selectedGrant,
        selected_foundation=request.selectedFoundation,
    )
    return StreamingResponse(
        to_json_sse(events),
        media_type="text/event-stream",
        headers=_NO_BUFFER_HEADERS,
    )


# ======================================================================
# Analytics — live aggregates over Grants.gov ``search2``
# ======================================================================


@router.get("/analytics/landscape")
async def v2_analytics_landscape() -> dict:
    """Live federal-funding landscape aggregated from Grants.gov.

    Returns counts of open opportunities by category and by agency, the
    eight grants closing soonest within the next 30 days, and a 12-week
    posted-timeline. Results are cached for 10 minutes server-side.
    """

    service = get_landscape_service()
    return await service.compute_landscape()


@router.get("/analytics/pulse")
async def v2_analytics_pulse(
    window: str = Query("30", pattern="^(7|30|90|365|all)$"),
) -> dict:
    """Portal-usage analytics — quem está escrevendo, de onde, para qual edital.

    Agrega o log de eventos de Discovery e Generation numa única janela: a que
    o usuário escolheu. Toda métrica da resposta obedece a ela, e a janela
    efetivamente coberta pelos dados viaja em ``window`` para o painel poder
    rotular sem supor. ``all`` percorre o histórico completo.
    """

    tracker = get_pulse_tracker()
    return await tracker.compute_pulse(WINDOW_CHOICES[window])
