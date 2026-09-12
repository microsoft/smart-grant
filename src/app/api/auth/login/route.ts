import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import {
  AUTH_USERNAME,
  AUTH_PASSWORD,
  AUTH_SECRET,
  isAuthConfigured,
  SESSION_TTL_SECONDS,
} from '@/lib/auth-config';

// HMAC, not sha256(payload + secret): the latter is a Merkle-Damgard
// construction and allows length-extension forgery of the signature.
function sign(payload: string): string {
  return createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
}

export async function POST(request: NextRequest) {
  // A deployment without credentials must not mint sessions. Previously a
  // missing AUTH_SECRET was replaced by a per-process random value, which the
  // middleware could never reproduce.
  if (!isAuthConfigured) {
    return NextResponse.json(
      { error: 'Authentication is not configured on this deployment.' },
      { status: 503 }
    );
  }

  let username: unknown;
  let password: unknown;
  try {
    const body = await request.json();
    username = body?.username;
    password = body?.password;
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (typeof username !== 'string' || typeof password !== 'string') {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
  }

  const userMatch = username === AUTH_USERNAME;
  // Use timing-safe comparison for password
  const passBuffer = Buffer.from(password);
  const expectedBuffer = Buffer.from(AUTH_PASSWORD);
  const passMatch =
    passBuffer.length === expectedBuffer.length &&
    timingSafeEqual(passBuffer, expectedBuffer);

  if (!userMatch || !passMatch) {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
  }

  const expires = Date.now() + SESSION_TTL_SECONDS * 1000;
  const token = `${expires}`;
  const signature = sign(token);
  const cookieValue = `${token}.${signature}`;

  const response = NextResponse.json({ ok: true });
  response.cookies.set('auth_token', cookieValue, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });

  return response;
}
