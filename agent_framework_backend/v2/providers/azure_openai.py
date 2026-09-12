"""
Azure OpenAI Service chat-client factory (fallback / cost-tier alternative).

Returns a Microsoft Agent Framework :class:`OpenAIChatClient` configured
for an Azure OpenAI Service endpoint. Supports both API-key and Microsoft
Entra ID (``DefaultAzureCredential``) authentication, mirroring v1.
"""

from __future__ import annotations

import logging

from agent_framework.openai import OpenAIChatClient
from azure.identity import DefaultAzureCredential, get_bearer_token_provider

logger = logging.getLogger(__name__)


def build_azure_openai_client(
    *,
    endpoint: str,
    api_version: str,
    deployment: str,
    api_key: str = "",
) -> OpenAIChatClient:
    """Create an :class:`OpenAIChatClient` for Azure OpenAI Service.

    When ``api_key`` is empty, falls back to Microsoft Entra ID via
    :class:`azure.identity.DefaultAzureCredential`.
    """

    if not endpoint:
        raise ValueError("Azure OpenAI endpoint is required")
    if not deployment:
        raise ValueError("Azure OpenAI deployment is required")

    if api_key:
        logger.info("v2_azure_openai_client_built auth=apikey deployment=%s", deployment)
        return OpenAIChatClient(
            model=deployment,
            api_key=api_key,
            azure_endpoint=endpoint,
            api_version=api_version,
        )

    logger.info("v2_azure_openai_client_built auth=entra-id deployment=%s", deployment)
    token_provider = get_bearer_token_provider(
        DefaultAzureCredential(),
        "https://cognitiveservices.azure.com/.default",
    )
    return OpenAIChatClient(
        model=deployment,
        credential=token_provider,
        azure_endpoint=endpoint,
        api_version=api_version,
    )
