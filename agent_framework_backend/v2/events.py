"""
Workflow events emitted by the v2 pipeline.

These events are framework-agnostic: the SSE adapter in
:mod:`v2.streaming` converts them to the legacy ``a:`` / ``c:`` / ``d:``
format consumed by the v1 frontend, but other consumers (logs, tests,
WebSocket transports) can use them directly.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from typing import Any


class EventType(str, Enum):
    """Lifecycle events for a single workflow run."""

    WORKFLOW_START = "workflow_start"
    AGENT_START = "agent_start"
    TOKEN = "token"
    AGENT_COMPLETE = "agent_complete"
    WORKFLOW_COMPLETE = "workflow_complete"
    ERROR = "error"
    # HITL — Discovery ranker emits the structured top-5 + disqualified list
    # for the frontend grant-picker. Payload is a serialised DiscoveryRanking.
    DISCOVERY_RANKING_READY = "discovery_ranking_ready"
    # HITL — Discovery failed to produce a usable JSON ranking (parse/validation
    # error). Payload is the raw model output for diagnostics + a short reason.
    DISCOVERY_RANKING_FAILED = "discovery_ranking_failed"


@dataclass(frozen=True, slots=True)
class WorkflowEvent:
    """An immutable event emitted by the workflow."""

    type: EventType
    agent_index: int = 0
    """Zero-based index of the agent in the pipeline (0 .. 5)."""

    agent_name: str = ""
    """Human-readable agent name, e.g. ``"Discovery Agent"``."""

    payload: Any = ""
    """Token text, full output, or error message — depending on ``type``."""

    timestamp: datetime = field(
        default_factory=lambda: datetime.now(UTC)
    )

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-serialisable representation."""

        return {
            "type": self.type.value,
            "agentIndex": self.agent_index,
            "agentName": self.agent_name,
            "payload": self.payload,
            "timestamp": self.timestamp.isoformat(),
        }
