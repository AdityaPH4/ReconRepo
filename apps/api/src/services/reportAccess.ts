/**
 * Access control for historical submission reports.
 *
 * A GM can only open a submitted session's printable report (and see it in
 * their own "Past sessions" list) for the last `RECENT_REPORT_WINDOW_DAYS`
 * days; anything older is admin-only — an admin reaches it through the
 * by-date lookup instead (`GET /api/sessions?businessDate=`). Shared by the
 * session list route (what's "readily available") and the report route
 * itself (the actual enforcement — a bookmarked or shared link to an old
 * report must 403 the same way a GM would never have seen it listed).
 */

import type { UserRole } from '@toit/contracts';
import { todayIsoIST } from '@toit/recon-core';

export const RECENT_REPORT_WINDOW_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Falls back to the session's creation day when the Payment Report had no
 * parseable business date — mirrors `PastSessionsList.tsx`'s own
 * `businessDateLabel()` fallback, so "what's shown" and "what's allowed"
 * never disagree on which date a session counts as. `createdAt` is read in
 * IST for the same reason `today` below is — a raw UTC slice would put a
 * session created just after midnight IST on the wrong (previous) day.
 */
function effectiveDate(session: { businessDate: string | null; createdAt: string }): string {
  return session.businessDate ?? todayIsoIST(new Date(session.createdAt));
}

export function canAccessReport(
  session: { businessDate: string | null; createdAt: string },
  role: UserRole,
): boolean {
  if (role === 'admin') return true;
  const today = todayIsoIST();
  const ageDays = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${effectiveDate(session)}T00:00:00Z`)) / DAY_MS,
  );
  return Number.isFinite(ageDays) && ageDays <= RECENT_REPORT_WINDOW_DAYS;
}
