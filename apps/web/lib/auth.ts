/**
 * Client-side half of Google sign-in.
 *
 * The API owns the entire OAuth exchange (`apps/api/src/routes/auth.ts`) and
 * hands back its own short-lived bearer token via a redirect to
 * `/auth/callback` — this module just stores that token and attaches it to
 * every API call. `localStorage` rather than a cookie: this API and this web
 * app are different origins (and, per this app's LAN-access setup, sometimes
 * different hosts), where cross-site cookies are their own source of pain.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const STORAGE_KEY = 'toit_auth_token';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(STORAGE_KEY);
}

export function setToken(token: string): void {
  window.localStorage.setItem(STORAGE_KEY, token);
}

export function clearToken(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}

/** Spread into a `fetch` call's `headers` — a no-op object when signed out, so callers don't need to branch. */
export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Redirects the browser into the Google sign-in round trip. `returnTo` is where the app lands after a successful sign-in. */
export function login(returnTo: string = '/'): void {
  const params = new URLSearchParams({ redirect: returnTo });
  window.location.href = `${API_BASE}/auth/google/login?${params}`;
}

export function logout(): void {
  clearToken();
  window.location.href = '/';
}
