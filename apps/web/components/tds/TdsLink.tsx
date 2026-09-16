'use client';

/** A link to the unreconciled-TDS management page, shown only to admins. */

import { useCurrentUser } from '@/components/auth/AuthProvider';

export function TdsLink() {
  const user = useCurrentUser();
  if (user.role !== 'admin') return null;
  return (
    <a className="btn" href="/tds">
      🧾 Unreconciled TDS
    </a>
  );
}
