"""
Azure AI Foundry chat-client factory.

Returns a Microsoft Agent Framework :class:`OpenAIChatClient` configured
for an Azure AI Foundry deployment (e.g. GPT-5.4 on
``https://<project>.cognitiveservices.azure.com/``).

Why a factory and not a custom subclass?
    The agent-framework SDK already implements the chat-completions
    transport, retries, streaming, telemetry, and tool-calling for both
    OpenAI and Azure OpenAI / Foundry. Re-implementing it would duplicate
    code and miss SDK upgrades. The factory only carries the project's
    configuration into the SDK constructor.
"""

from __future__ import annotations

import logging

from agent_framework.openai import OpenAIChatClient

from v2.settings import V2Settings

logger = logging.getLogger(__name__)


def build_foundry_client(
    *,
    settings: V2Settings,
    deployment: str,
) -> OpenAIChatClient:
    """Create an :class:`OpenAIChatClient` bound to a Foundry deployment.

    Parameters
    ----------
    settings:
        Loaded :class:`V2Settings` providing endpoint, API key, and version.
    deployment:
        Name of the Foundry deployment to call (e.g. ``"gpt-5.4"``).
    """

    if not settings.foundry_endpoint:
        raise ValueError("FOUNDRY_ENDPOINT is not configured")
    if not deployment:
        raise ValueError("Foundry deployment name is required")

    use_aad = settings.foundry_use_aad or not settings.foundry_api_key

    if use_aad:
        from azure.identity import DefaultAzureCredential, get_bearer_token_provider
        from openai import AsyncAzureOpenAI

        credential = DefaultAzureCredential()
        token_provider = get_bearer_token_provider(
            credential, "https://cognitiveservices.azure.com/.default"
        )
        # Build the Azure client ourselves so the SDK's implicit env-file
        # resolution cannot inject AZURE_OPENAI_API_KEY alongside our token
        # provider (which a keyless Foundry resource would reject).
        azure_client = AsyncAzureOpenAI(
            azure_endpoint=settings.foundry_endpoint,
            api_version=settings.foundry_api_version,
            azure_ad_token_provider=token_provider,
        )
        logger.info(
            "v2_foundry_client_built auth=aad deployment=%s endpoint=%s",
            deployment,
            settings.foundry_endpoint,
        )
        return OpenAIChatClient(model=deployment, async_client=azure_client)

    logger.info(
        "v2_foundry_client_built auth=key deployment=%s endpoint=%s",
        deployment,
        settings.foundry_endpoint,
    )
    return OpenAIChatClient(
        model=deployment,
        api_key=settings.foundry_api_key,
        azure_endpoint=settings.foundry_endpoint,
        api_version=settings.foundry_api_version,
    )
