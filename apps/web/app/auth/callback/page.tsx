'use client';

/**
 * Where Google sign-in lands after the API's `/auth/google/callback`
 * finishes the OAuth exchange (`apps/api/src/routes/auth.ts`) — the API
 * redirects here with either `?token=&redirect=` (success) or `?error=`.
 */

import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';
import { setToken } from '@/lib/auth';

const ERROR_MESSAGES: Record<string, string> = {
  invalid_state: 'That sign-in link expired or was tampered with. Try signing in again.',
  no_id_token: 'Google did not return an identity token. Try signing in again.',
  unverified_email: 'That Google account’s email isn’t verified.',
  not_provisioned: 'Your Google account isn’t set up for this app yet — ask an admin to add you.',
  sign_in_failed: 'Sign-in failed. Try again, or ask an admin if it keeps happening.',
};

function Callback() {
  const router = useRouter();
  const params = useSearchParams();

  useEffect(() => {
    const token = params.get('token');
    const redirect = params.get('redirect');
    if (token) {
      setToken(token);
      router.replace(redirect && redirect.startsWith('/') ? redirect : '/');
    }
  }, [params, router]);

  const error = params.get('error');
  if (error) {
    return (
      <main className="app-main">
        <div className="card" style={{ maxWidth: 420, margin: '4rem auto' }}>
          <div className="card-body text-center">
            <h1 className="text-lede font-semibold mb-2">Sign-in problem</h1>
            <p className="text-body text-ink-3 mb-4">{ERROR_MESSAGES[error] ?? 'Something went wrong signing in.'}</p>
            <a className="btn btn-primary" href="/">
              Back to Toit Reconciliation
            </a>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="app-main">
      <p className="text-body text-ink-3">Signing you in…</p>
    </main>
  );
}

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={<main className="app-main" />}>
      <Callback />
    </Suspense>
  );
}
