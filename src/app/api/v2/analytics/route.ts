/**
 * Proxy for `/v2/analytics/landscape` on the Python backend.
 *
 * The endpoint is a simple read-only GET that returns a live aggregate
 * over the public Grants.gov ``search2`` API (cached server-side for
 * 10 minutes). We forward to the backend and surface a friendly error
 * shape if the backend is unreachable.
 */

const AGENT_FRAMEWORK_URL =
  process.env.AGENT_FRAMEWORK_URL || 'http://127.0.0.1:8000';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    const upstream = await fetch(
      `${AGENT_FRAMEWORK_URL}/v2/analytics/landscape`,
      {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      },
    );
    const data = await upstream.json();
    return Response.json(data, { status: upstream.status });
  } catch {
    return Response.json(
      { error: 'Analytics backend unreachable.' },
      { status: 503 },
    );
  }
}
