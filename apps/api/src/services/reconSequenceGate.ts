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
 * Throws `DateGapError` if `businessDate` is later than the very next day
 * after this outlet's most recently *submitted* date — i.e. a skipped day.
 * Nothing to enforce on an outlet's first-ever submission, and a date at or
 * before the last submitted one is never blocked here (a same-day redo goes
 * through `assertReconAllowed`'s own approval gate instead; an older
 * backfill is always allowed).
 */
export async function assertNoDateGap(outlet: OutletCode, businessDate: string | null): Promise<void> {
  if (!businessDate) return; // nothing to key the gate on — matches `assertReconAllowed`'s own tolerance.

  const submitted = await getSessionStore().list({ outlet, status: 'submitted' });
  const dates = submitted.map((s) => s.businessDate).filter((d): d is string => d !== null);
  if (!dates.length) return; // first-ever submission for this outlet — nothing to enforce yet.

  const lastDate = dates.reduce((max, d) => (d > max ? d : max));
  const expectedNext = addDays(lastDate, 1);
  if (businessDate <= expectedNext) return;

  throw new DateGapError(
    `${outlet} still has ${expectedNext} left to reconcile — days must be done in order, one at a time. ` +
      `Upload ${expectedNext}'s files before ${businessDate}.`,
  );
}
