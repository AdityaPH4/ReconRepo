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

export function buildOutletSubmissionDays(
  sessions: readonly SessionListItemDTO[],
  outlet: OutletCode,
  outletName: string,
  month: string,
  today: string,
): OutletSubmissionsDTO {
  const submittedDates = new Set(
    sessions
      .filter((s) => s.status === 'submitted' && s.businessDate?.startsWith(month))
      .map((s) => s.businessDate!),
  );
  const totalDays = daysInMonth(month);
  const days: SubmissionDayDTO[] = [];
  for (let d = 1; d <= totalDays; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    let status: SubmissionDayStatus | null;
    if (date > today) status = null;
    else if (date === today) status = 'today';
    else status = submittedDates.has(date) ? 'done' : 'missed';
    days.push({ date, status });
  }
  return { outlet, outletName, days };
}
