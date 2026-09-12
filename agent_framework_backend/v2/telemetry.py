"""
OpenTelemetry helpers for v2.

Provides :func:`agent_span` — a context manager that opens a span around an
agent execution and records standard attributes:

* ``agent.name`` / ``agent.index``
* ``model.provider`` / ``model.deployment``
* ``tokens.prompt`` / ``tokens.completion`` / ``tokens.total``
* ``duration.ms``
* ``cost.usd_estimate`` (best-effort, see :data:`PRICE_PER_1K_TOKENS`)

If OpenTelemetry is not installed or no exporter is configured the helpers
become no-ops, so the v2 code never has to branch on telemetry availability.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Iterator
from contextlib import contextmanager

from v2.usage import Usage

logger = logging.getLogger(__name__)

try:  # pragma: no cover - optional dependency wiring
    from opentelemetry import trace

    _tracer = trace.get_tracer("smart-grant-request.v2")
    _OTEL_AVAILABLE = True
except Exception:
    _tracer = None
    _OTEL_AVAILABLE = False


# Best-effort USD/1K-token estimates. Override per deployment in production.
PRICE_PER_1K_TOKENS: dict[str, tuple[float, float]] = {
    # deployment: (prompt_usd, completion_usd)
    "gpt-5.4": (0.005, 0.015),
    "gpt-4o": (0.005, 0.015),
    "gpt-4o-mini": (0.00015, 0.0006),
}


def estimate_cost_usd(deployment: str, usage: Usage) -> float:
    """Estimate completion cost. Returns 0.0 when the deployment is unknown."""

    rates = PRICE_PER_1K_TOKENS.get(deployment)
    if not rates:
        return 0.0
    p_in, p_out = rates
    return round((usage.prompt_tokens * p_in + usage.completion_tokens * p_out) / 1000.0, 6)


class _SpanRecorder:
    """In-process recorder used by tests and structured logs when OTel is off."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.attributes: dict[str, object] = {}
        self.start = time.perf_counter()

    def set(self, key: str, value: object) -> None:
        self.attributes[key] = value

    def finish(self) -> None:
        duration_ms = int((time.perf_counter() - self.start) * 1000)
        self.attributes["duration.ms"] = duration_ms
        logger.info("agent_span %s %s", self.name, self.attributes)


@contextmanager
def agent_span(
    *,
    agent_name: str,
    agent_index: int,
    provider: str,
    deployment: str,
) -> Iterator[_SpanContext]:
    """Open a span for one agent execution.

    Usage::

        with agent_span(agent_name="discovery", agent_index=0, ...) as span:
            ...
            span.record_usage(usage)
    """

    recorder = _SpanRecorder(f"agent.{agent_name}")
    recorder.set("agent.name", agent_name)
    recorder.set("agent.index", agent_index)
    recorder.set("model.provider", provider)
    recorder.set("model.deployment", deployment)

    if _OTEL_AVAILABLE and _tracer is not None:
        with _tracer.start_as_current_span(recorder.name) as otel_span:
            for k, v in recorder.attributes.items():
                otel_span.set_attribute(k, v)  # type: ignore[arg-type]
            ctx = _SpanContext(recorder, otel_span)
            try:
                yield ctx
            finally:
                ctx.finalize()
                recorder.finish()
        return

    ctx = _SpanContext(recorder, None)
    try:
        yield ctx
    finally:
        ctx.finalize()
        recorder.finish()


class _SpanContext:
    """Caller-facing span handle exposed by :func:`agent_span`."""

    def __init__(self, recorder: _SpanRecorder, otel_span: object | None) -> None:
        self._recorder = recorder
        self._otel = otel_span
        self._usage: Usage | None = None

    def record_usage(self, usage: Usage) -> None:
        self._usage = usage
        self._set("tokens.prompt", usage.prompt_tokens)
        self._set("tokens.completion", usage.completion_tokens)
        self._set("tokens.total", usage.total_tokens)

    def record_error(self, error: BaseException) -> None:
        self._set("error.type", type(error).__name__)
        self._set("error.message", str(error)[:500])

    def finalize(self) -> None:
        if self._usage:
            cost = estimate_cost_usd(
                str(self._recorder.attributes.get("model.deployment", "")), self._usage
            )
            self._set("cost.usd_estimate", cost)

    # ------------------------------------------------------------------ helpers
    def _set(self, key: str, value: object) -> None:
        self._recorder.set(key, value)
        if self._otel is not None:
            # Telemetry is strictly observational: a failing exporter or an
            # unsupported attribute type must never surface as an error on the
            # request path. Logging here would also risk a feedback loop, since
            # the logging pipeline is itself instrumented — so this is one of
            # the few places where swallowing silently is the correct choice.
            try:
                self._otel.set_attribute(key, value)  # type: ignore[attr-defined]
            except Exception:  # noqa: S110 - see comment above
                pass
