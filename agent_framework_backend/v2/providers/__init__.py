"""
Chat-client provider factories used by v2 agents.

A *provider* here is a thin factory that returns a configured
:class:`agent_framework.openai.OpenAIChatClient`. The framework deliberately
keeps this surface small so new providers can be added without touching the
agent or workflow code.
"""

from __future__ import annotations

from v2.providers.azure_openai import build_azure_openai_client
from v2.providers.foundry import build_foundry_client

__all__ = [
    "build_azure_openai_client",
    "build_foundry_client",
]
