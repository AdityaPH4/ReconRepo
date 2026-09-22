/**
 * The GM's dashboard: today's session status, a Tips-this-month total, a
 * Bills-on-Hold aging card, an Open-advances summary, and this outlet's own
 * submissions calendar.
 *
 * Tips: summed from every justification entry with `remark === 'Tips'`,
 * regardless of source — `REMARKS_EXCESS` in
 * `packages/recon-core/src/constants.ts` is shared by the Pinelabs, Cash,
 * UPI and Bank panels alike, so a tip explained on an unreconciled Pinelabs
 * row counts exactly the same as one logged on the Cash tab. This is a
 * manually-entered remark, not a column in the Payment Report — there is no
 * automatic "Tips" figure anywhere upstream of the operator marking one.
 * Grouped by each session's own `businessDate` — not `createdAt`, since a
 * session can be run a day or more late. Split into the current calendar
 * month's first half (1st–15th) and second half (16th onward) — not a
 * rolling window; matches the admin dashboard's own "current calendar
 * month" convention.
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

import type { DashboardDTO, DashboardOpenAdvanceDTO } from '@toit/contracts';
import type { OutletCode } from '@toit/recon-core';
import { advanceBalance, OUTLET_NAMES } from '@toit/recon-core';
import { getAdvanceStore, getBohStore, getSessionStore } from '../storage/index.js';
import { buildBohAging } from './bohAging.js';
import { buildOutletSubmissionDays } from './submissionCalendar.js';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function buildDashboard(outlet: OutletCode): Promise<DashboardDTO> {
  const today = todayIso();
  const month = today.slice(0, 7);
  const sessionStore = getSessionStore();

  // ── Today's status ───────────────────────────────────────────────────
  const recent = await sessionStore.list({ outlet, limit: 200 });
  const todaySession = recent.find((s) => s.businessDate === today) ?? null;
  const todayStatus = todaySession
    ? { sessionId: todaySession.id, status: todaySession.status, grandDiff: todaySession.grandDiff }
    : { sessionId: null, status: null, grandDiff: null };

  // ── Tips this month ──────────────────────────────────────────────────
  const monthStart = `${month}-01`;
  const inMonth = recent.filter((s) => s.businessDate && s.businessDate >= monthStart && s.businessDate <= today);
  let firstHalf = 0;
  let secondHalf = 0;
  for (const item of inMonth) {
    const full = await sessionStore.get(item.id);
    const businessDate = full?.meta.businessDate;
    if (!full || !businessDate) continue;
    // Every source can carry a 'Tips' remark (Pinelabs included — see the
    // module doc comment), so this deliberately does not filter by source.
    const tips = full.justification.entries
      .filter((e) => e.remark === 'Tips')
      .reduce((s, e) => s + e.amount, 0);
    const day = Number(businessDate.slice(-2));
    if (day <= 15) firstHalf += tips;
    else secondHalf += tips;
  }
  const daysThisMonth = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const tipsMonth = {
    month,
    total: firstHalf + secondHalf,
    firstHalf,
    secondHalf,
    firstHalfRange: { from: `${month}-01`, to: `${month}-15` },
    secondHalfRange: { from: `${month}-16`, to: `${month}-${String(daysThisMonth).padStart(2, '0')}` },
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
  const openAdvancesList = advances
    .filter((a) => a.status === 'open')
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
    todayStatus,
    tipsMonth,
    bohAging,
    bohTotal,
    openAdvances,
    submissions,
  };
}
