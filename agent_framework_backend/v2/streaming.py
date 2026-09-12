"""Adaptador SSE dos eventos do workflow.

Existe um unico dialeto: JSON, um evento por linha ``data:``. O dialeto
compacto (``a:``/``c:``/``d:``) que servia o frontend antigo foi removido
junto com ele -- manter dois formatos sem consumidor era superficie morta.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterable, AsyncIterator

from v2.events import WorkflowEvent


async def to_json_sse(events: AsyncIterable[WorkflowEvent]) -> AsyncIterator[str]:
    """Yield richer JSON SSE events for new clients.

    Each event has the shape::

        data: {"type":"token","agentIndex":0,"agentName":"Discovery Agent","payload":"…"}\n\n
    """

    async for ev in events:
        yield f"data: {json.dumps(ev.to_dict(), ensure_ascii=False)}\n\n"
    yield "event: end\ndata: {}\n\n"
