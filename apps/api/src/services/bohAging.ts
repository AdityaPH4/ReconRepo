/**
 * Bills-on-Hold aging — buckets every still-open entry by days since
 * `bohDate`, which is the bill's own raw PR date/time string, not a clean
 * ISO date (see `BohEntry.bohDate`), so aging math parses just the calendar
 * date out of it first. Shared by the GM dashboard (one outlet) and the
 * admin dashboard (every outlet, looped, plus a combined total).
 */

import type { BohAgingBucket, BohEntryDTO, DashboardBohAgingRowDTO } from '@toit/contracts';
import { civilToISO, parsePRDate } from '@toit/recon-core';

const DAY_MS = 24 * 60 * 60 * 1000;
const BUCKETS = ['1', '2', '3', '4', '5', '5+'] as const;

function daysBetween(earlier: string, later: string): number {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / DAY_MS);
}

/** Pulls the calendar date out of a raw PR date/time string — see `BohEntry.bohDate`. `null` when unparseable, rather than silently miscounting an entry's age. */
function bohCivilDateISO(bohDate: string): string | null {
  const civil = parsePRDate(bohDate);
  return civil ? civilToISO(civil) : null;
}

/** Day 0 (opened today) folds into bucket '1', same as the old scheme folded day 0 into '0-7' — every open entry lands in exactly one bucket. */
function bucketFor(ageDays: number): BohAgingBucket {
  if (ageDays <= 1) return '1';
  if (ageDays <= 2) return '2';
  if (ageDays <= 3) return '3';
  if (ageDays <= 4) return '4';
  if (ageDays <= 5) return '5';
  return '5+';
}

export function buildBohAging(
  entries: readonly BohEntryDTO[],
  today: string,
): { bohAging: DashboardBohAgingRowDTO[]; bohTotal: { count: number; amount: number } } {
  const open = entries.filter((e) => e.status === 'open');
  const buckets = new Map<BohAgingBucket, { count: number; amount: number; entries: BohEntryDTO[] }>(
    BUCKETS.map((b) => [b, { count: 0, amount: 0, entries: [] }]),
  );
  for (const entry of open) {
    const civilDate = bohCivilDateISO(entry.bohDate);
    if (!civilDate) continue; // unparseable — don't miscount it into an arbitrary bucket
    const age = daysBetween(civilDate, today);
    const bucket = buckets.get(bucketFor(age))!;
    bucket.count += 1;
    bucket.amount += entry.amount;
    bucket.entries.push(entry);
  }
  const bohAging = BUCKETS.map((bucket) => ({ bucket, ...buckets.get(bucket)! }));
  const bohTotal = open.reduce(
    (acc, e) => ({ count: acc.count + 1, amount: acc.amount + e.amount }),
    { count: 0, amount: 0 },
  );
  return { bohAging, bohTotal };
}

/** The single highest non-zero bucket present — `null` if every bucket is empty. Bucket severity order matches `BUCKETS` (oldest last). */
export function worstBohBucket(bohAging: readonly DashboardBohAgingRowDTO[]): BohAgingBucket | null {
  for (let i = BUCKETS.length - 1; i >= 0; i--) {
    const row = bohAging.find((r) => r.bucket === BUCKETS[i]);
    if (row && row.count > 0) return row.bucket;
  }
  return null;
}
