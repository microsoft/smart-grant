/**
 * Single source of truth for authentication configuration.
 *
 * This module is imported by both runtimes:
 *   - Node runtime  -> src/app/api/auth/login/route.ts   (issues the cookie)
 *   - Edge runtime  -> src/middleware.ts                 (verifies the cookie)
 *
 * Because the Edge runtime is involved it must not use Node built-ins.
 *
 * Previously each side resolved AUTH_SECRET independently and with different
 * fallbacks, so the issuer and the verifier could silently disagree. Reading
 * the values here exactly once guarantees they cannot drift apart.
 *
 * In production every value must be supplied by the environment. When any of
 * them is missing the application fails closed: sign-in is refused and no
 * cookie is ever accepted.
 */

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Local development conveniences. Never used when NODE_ENV === 'production'.
// These are deliberately self-describing placeholders. A fallback must never
// be a value that is (or ever was) a real credential, otherwise a
// misconfigured deployment silently accepts a password an attacker already
// knows from the source tree.
const DEV_USERNAME = 'admin';
const DEV_PASSWORD = 'dev-only-password-never-valid-in-production';
const DEV_SECRET = 'dev-only-secret-never-valid-in-production';

export const AUTH_USERNAME =
  process.env.AUTH_USERNAME || (IS_PRODUCTION ? '' : DEV_USERNAME);

export const AUTH_PASSWORD =
  process.env.AUTH_PASSWORD || (IS_PRODUCTION ? '' : DEV_PASSWORD);

export const AUTH_SECRET =
  process.env.AUTH_SECRET || (IS_PRODUCTION ? '' : DEV_SECRET);

/**
 * True only when every credential required to both issue and verify a session
 * is present. When false the deployment is misconfigured and must not
 * authenticate anyone.
 */
export const isAuthConfigured =
  AUTH_USERNAME.length > 0 && AUTH_PASSWORD.length > 0 && AUTH_SECRET.length > 0;

/** Session lifetime, shared by the cookie maxAge and the token expiry claim. */
export const SESSION_TTL_SECONDS = 24 * 60 * 60;
