'use client';

/**
 * The home-page entry point into `/admin` — the admin dashboard (submissions
 * calendar, comment review, approval requests). Still shows a live count of
 * pending approval requests right on the card, so an admin sees there's
 * something waiting without opening the dashboard first. Same
 * corner-link-to-real-module promotion the "Unreconciled TDS" module got —
 * see `AdminLink.tsx`'s history; this replaces it.
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
      title="Admin Dashboard"
      description="Submission timeliness across outlets, recent comments to review, and approval requests from GMs waiting on your decision."
      badge={pendingCount}
    />
  );
}