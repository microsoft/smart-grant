"""
v2 settings — environment-driven configuration.

Reuses the existing :mod:`config` ``Settings`` object for shared values
(CORS, log level, GSA key, …) and adds v2-specific fields:

* Azure AI Foundry endpoint, API key, deployments
* Per-agent model routing
* Token budget
* Optional OTLP exporter override

Settings are read once and cached via :func:`get_v2_settings`.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

# Look for env files in this priority order:
#   1. agent_framework_backend/.env       (backend-local, e.g. inside Docker)
#   2. <repo-root>/.env.local             (Next.js dev convention)
#   3. <repo-root>/.env                   (committed defaults)
# Pydantic reads them last-to-first, so values in (1) override (2) override (3).
_BACKEND_DIR = Path(__file__).resolve().parent.parent
_REPO_ROOT = _BACKEND_DIR.parent
_ENV_FILES = (
    _REPO_ROOT / ".env",
    _REPO_ROOT / ".env.local",
    _BACKEND_DIR / ".env",
)


# Routing keys — must stay in sync with .env.example documentation.
ModelKey = Literal[
    "foundry-gpt-5.4",
    "foundry-gpt-5-mini",
    "foundry-gpt-4o",
    "azure-openai-gpt-4o",
    "azure-openai-gpt-4o-mini",
]


class V2Settings(BaseSettings):
    """v2-specific environment configuration."""

    # ------------------------------------------------------------------ Foundry
    foundry_endpoint: str = ""
    # A Responses API, usada pelo SDK, so existe a partir de 2025-03-01-preview.
    foundry_api_version: str = "2025-03-01-preview"
    foundry_api_key: str = ""
    foundry_use_aad: bool = False
    """When true (or when no API key is set), authenticate via Azure AD
    (DefaultAzureCredential). Required when the Foundry resource has
    key-based auth disabled."""
    foundry_deployment_gpt_5_4: str = "gpt-5.4"
    foundry_deployment_gpt_5_mini: str = ""
    foundry_deployment_gpt_4o: str = ""

    # --------------------------------------------------- Per-agent routing
    agent_model_discovery: ModelKey = "foundry-gpt-5.4"
    agent_model_narrative: ModelKey = "foundry-gpt-5.4"
    agent_model_budget: ModelKey = "foundry-gpt-5.4"
    agent_model_compliance: ModelKey = "foundry-gpt-5.4"
    agent_model_intelligence: ModelKey = "foundry-gpt-5.4"
    agent_model_writer: ModelKey = "foundry-gpt-5.4"

    # ----------------------------------------------------------- Observability
    otel_exporter_otlp_endpoint: str = ""
    otel_service_name: str = "smart-grant-request"

    model_config = SettingsConfigDict(
        env_file=tuple(str(p) for p in _ENV_FILES),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )


@lru_cache(maxsize=1)
def get_v2_settings() -> V2Settings:
    """Return the cached v2 settings instance."""

    return V2Settings()
