/**
 * The app's own bearer token — minted once at Google sign-in
 * (`routes/auth.ts`) and verified on every subsequent request
 * (`middleware/auth.ts`). Deliberately not a JWT library: this token is never
 * read by anything but this one process, so a hand-rolled
 * `base64url(payload).base64url(HMAC-SHA256(payload))` is enough, and avoids
 * pulling in a dependency for a format nothing else needs to interoperate
 * with.
 *
 * Role and outlet are resolved once, at sign-in, from the `ADMIN_EMAILS`/
 * `GM_OUTLETS` allowlists (`config.ts`) and baked into the token — a role
 * change takes effect on that person's next sign-in, not mid-session. That's
 * a deliberate simplicity trade-off for a small internal tool, not an
 * oversight.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CurrentUserDTO } from '@toit/contracts';

export interface AppTokenPayload extends CurrentUserDTO {
  /** Issued-at, Unix seconds. */
  iat: number;
  /** Expiry, Unix seconds. */
  exp: number;
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

export function signToken(user: CurrentUserDTO, secret: string, ttlHours: number): string {
  const iat = Math.floor(Date.now() / 1000);
  const payload: AppTokenPayload = { ...user, iat, exp: iat + ttlHours * 3600 };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

/** `null` for anything malformed, mis-signed, or expired — callers treat that as "not authenticated", not an error to surface details about. */
export function verifyToken(token: string, secret: string): AppTokenPayload | null {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = sign(body, secret);

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: AppTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (typeof payload.email !== 'string' || (payload.role !== 'admin' && payload.role !== 'gm')) return null;
  return payload;
}

interface OAuthStatePayload {
  redirect: string;
  exp: number;
}

/** The OAuth `state` param — CSRF protection plus carrying the post-login return path across the Google redirect. Five minutes is plenty for a consent-screen round trip. */
export function signOAuthState(redirect: string, secret: string): string {
  const payload: OAuthStatePayload = { redirect, exp: Math.floor(Date.now() / 1000) + 300 };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

export function verifyOAuthState(state: string, secret: string): { redirect: string } | null {
  const dot = state.indexOf('.');
  if (dot < 0) return null;
  const body = state.slice(0, dot);
  const signature = state.slice(dot + 1);
  const expected = sign(body, secret);

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (typeof payload.redirect !== 'string') return null;
  return { redirect: payload.redirect };
}
