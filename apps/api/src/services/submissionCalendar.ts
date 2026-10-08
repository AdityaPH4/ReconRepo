/**
 * Builds one outlet's submission-timeliness calendar for a given month —
 * shared by the GM dashboard (its own outlet) and the admin dashboard
 * (every outlet, looped).
 */

import type { OutletSubmissionsDTO, SessionListItemDTO, SubmissionDayDTO, SubmissionDayStatus } from '@toit/contracts';
import type { OutletCode } from '@toit/recon-core';

export function daysInMonth(month: string): number {
  const [year, mon] = month.split('-').map(Number);
  return new Date(Date.UTC(year!, mon!, 0)).getUTCDate();
}

/**
 * One session per date — `supersedeSessions()` discards any sibling the
 * moment one session for an outlet+date is submitted (or a GM starts
 * fresh), so `sessions` (already filtered to non-discarded by the store's
 * default `list()`) never carries more than one entry per date here.
 */
export function buildOutletSubmissionDays(
  sessions: readonly SessionListItemDTO[],
  outlet: OutletCode,
  outletName: string,
  month: string,
  today: string,
  assignedGms: readonly string[] = [],
): OutletSubmissionsDTO {
  const byDate = new Map<string, SessionListItemDTO>();
  for (const s of sessions) {
    if (s.businessDate?.startsWith(month)) byDate.set(s.businessDate, s);
  }
  const totalDays = daysInMonth(month);
  const days: SubmissionDayDTO[] = [];
  for (let d = 1; d <= totalDays; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    let status: SubmissionDayStatus | null;
    if (date > today) {
      status = null;
    } else {
      const session = byDate.get(date);
      const lockedCount = session?.submittedModules.length ?? 0;
      if (session?.status === 'submitted') {
        status = session.allExplainedRoutine ? 'green' : 'yellow';
      } else if (lockedCount > 0) {
        // Some modules locked via partial submission, the rest still open.
        status = 'orange';
      } else if (date === today) {
        // Nothing submitted yet, but not due until end of day — not a miss.
        status = 'today';
      } else {
        status = 'red';
      }
    }
    days.push({ date, status });
  }
  return { outlet, outletName, days, assignedGms: [...assignedGms] };
}
