/**
 * The GM's dashboard: today's session status, a rolling Tips breakdown, and
 * a Bills-on-Hold aging table.
 *
 * Tips: summed from Cash/UPI/Bank justification entries with
 * `remark === 'Tips'` (`REMARKS_EXCESS` in `packages/recon-core/src/constants.ts`
 * always signs it excess), grouped by each session's own `businessDate` —
 * not `createdAt`, since a session can be run a day or more late. "Week X" is
 * the rolling sum of today back 6 days (T..T-6, 7 days); "Week X-1" is the
 * preceding 7-day window (T-7..T-13) — not calendar Monday–Sunday weeks,
 * since T-7 is already its own row in the daily breakdown.
 *
 * BOH aging: every still-open Bills-on-Hold entry, bucketed by days since
 * `bohDate` — which is the bill's own raw PR date/time string, not a clean
 * ISO date (see `BohEntry.bohDate`), so aging math parses just the calendar
 * date out of it first.
 */

import type { BohAgingBucket, DashboardDTO, DashboardTipsRowDTO } from '@toit/contracts';
import type { OutletCode } from '@toit/recon-core';
import { civilToISO, parsePRDate } from '@toit/recon-core';
import { getBohStore, getSessionStore } from '../storage/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** `dateOffset('2026-08-10', -1) === '2026-08-09'`. Pure calendar-date math, UTC — no timezone drift. */
function dateOffset(iso: string, offsetDays: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function daysBetween(earlier: string, later: string): number {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / DAY_MS);
}

/** Pulls the calendar date out of a raw PR date/time string — see `BohEntry.bohDate`. `null` when unparseable, rather than silently miscounting an entry's age. */
function bohCivilDateISO(bohDate: string): string | null {
  const civil = parsePRDate(bohDate);
  return civil ? civilToISO(civil) : null;
}

function bucketFor(ageDays: number): BohAgingBucket {
  if (ageDays <= 1) return '1';
  if (ageDays === 2) return '2';
  if (ageDays === 3) return '3';
  if (ageDays === 4) return '4';
  if (ageDays === 5) return '5';
  return '5+';
}

export async function buildDashboard(outlet: OutletCode): Promise<DashboardDTO> {
  const today = todayIso();
  const sessionStore = getSessionStore();

  // ── Today's status ───────────────────────────────────────────────────
  const recent = await sessionStore.list({ outlet, limit: 200 });
  const todaySession = recent.find((s) => s.businessDate === today) ?? null;
  const todayStatus = todaySession
    ? { sessionId: todaySession.id, status: todaySession.status, grandDiff: todaySession.grandDiff }
    : { sessionId: null, status: null, grandDiff: null };

  // ── Tips ─────────────────────────────────────────────────────────────
  const oldestNeeded = dateOffset(today, -13);
  const inRange = recent.filter((s) => s.businessDate && s.businessDate >= oldestNeeded && s.businessDate <= today);
  const tipsByDate = new Map<string, number>();
  for (const item of inRange) {
    const full = await sessionStore.get(item.id);
    const businessDate = full?.meta.businessDate;
    if (!full || !businessDate) continue;
    const tips = full.justification.entries
      .filter((e) => (e.source === 'cash' || e.source === 'upi' || e.source === 'bank') && e.remark === 'Tips')
      .reduce((s, e) => s + e.amount, 0);
    if (tips === 0) continue;
    tipsByDate.set(businessDate, (tipsByDate.get(businessDate) ?? 0) + tips);
  }

  const tips: DashboardTipsRowDTO[] = Array.from({ length: 8 }, (_, i) => {
    const date = dateOffset(today, -i);
    return { label: i === 0 ? 'T' : `T-${i}`, date, amount: tipsByDate.get(date) ?? 0 };
  });
  const sumRange = (fromOffset: number, toOffset: number) => {
    let total = 0;
    for (let i = fromOffset; i <= toOffset; i++) total += tipsByDate.get(dateOffset(today, -i)) ?? 0;
    return total;
  };
  const tipsWeekCurrent = sumRange(0, 6);
  const tipsWeekPrevious = sumRange(7, 13);

  // ── Bills-on-Hold aging ──────────────────────────────────────────────
  const bohEntries = await getBohStore().list(outlet);
  const open = bohEntries.filter((e) => e.status === 'open');
  const buckets = new Map<BohAgingBucket, { count: number; amount: number }>(
    (['1', '2', '3', '4', '5', '5+'] as const).map((b) => [b, { count: 0, amount: 0 }]),
  );
  for (const entry of open) {
    const civilDate = bohCivilDateISO(entry.bohDate);
    if (!civilDate) continue; // unparseable — don't miscount it into an arbitrary bucket
    const age = daysBetween(civilDate, today);
    const bucket = buckets.get(bucketFor(age))!;
    bucket.count += 1;
    bucket.amount += entry.amount;
  }
  const bohAging = (['1', '2', '3', '4', '5', '5+'] as const).map((bucket) => ({ bucket, ...buckets.get(bucket)! }));
  const bohTotal = open.reduce(
    (acc, e) => ({ count: acc.count + 1, amount: acc.amount + e.amount }),
    { count: 0, amount: 0 },
  );

  return { outlet, today, todayStatus, tips, tipsWeekCurrent, tipsWeekPrevious, bohAging, bohTotal };
}
