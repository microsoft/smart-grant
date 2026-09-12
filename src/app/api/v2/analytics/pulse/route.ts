/**
 * Proxy for `/v2/analytics/pulse` on the Python backend.
 *
 * Portal-usage analytics — sectors, states, schools, funders, and
 * the live activity feed. GET-only, never cached, friendly 503 if the
 * backend is unreachable.
 *
 * `?window=` é repassado apenas quando casa com os valores aceitos pelo
 * backend; qualquer outra coisa cai no padrão em vez de virar um 422 que o
 * painel teria de saber interpretar.
 */

import { NextRequest } from 'next/server';

const AGENT_FRAMEWORK_URL =
  process.env.AGENT_FRAMEWORK_URL || 'http://127.0.0.1:8000';

const WINDOWS = new Set(['7', '30', '90', '365', 'all']);

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest) {
  const requested = new URL(request.url).searchParams.get('window');
  const window = requested && WINDOWS.has(requested) ? requested : '30';

  try {
    const upstream = await fetch(
      `${AGENT_FRAMEWORK_URL}/v2/analytics/pulse?window=${window}`,
      {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      },
    );
    const data = await upstream.json();
    return Response.json(data, { status: upstream.status });
  } catch {
    return Response.json(
      { error: 'Pulse analytics backend unreachable.' },
      { status: 503 },
    );
  }
}
