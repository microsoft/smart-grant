"""
Smart Grant Request — v2 backend package.

This package contains the v2 re-architecture of the agent pipeline.

Design goals
------------
* **Idiomatic Microsoft Agent Framework patterns** — ``ChatAgent``-style
  components composed by a fluent ``WorkflowBuilder``.
* **Provider-agnostic chat clients** — Azure AI Foundry (GPT-5.4) is the
  primary provider; Azure OpenAI Service is supported as a fallback. Adding a
  new provider is a matter of implementing :class:`v2.providers.base.ChatClient`.
* **Per-agent model routing** — every agent declares a *capability profile*;
  the :class:`v2.router.ModelRouter` resolves it to a concrete client based on
  ``AGENT_MODEL_*`` environment variables.
* **Typed hand-offs** — agents emit Pydantic models defined in
  :mod:`v2.schemas`; downstream agents receive structured data, not strings.
* **Observable** — each agent execution emits an OpenTelemetry span with
  duration, token counts, and cost estimate (see :mod:`v2.telemetry`).

Public surface
--------------
* :func:`v2.get_discovery_workflow` — stage 1, ranks the live grant pool.
* :func:`v2.get_generation_workflow` — stage 2, writes against the pick.
* :data:`v2.__version__` — module version.
"""

from __future__ import annotations

__version__ = "2.0.0-alpha.1"

from v2.events import EventType, WorkflowEvent
from v2.workflow import (
    DiscoveryWorkflow,
    GenerationWorkflow,
    get_discovery_workflow,
    get_generation_workflow,
)

__all__ = [
    "DiscoveryWorkflow",
    "EventType",
    "GenerationWorkflow",
    "WorkflowEvent",
    "__version__",
    "get_discovery_workflow",
    "get_generation_workflow",
]
