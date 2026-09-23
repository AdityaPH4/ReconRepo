/**
 * The day-order gate: an outlet's reconciliations must be submitted one
 * calendar day at a time, in order — a GM can't jump ahead to a later date
 * while an earlier one is still outstanding. This is a *forward* guard only;
 * it never blocks redoing an already-submitted date (that's
 * `approvalService.ts`'s own, separate gate) or backfilling an older gap
 * that predates this feature.
 */

import type { OutletCode } from '@toit/recon-core';
import { getSessionStore } from '../storage/index.js';

export class DateGapError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'DateGapError';
  }
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * The business date this outlet needs reconciled next — the day right after
 * its most recently *submitted* date. `null` on an outlet's first-ever
 * submission, where there's no history to compute a "next" date from (any
 * date is accepted). Shared by `assertNoDateGap` (the enforcement) and the
 * GM dashboard (proactively showing this date before an upload is even
 * attempted), so the two can never disagree on what "next" means.
 *
 * Known limitation: this is "latest submitted + 1", not "the first actual
 * gap". An admin (exempt from `assertNoDateGap`) can submit a later date
 * directly, e.g. to fix something, leaving days before it un-reconciled —
 * this function then points past that gap rather than at it, so the GM
 * dashboard banner won't call it out. `SubmissionCalendar`'s own per-day
 * "missed" markers still surface it; accepted as a rare, admin-created edge
 * case rather than building full gap-scanning for it.
 */
export async function nextExpectedReconDate(outlet: OutletCode): Promise<string | null> {
  // `list()` defaults to only the 50 most recent (by createdAt) — nowhere
  // near enough here. This needs the outlet's *entire* submitted history to
  // find the true highest business date, since createdAt order and
  // businessDate order can diverge (an older date backfilled after a newer
  // one is already submitted) — an undersized window could silently return
  // a stale, too-early date, which would then either mis-show the dashboard
  // banner or wrongly 403 a legitimate next-day upload as a "gap".
  const submitted = await getSessionStore().list({ outlet, status: 'submitted', limit: 100_000 });
  const dates = submitted.map((s) => s.businessDate).filter((d): d is string => d !== null);
  if (!dates.length) return null;

  const lastDate = dates.reduce((max, d) => (d > max ? d : max));
  return addDays(lastDate, 1);
}

/**
 * Throws `DateGapError` if `businessDate` is later than the very next day
 * after this outlet's most recently *submitted* date — i.e. a skipped day.
 * Nothing to enforce on an outlet's first-ever submission, and a date at or
 * before the last submitted one is never blocked here (a same-day redo goes
 * through `assertReconAllowed`'s own approval gate instead; an older
 * backfill is always allowed).
 */
export async function assertNoDateGap(outlet: OutletCode, businessDate: string | null): Promise<void> {
  if (!businessDate) return; // nothing to key the gate on — matches `assertReconAllowed`'s own tolerance.

  const expectedNext = await nextExpectedReconDate(outlet);
  if (expectedNext === null) return; // first-ever submission for this outlet — nothing to enforce yet.
  if (businessDate <= expectedNext) return;

  throw new DateGapError(
    `${outlet} still has ${expectedNext} left to reconcile — days must be done in order, one at a time. ` +
      `Upload ${expectedNext}'s files before ${businessDate}.`,
  );
}
