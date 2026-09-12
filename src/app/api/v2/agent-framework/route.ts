/**
 * Proxy do frontend para o backend Python.
 *
 * `?stage=discover` ranqueia oportunidades; `?stage=generate` redige o
 * documento para o alvo escolhido. Em ambos os casos a resposta e um
 * stream SSE de eventos JSON, repassado sem bufferizacao.
 */

import { NextRequest } from 'next/server';

const AGENT_FRAMEWORK_URL =
  process.env.AGENT_FRAMEWORK_URL || 'http://127.0.0.1:8000';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  if (searchParams.get('action') === 'health') {
    try {
      const upstream = await fetch(`${AGENT_FRAMEWORK_URL}/v2/health`, {
        headers: { Accept: 'application/json' },
      });
      const data = await upstream.json();
      return Response.json(data, { status: upstream.status });
    } catch {
      return Response.json(
        { status: 'unhealthy', error: 'v2 backend unreachable' },
        { status: 503 },
      );
    }
  }
  return Response.json({ error: 'Use ?action=health or POST.' }, { status: 400 });
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { grantType, customPurpose, schoolData, selectedGrant, selectedFoundation } = body as {
    grantType?: string;
    customPurpose?: string;
    schoolData?: unknown;
    selectedGrant?: unknown;
    selectedFoundation?: unknown;
  };

  if (!grantType || typeof grantType !== 'string') {
    return Response.json({ error: 'grantType is required.' }, { status: 400 });
  }

  const url = new URL(request.url);
  const stage = url.searchParams.get('stage');

  // O fluxo tem exatamente dois estagios: a Discovery ranqueia e o usuario
  // escolhe; so entao a geracao escreve.
  let upstreamPath: string;
  let upstreamBody: Record<string, unknown>;
  if (stage === 'discover') {
    upstreamPath = '/v2/workflow/discover';
    upstreamBody = { grantType, customPurpose, schoolData };
  } else if (stage === 'generate') {
    const temEdital = !!selectedGrant && typeof selectedGrant === 'object';
    const temFundacao = !!selectedFoundation && typeof selectedFoundation === 'object';
    // Espelha o contrato do backend: uma candidatura a edital e uma carta de
    // intencao a uma fundacao sao documentos diferentes.
    if (temEdital === temFundacao) {
      return Response.json(
        { error: 'Provide exactly one of selectedGrant or selectedFoundation.' },
        { status: 400 },
      );
    }
    upstreamPath = '/v2/workflow/generate';
    upstreamBody = temEdital
      ? { grantType, customPurpose, schoolData, selectedGrant }
      : { grantType, customPurpose, schoolData, selectedFoundation };
  } else {
    return Response.json(
      { error: "Unknown stage. Use ?stage=discover or ?stage=generate." },
      { status: 400 },
    );
  }

  try {
    const upstream = await fetch(
      `${AGENT_FRAMEWORK_URL}${upstreamPath}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(upstreamBody),
      },
    );

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '');
      return Response.json(
        { error: `Backend returned ${upstream.status}`, detail: text.slice(0, 500) },
        { status: upstream.status },
      );
    }

    return new Response(upstream.body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err) {
    console.error('v2 proxy error:', err);
    return Response.json(
      { error: 'Failed to reach v2 backend.' },
      { status: 503 },
    );
  }
}
