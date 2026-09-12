"""
:class:`ModelRouter` — resolve agent capability profiles to chat clients.

Each agent declares which model it would *like* to use via a string key
(e.g. ``"foundry-gpt-5.4"``). The router converts that key into a
configured :class:`agent_framework.openai.OpenAIChatClient` (or whatever
provider is registered for that key). Clients are constructed lazily and
cached for the life of the process.

This indirection is what allows operators to flip a single environment
variable to swap a model for one agent without touching code or restarting
any other agent's connections.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from threading import Lock

from agent_framework.openai import OpenAIChatClient

from v2.providers import build_azure_openai_client, build_foundry_client
from v2.settings import V2Settings, get_v2_settings

logger = logging.getLogger(__name__)


class UnknownModelKeyError(ValueError):
    """Raised when an ``AGENT_MODEL_*`` value is not recognised."""


@dataclass(frozen=True, slots=True)
class ResolvedClient:
    """A built chat client paired with its provenance metadata.

    Carrying the provider name and deployment alongside the client lets
    the workflow's telemetry record meaningful spans without having to
    introspect SDK internals.
    """

    client: OpenAIChatClient
    provider: str
    deployment: str


class ModelRouter:
    """Resolve a model key to a cached :class:`ResolvedClient`."""

    def __init__(self, settings: V2Settings | None = None) -> None:
        self._settings = settings or get_v2_settings()
        self._cache: dict[str, ResolvedClient] = {}
        self._lock = Lock()

    # ------------------------------------------------------------------ public
    def for_key(self, key: str) -> ResolvedClient:
        """Return (or build and cache) the client for ``key``."""

        with self._lock:
            resolved = self._cache.get(key)
            if resolved is None:
                resolved = self._build(key)
                self._cache[key] = resolved
                logger.info(
                    "model_router_built model_key=%s provider=%s deployment=%s",
                    key,
                    resolved.provider,
                    resolved.deployment,
                )
        return resolved

    def per_agent(self) -> Mapping[str, str]:
        """Return the agent → model-key map currently in effect."""

        s = self._settings
        return {
            "discovery": s.agent_model_discovery,
            "narrative": s.agent_model_narrative,
            "budget": s.agent_model_budget,
            "compliance": s.agent_model_compliance,
            "intelligence": s.agent_model_intelligence,
            "writer": s.agent_model_writer,
        }

    # ----------------------------------------------------------------- builders
    def _build(self, key: str) -> ResolvedClient:
        s = self._settings

        if key == "foundry-gpt-5.4":
            return self._foundry(s.foundry_deployment_gpt_5_4)
        if key == "foundry-gpt-5-mini":
            return self._foundry(s.foundry_deployment_gpt_5_mini or "gpt-5-mini")
        if key == "foundry-gpt-4o":
            return self._foundry(s.foundry_deployment_gpt_4o or "gpt-4o")

        if key in ("azure-openai-gpt-4o", "azure-openai-gpt-4o-mini"):
            from config import get_settings as get_v1_settings

            v1 = get_v1_settings()
            deployment = (
                v1.azure_openai_deployment
                if key == "azure-openai-gpt-4o"
                else (v1.azure_openai_deployment or "gpt-4o-mini")
            )
            client = build_azure_openai_client(
                endpoint=v1.azure_openai_endpoint,
                api_version=v1.azure_openai_api_version,
                deployment=deployment,
                api_key=v1.azure_openai_api_key,
            )
            return ResolvedClient(client=client, provider="azure-openai", deployment=deployment)

        raise UnknownModelKeyError(f"Unknown AGENT_MODEL_* value: {key!r}")

    def _foundry(self, deployment: str) -> ResolvedClient:
        client = build_foundry_client(settings=self._settings, deployment=deployment)
        return ResolvedClient(client=client, provider="foundry", deployment=deployment)


_default_router: ModelRouter | None = None
_router_lock = Lock()


def get_router() -> ModelRouter:
    """Return the process-wide :class:`ModelRouter` singleton."""

    global _default_router
    with _router_lock:
        if _default_router is None:
            _default_router = ModelRouter()
    return _default_router
