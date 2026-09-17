'use client';

/**
 * The "Approval Requests" module card — admin-only, shows a live count of
 * pending re-reconciliation approval requests right on the card, so an
 * admin sees there's something waiting without opening the queue first.
 * Same corner-link-to-real-module promotion the "Unreconciled TDS" module
 * got — see `AdminLink.tsx`'s history; this replaces it.
 */

import { useEffect, useState } from 'react';
import { useCurrentUser } from '@/components/auth/AuthProvider';
import { ModuleCard } from '@/components/ModuleCard';
import { listApprovalRequests } from '@/lib/api';

export function ApprovalsModuleCard() {
  const user = useCurrentUser();
  const [pendingCount, setPendingCount] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (user.role !== 'admin') return;
    listApprovalRequests({ status: 'pending' })
      .then((rows) => setPendingCount(rows.length))
      .catch(() => setPendingCount(undefined));
  }, [user.role]);

  if (user.role !== 'admin') return null;

  return (
    <ModuleCard
      href="/admin"
      icon="🛡"
      title="Approval Requests"
      description="Re-reconciliation requests from GMs waiting on your decision — approve or deny before they can re-run an outlet's already-reconciled business date."
      badge={pendingCount}
    />
  );
}
