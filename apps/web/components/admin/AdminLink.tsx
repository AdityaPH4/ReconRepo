'use client';

/** A link to the approval queue, shown only to admins. */

import { useCurrentUser } from '@/components/auth/AuthProvider';

export function AdminLink() {
  const user = useCurrentUser();
  if (user.role !== 'admin') return null;
  return (
    <a className="btn" href="/admin">
      🛡 Approval requests
    </a>
  );
}
