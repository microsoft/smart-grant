import { NextRequest, NextResponse } from 'next/server';
import { AUTH_SECRET, isAuthConfigured } from '@/lib/auth-config';

/**
 * Constant-time comparison of two hex strings. A plain `!==` leaks, through
 * timing, how many leading characters of a forged signature were correct.
 */
function timingSafeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function verify(cookieValue: string): Promise<boolean> {
  // Fail closed: with no configured secret every signature is unverifiable,
  // so nothing may be trusted.
  if (!isAuthConfigured) return false;

  const dot = cookieValue.lastIndexOf('.');
  if (dot === -1) return false;

  const token = cookieValue.slice(0, dot);
  const signature = cookieValue.slice(dot + 1);

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(AUTH_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const hashBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(token));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const expected = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  if (!timingSafeEquals(signature, expected)) return false;

  const expires = parseInt(token, 10);
  return !isNaN(expires) && Date.now() < expires;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow auth routes, static assets, and API routes through
  if (
    pathname.startsWith('/login') ||
    pathname.startsWith('/api/auth') ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname === '/api/v2/agent-framework' ||
    pathname === '/api/v2/analytics' ||
    pathname === '/api/v2/analytics/pulse'
  ) {
    return NextResponse.next();
  }

  // `verify` is async: it must be awaited. Testing the Promise itself is
  // always truthy and would accept any non-empty cookie.
  const token = request.cookies.get('auth_token')?.value;
  if (!token || !(await verify(token))) {
    const loginUrl = new URL('/login', request.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
