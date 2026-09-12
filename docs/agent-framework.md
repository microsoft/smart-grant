# Microsoft Agent Framework — v2 implementation

> How Smart Grant Request v2 uses the
> [Microsoft Agent Framework Python SDK 1.3.0](https://learn.microsoft.com/agent-framework/overview/?pivots=programming-language-python).
>
> This document describes the **actual implementation** as it runs today —
> not a plan. Source of truth:
> [`agent_framework_backend/v2/`](../agent_framework_backend/v2/).

---

## 1. SDK surface area in use

| Symbol | Module | Purpose |
|---|---|---|
| `Agent` | `agent_framework` | One per role (Discovery, Narrative, Budget, Compliance, Intelligence, Writer). |
| `WorkflowBuilder` | `agent_framework` | Composes the linear pipeline via `add_chain([...]).build()`. |
| `Workflow` | `agent_framework` | The runnable object returned by `.build()`. Streams events via `.run(message, stream=True)`. |
| `Executor` + `@handler` | `agent_framework` | Custom executors wrap each `Agent` to manage prompt construction, streaming, and event emission. |
| `WorkflowContext` | `agent_framework` | Per-step context. We call `add_event`, `send_message`, and `yield_output`. |
| `WorkflowEvent` | `agent_framework` | Event payloads emitted to the SSE stream. |
| `OpenAIChatClient` | `agent_framework_openai` | The chat client given to every `Agent`. Wraps an `AsyncAzureOpenAI` we construct explicitly. |

Verify the live runtime:

```bash
curl.exe -s http://127.0.0.1:8000/v2/health | python -m json.tool
```

The `workflow_engine` block reports the actual class names and `agent_framework`
version from the running Python process.

---

## 2. Authentication — keyless Foundry

The SDK's default `OpenAIChatClient` constructor resolves environment
variables eagerly and will inject `AZURE_OPENAI_API_KEY` even when a
credential is also supplied. Foundry resources with key auth **disabled**
reject that combo with `403 AuthenticationTypeDisabled`.

The workaround in [providers/foundry.py](../agent_framework_backend/v2/providers/foundry.py)
constructs `AsyncAzureOpenAI` ourselves and wraps it:

```python
from agent_framework_openai import OpenAIChatClient
from azure.identity import DefaultAzureCredential, get_bearer_token_provider
from openai import AsyncAzureOpenAI

credential = DefaultAzureCredential()
token_provider = get_bearer_token_provider(
    credential, "https://cognitiveservices.azure.com/.default"
)
azure_client = AsyncAzureOpenAI(
    azure_endpoint=settings.foundry_endpoint,
    api_version=settings.foundry_api_version,  # 2025-03-01-preview
    azure_ad_token_provider=token_provider,
)
return OpenAIChatClient(model=deployment, async_client=azure_client)
```

Required env vars (see [.env.example](../.env.example)):

```bash
FOUNDRY_ENDPOINT=https://<project>.cognitiveservices.azure.com/
FOUNDRY_API_VERSION=2025-03-01-preview     # required for the Responses API
FOUNDRY_USE_AAD=true                       # use DefaultAzureCredential
FOUNDRY_DEPLOYMENT_GPT_5_4=gpt-5.4
# FOUNDRY_API_KEY=                          # leave blank when AAD is on
```

Sign in locally once:

```bash
az login --scope https://cognitiveservices.azure.com/.default
```

---

## 3. Default model

**GPT-5.4** on Azure AI Foundry (deployment `gpt-5.4`) is used by every agent
unless explicitly overridden. Per-agent overrides via
`AGENT_MODEL_DISCOVERY=...`, `AGENT_MODEL_NARRATIVE=...`, etc.

---

## 4. The agent catalogue

Defined in [agent_framework_backend/v2/agents.py](../agent_framework_backend/v2/agents.py):

```python
PIPELINE: tuple[AgentSpec, ...] = (
    AgentSpec(key="discovery",   ..., system_prompt=_strip_emojis(DISCOVERY_AGENT_PROMPT)),
    AgentSpec(key="narrative",   ..., system_prompt=_strip_emojis(NARRATIVE_AGENT_PROMPT)),
    AgentSpec(key="budget",      ..., system_prompt=_strip_emojis(BUDGET_AGENT_PROMPT)),
    AgentSpec(key="compliance",  ..., system_prompt=_strip_emojis(COMPLIANCE_AGENT_PROMPT)),
    AgentSpec(key="intelligence",..., system_prompt=_strip_emojis(INTELLIGENCE_AGENT_PROMPT)),
    AgentSpec(key="writer",      ..., system_prompt=_strip_emojis(APPLICATION_WRITER_PROMPT)),
)
```

Each `AgentSpec` carries:

- `system_prompt` — the v1 prompt with all decorative emojis stripped at
  import time. The agents never see pictographic glyphs, so they never emit
  them.
- `build_user_prompt(ctx)` — pure function that turns the accumulated
  `AgentContext` into the user message string.
- `response_format` — a Pydantic model (`DiscoveryOutput`, `NarrativeOutput`,
  `BudgetOutput`, `ComplianceOutput`, `IntelligenceOutput`, `ApplicationOutput`).
- `max_tokens` / `temperature` — tuned per role.

---

## 5. Workflow construction

In [agent_framework_backend/v2/workflow.py](../agent_framework_backend/v2/workflow.py),
each `AgentSpec` is wrapped in a `_GrantAgentExecutor` (`Executor` subclass)
with a `@handler` method that:

1. Builds the user prompt from the `AgentContext`.
2. Calls `self._bound.agent.run(user_prompt, stream=True)` (positional arg —
   the SDK no longer accepts `messages=`).
3. Iterates the async response, calling `ctx.add_event(...)` for each token,
   `ctx.send_message(...)` to pass the updated context downstream, and
   `ctx.yield_output(...)` at the end to surface the final structured output.

The chain is then assembled:

```python
workflow = (
    WorkflowBuilder()
    .add_chain([
        setup_executor,
        discovery_executor, narrative_executor, budget_executor,
        compliance_executor, intelligence_executor, writer_executor,
    ])
    .build()
)
```

And streamed:

```python
async for event in workflow.run(
    initial_inputs,
    stream=True,
    include_status_events=False,
):
    ...   # forwarded to SSE
```

### Gotchas (already addressed)

- **No `from __future__ import annotations`** — the SDK's runtime handler
  validation inspects `__annotations__` literally and fails on string-form
  generics like `WorkflowContext[AgentContext]`.
- **Dataclass declaration order matters** — `_WorkflowInputs` must be defined
  **before** the `_Setup` executor that annotates a handler with it.
- **`agent.run(user_prompt, stream=True)`** — first positional argument, not
  `messages=`.

---

## 6. Structured outputs

Each agent emits a Pydantic model. Example from
[`agent_framework_backend/v2/schemas.py`](../agent_framework_backend/v2/schemas.py):

```python
class BudgetLine(BaseModel):
    category: Literal["personnel", "equipment", "supplies",
                     "training", "travel", "indirect"]
    description: str
    amount_usd: float
    justification: str

class BudgetOutput(BaseModel):
    total_usd: float
    lines: list[BudgetLine]
    notes: str
```

Downstream agents receive these as typed objects in the `AgentContext.outputs`
dict — they are not strings to re-parse.

---

## 7. Observability

- One OpenTelemetry span per agent execution.
- Span attributes: `agent.name`, `model.provider`, `model.deployment`,
  `tokens.prompt`, `tokens.completion`, `cost.usd_estimate`, `duration.ms`.
- Spans export to OTLP via `OTEL_EXPORTER_OTLP_ENDPOINT`.

---

## 8. Status

| Step | Status |
|---|---|
| `ModelRouter` + Foundry chat client | Done |
| Wrap each agent in SDK `Agent` | Done |
| Real `Workflow` behind the SSE endpoints | Done |
| Typed Pydantic outputs across all hand-offs | Done |
| Human-in-the-loop split (rank, choose, write) | Done |
| Remove the original manual loop | Done — deleted from the tree, not merely bypassed |
| Wire OpenTelemetry exporters end to end | Partial — spans emitted, OTLP target configurable |
| Per-agent observability dashboard | Pending (roadmap) |
| Multi-model A/B routing surfaced in UI | Pending (roadmap) |
