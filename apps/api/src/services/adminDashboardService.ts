/**
 * Admin dashboard — cross-outlet submission timeliness + a comment feed for
 * review. Mounted at `/api/admin/dashboard`, admin-only.
 *
 * No month picker yet — always the current calendar month, matching the GM
 * dashboard's own Tips panel ("just show the current window").
 */

import { OUTLET_CODES, OUTLET_NAMES } from '@toit/recon-core';
import type { AdminCommentDTO, AdminDashboardDTO, AdminOutletSubmissionsDTO, AdminSubmissionDayDTO, SubmissionDayStatus } from '@toit/contracts';
import { getSessionStore } from '../storage/index.js';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysInMonth(month: string): number {
  const [year, mon] = month.split('-').map(Number);
  return new Date(Date.UTC(year!, mon!, 0)).getUTCDate();
}

export async function buildAdminDashboard(): Promise<AdminDashboardDTO> {
  const store = getSessionStore();
  const today = todayIso();
  const month = today.slice(0, 7);
  const totalDays = daysInMonth(month);

  const submissions: AdminOutletSubmissionsDTO[] = [];
  const allComments: AdminCommentDTO[] = [];

  for (const outlet of OUTLET_CODES) {
    // One fetch, reused for both the submissions calendar and the comment
    // feed below — an internal tool with modest session volume, same
    // "walk N recent session blobs" cost already accepted by the MPR
    // open-rows aggregation and the GM dashboard's own Tips loop.
    const sessions = await store.list({ outlet, limit: 200 });

    // ── Submissions ──────────────────────────────────────────────────
    const submittedDates = new Set(
      sessions
        .filter((s) => s.status === 'submitted' && s.businessDate?.startsWith(month))
        .map((s) => s.businessDate!),
    );
    const days: AdminSubmissionDayDTO[] = [];
    for (let d = 1; d <= totalDays; d++) {
      const date = `${month}-${String(d).padStart(2, '0')}`;
      let status: SubmissionDayStatus | null;
      if (date > today) status = null;
      else if (date === today) status = 'today';
      else status = submittedDates.has(date) ? 'done' : 'missed';
      days.push({ date, status });
    }
    submissions.push({ outlet, outletName: OUTLET_NAMES[outlet], days });

    // ── Comments — bounded to the 60 most recent sessions per outlet, ──
    // "recent" not exhaustive.
    for (const item of sessions.slice(0, 60)) {
      const full = await store.get(item.id);
      if (!full) continue;
      for (const e of full.justification.entries) {
        const text = e.description || e.comment || e.notes || e.reason || '';
        if (!text.trim()) continue; // nothing to review
        allComments.push({
          id: e.id,
          sessionId: full.meta.id,
          outlet,
          businessDate: full.meta.businessDate,
          remark: e.remark,
          direction: e.direction,
          amount: e.amount,
          text,
          createdAt: e.createdAt,
          createdBy: full.meta.createdBy,
        });
      }
    }
  }

  allComments.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return { month, submissions, recentComments: allComments.slice(0, 50) };
}
