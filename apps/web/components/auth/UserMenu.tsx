'use client';

/** Signed-in email + sign-out, dropped into any header. */

import { useCurrentUser } from '@/components/auth/AuthProvider';
import { logout } from '@/lib/auth';

export function UserMenu() {
  const user = useCurrentUser();
  return (
    <span className="flex items-center gap-2 text-tiny text-ink-3">
      {user.email}
      <button type="button" className="btn btn-sm" onClick={logout}>
        Sign out
      </button>
    </span>
  );
}
