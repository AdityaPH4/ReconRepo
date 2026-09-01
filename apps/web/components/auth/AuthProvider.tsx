'use client';

/**
 * The app-wide auth gate. Wraps every page (`app/layout.tsx`): checks the
 * stored bearer token against `GET /api/me` once on load, and either renders
 * a "Sign in with Google" screen or the app itself with the current user
 * available via `useCurrentUser()`.
 *
 * When `AUTH_SECRET` isn't set on the API (dev-stub mode — see
 * `apps/api/src/middleware/auth.ts`), `/api/me` always succeeds with the
 * fixed dev identity, so this gate is a no-op locally until Google
 * credentials are actually wired up.
 */

import type { CurrentUserDTO } from '@toit/contracts';
import { usePathname } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { getMe } from '@/lib/api';
import { login } from '@/lib/auth';

/** The callback page has no token yet when it first mounts — it must render unguarded so it can store the one arriving in the URL. */
const UNGUARDED_PATHS = new Set(['/auth/callback']);

interface AuthCtxValue {
  user: CurrentUserDTO;
}

const AuthCtx = createContext<AuthCtxValue | null>(null);

export function useCurrentUser(): CurrentUserDTO {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useCurrentUser() must be used inside AuthProvider');
  return ctx.user;
}

type State = { status: 'loading' } | { status: 'signed-out' } | { status: 'signed-in'; user: CurrentUserDTO };

export function AuthProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const unguarded = UNGUARDED_PATHS.has(pathname);
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    if (unguarded) return;
    let cancelled = false;
    getMe()
      .then((user) => {
        if (!cancelled) setState({ status: 'signed-in', user });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'signed-out' });
      });
    return () => {
      cancelled = true;
    };
  }, [unguarded]);

  if (unguarded) return <>{children}</>;

  if (state.status === 'loading') {
    return (
      <main className="app-main">
        <p className="text-body text-ink-3">Loading…</p>
      </main>
    );
  }

  if (state.status === 'signed-out') {
    return (
      <main className="app-main">
        <div className="card" style={{ maxWidth: 420, margin: '4rem auto' }}>
          <div className="card-body text-center">
            <h1 className="text-lede font-semibold mb-2">Toit Reconciliation</h1>
            <p className="text-body text-ink-3 mb-4">Sign in with your Toit Google account to continue.</p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => login(typeof window !== 'undefined' ? window.location.pathname : '/')}
            >
              Sign in with Google
            </button>
          </div>
        </div>
      </main>
    );
  }

  return <AuthCtx.Provider value={{ user: state.user }}>{children}</AuthCtx.Provider>;
}
