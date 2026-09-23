/**
 * The GM's dashboard: today's session status, the next business date due
 * (`nextExpectedReconDate` — see `reconSequenceGate.ts`, the same
 * computation the upload gate itself enforces against), a Tips-this-month
 * total, a Bills-on-Hold aging card, an Open-advances summary, and this
 * outlet's own submissions calendar.
 *
 * Tips: summed from every justification entry with `remark === 'Tips'`,
 * regardless of source — `REMARKS_EXCESS` in
 * `packages/recon-core/src/constants.ts` is shared by the Pinelabs, Cash,
 * UPI and Bank panels alike, so a tip explained on an unreconciled Pinelabs
 * row counts exactly the same as one logged on the Cash tab. This is a
 * manually-entered remark, not a column in the Payment Report — there is no
 * automatic "Tips" figure anywhere upstream of the operator marking one.
 * Grouped by each session's own `businessDate` — not `createdAt`, since a
 * session can be run a day or more late. Shown as 4 half-month periods —
 * previous month's two halves, then the current calendar month's two
 * halves (1st–15th, 16th–end) — not a rolling window; the current month's
 * two halves match the admin dashboard's own "current calendar month"
 * convention, extended one month back so a GM can compare against last
 * month at a glance.
 *
 * BOH aging: every still-open Bills-on-Hold entry, bucketed by days since
 * `bohDate` — which is the bill's own raw PR date/time string, not a clean
 * ISO date (see `BohEntry.bohDate`), so aging math parses just the calendar
 * date out of it first.
 *
 * Open advances: every still-open advance for this outlet, with its balance
 * (`originalAmount` minus applications so far, via `advanceBalance()`),
 * soonest `eventDate` first, capped at 5 — a "view all" link covers the rest.
 */

import type { DashboardDTO, DashboardOpenAdvanceDTO, DashboardTipsPeriodDTO } from '@toit/contracts';
import type { OutletCode } from '@toit/recon-core';
import { advanceBalance, isAdvanceExhausted, OUTLET_NAMES, todayIsoIST } from '@toit/recon-core';
import { getAdvanceStore, getBohStore, getSessionStore } from '../storage/index.js';
import { buildBohAging } from './bohAging.js';
import { nextExpectedReconDate } from './reconSequenceGate.js';
import { buildOutletSubmissionDays } from './submissionCalendar.js';

/** The calendar month immediately before `month` (`yyyy-mm`) — wraps Jan back to December of the prior year via `Date`'s own rollover. */
function prevMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y!, m! - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y!, m!, 0)).getUTCDate();
}

/** A month's own two halves: 1st–15th, 16th–end of month. */
function halfMonthRanges(month: string): [{ from: string; to: string }, { from: string; to: string }] {
  const days = daysInMonth(month);
  return [
    { from: `${month}-01`, to: `${month}-15` },
    { from: `${month}-16`, to: `${month}-${String(days).padStart(2, '0')}` },
  ];
}

export async function buildDashboard(outlet: OutletCode): Promise<DashboardDTO> {
  const today = todayIsoIST();
  const month = today.slice(0, 7);
  const sessionStore = getSessionStore();

  // ── Today's status ───────────────────────────────────────────────────
  const recent = await sessionStore.list({ outlet, limit: 200 });
  const todaySession = recent.find((s) => s.businessDate === today) ?? null;
  const todayStatus = todaySession
    ? { sessionId: todaySession.id, status: todaySession.status, grandDiff: todaySession.grandDiff }
    : { sessionId: null, status: null, grandDiff: null };

  // ── Next date due ─────────────────────────────────────────────────────
  const nextReconDate = await nextExpectedReconDate(outlet);

  // ── Tips: 4 half-month periods ───────────────────────────────────────
  const periodRanges = [...halfMonthRanges(prevMonth(month)), ...halfMonthRanges(month)];
  const earliestNeeded = periodRanges[0]!.from;
  const inRange = recent.filter((s) => s.businessDate && s.businessDate >= earliestNeeded && s.businessDate <= today);
  const periodTotals = periodRanges.map(() => 0);
  for (const item of inRange) {
    const full = await sessionStore.get(item.id);
    const businessDate = full?.meta.businessDate;
    if (!full || !businessDate) continue;
    // Every source can carry a 'Tips' remark (Pinelabs included — see the
    // module doc comment), so this deliberately does not filter by source.
    const tips = full.justification.entries
      .filter((e) => e.remark === 'Tips')
      .reduce((s, e) => s + e.amount, 0);
    const idx = periodRanges.findIndex((r) => businessDate >= r.from && businessDate <= r.to);
    if (idx !== -1) periodTotals[idx]! += tips;
  }
  const tipsMonth = {
    month,
    // This month only — its own two halves, the last two entries in `periods`.
    total: periodTotals[2]! + periodTotals[3]!,
    periods: periodRanges.map((range, i): DashboardTipsPeriodDTO => ({ range, total: periodTotals[i]! })),
  };

  // ── Bills-on-Hold aging ──────────────────────────────────────────────
  const bohEntries = await getBohStore().list(outlet);
  const { bohAging, bohTotal } = buildBohAging(bohEntries, today);

  // ── Open advances ────────────────────────────────────────────────────
  const advanceStore = getAdvanceStore();
  const [advances, applications] = await Promise.all([
    advanceStore.list(outlet),
    advanceStore.listApplications(outlet),
  ]);
  // `status !== 'closed'`, not `=== 'open'` — defensive against a
  // pre-existing row whose stored JSON predates that field, matching
  // `eligibleAdvances()`'s own filter. Also excludes an advance that's
  // fully applied (balance exhausted) but never explicitly closed — it has
  // nothing left owing, so it doesn't belong on an "open advances" card.
  const openAdvancesList = advances
    .filter((a) => a.status !== 'closed' && !isAdvanceExhausted(a, applications))
    .map((a) => ({ advance: a, balance: advanceBalance(a, applications) }))
    .sort((a, b) => a.advance.eventDate.localeCompare(b.advance.eventDate));
  const openAdvances = {
    count: openAdvancesList.length,
    totalBalance: openAdvancesList.reduce((sum, a) => sum + a.balance, 0),
    items: openAdvancesList.slice(0, 5).map(
      (a): DashboardOpenAdvanceDTO => ({
        id: a.advance.id,
        custName: a.advance.custName,
        eventDate: a.advance.eventDate,
        balance: a.balance,
      }),
    ),
  };

  // ── Submissions calendar ─────────────────────────────────────────────
  const submissions = buildOutletSubmissionDays(recent, outlet, OUTLET_NAMES[outlet], month, today);

  return {
    outlet,
    today,
    nextReconDate,
    todayStatus,
    tipsMonth,
    bohAging,
    bohTotal,
    openAdvances,
    submissions,
  };
}
