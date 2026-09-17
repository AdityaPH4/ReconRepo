'use client';

/**
 * Home-page card for the open MPR items queue — admin-only, mirrors
 * `ApprovalsModuleCard.tsx`'s live badge-count pattern.
 */

import { useEffect, useState } from 'react';
import { useCurrentUser } from '@/components/auth/AuthProvider';
import { ModuleCard } from '@/components/ModuleCard';
import { listOpenMprRows } from '@/lib/mprApi';

export function MprOpenItemsModuleCard() {
  const user = useCurrentUser();
  const [openCount, setOpenCount] = useState(0);

  useEffect(() => {
    if (user.role !== 'admin') return;
    listOpenMprRows()
      .then((rows) => setOpenCount(rows.length))
      .catch(() => setOpenCount(0));
  }, [user.role]);

  if (user.role !== 'admin') return null;

  return (
    <ModuleCard
      href="/mpr/open-items"
      icon="🧮"
      title="Open MPR Items"
      description="Every mismatch, pending, ambiguous or unexpected MPR row across all runs that's still awaiting resolution."
      badge={openCount}
    />
  );
}
