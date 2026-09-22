'use client';

/**
 * Loads and renders a session stored server-side, for `/recon/sessions/[id]`.
 *
 * Fetched client-side, not in the page's Server Component: this app's auth
 * token lives only in browser `localStorage` (see `lib/auth.ts`), which a
 * Server Component has no access to — a server-side fetch here would always
 * 401. Mirrors the loading/error gate `AuthProvider` already uses.
 */

import type { SessionDTO } from '@toit/contracts';
import { useEffect, useState } from 'react';
import { Header } from '@/components/Header';
import { SessionWorkspace } from '@/components/SessionWorkspace';
import { ApiError, getSession } from '@/lib/api';

type State =
  | { status: 'loading' }
  | { status: 'not-found' }
  | { status: 'error'; message: string }
  | { status: 'ready'; session: SessionDTO };

export function StoredSessionView({ id }: { id: string }) {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    getSession(id)
      .then((session) => {
        if (!cancelled) setState({ status: 'ready', session });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setState({ status: 'not-found' });
        } else {
          setState({ status: 'error', message: err instanceof ApiError ? err.message : 'Failed to load session.' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (state.status === 'loading') {
    return (
      <main className="app-main">
        <p className="text-body text-ink-3">Loading…</p>
      </main>
    );
  }

  if (state.status === 'not-found') {
    return (
      <main className="app-main">
        <div className="alert alert-err">
          <span>✕</span>
          <span>Session not found.</span>
        </div>
      </main>
    );
  }

  if (state.status === 'error') {
    return (
      <main className="app-main">
        <div className="alert alert-err">
          <span>✕</span>
          <span>{state.message}</span>
        </div>
      </main>
    );
  }

  const { session } = state;
  return (
    <>
      <Header meta={session.meta} subtitle={`Business date: ${session.meta.businessDate ?? '—'}`} />
      <SessionWorkspace session={session} />
    </>
  );
}
