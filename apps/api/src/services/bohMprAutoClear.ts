/**
 * Auto-clears a Bill on Hold when its exact outlet + business date + amount
 * shows up as a "No RRN" row in a fresh MPR run. A ledger row with no RRN
 * can never be matched by any future bank file either — the same reasoning
 * `reconcileRetry.ts` already uses to exclude it from cross-run retry — so
 * when it lines up with an open BOH entry, that's almost certainly the same
 * real bill, just paid in a way that never generated a bank reference.
 *
 * Deliberately conservative, the same way the GM day-view's pooling is:
 * never guesses. Skips (leaves both open) when more than one open BOH entry
 * at that outlet shares the exact date+amount, and only acts once the BOH
 * has sat open at least `MIN_AGE_DAYS` — giving the normal manual-clearance
 * flow first chance, same as a human would want before something closes a
 * bill on its own.
 */

import type { MprSessionDTO } from '@toit/contracts';
import { civilToISO, OUTLET_CODES, parsePRDate, todayIsoIST, type OutletCode } from '@toit/recon-core';
import { getBohStore } from '../storage/index.js';

const MIN_AGE_DAYS = 4;
const AMOUNT_EPSILON = 0.5;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Pulls the calendar date out of a BOH entry's raw PR date/time string — same convention as `bohAging.ts`'s own `bohCivilDateISO`. `null` when unparseable. */
function bohCivilDateISO(bohDate: string): string | null {
  const civil = parsePRDate(bohDate);
  return civil ? civilToISO(civil) : null;
}

function daysBetween(earlierIso: string, laterIso: string): number {
  return Math.round((Date.parse(`${laterIso}T00:00:00Z`) - Date.parse(`${earlierIso}T00:00:00Z`)) / DAY_MS);
}

export interface BohAutoClearResult {
  cleared: number;
  skippedAmbiguous: number;
}

/** Runs once an MPR session is durably persisted — never before, so a crash mid-ingest never auto-clears against a session that didn't actually save. */
export async function autoClearBohFromNoRrn(mprSession: MprSessionDTO): Promise<BohAutoClearResult> {
  // Loose `string` on the ledger row vs. the store's strict `OutletCode` —
  // an unrecognized outlet just gets skipped rather than thrown on, since
  // this runs unattended with nobody to surface a crash to.
  const isOutletCode = (o: string | undefined): o is OutletCode => !!o && (OUTLET_CODES as readonly string[]).includes(o);
  const noRrnRows = mprSession.result.pending.filter(
    (r): r is typeof r & { outlet: OutletCode } => r._reason === 'No RRN' && isOutletCode(r.outlet),
  );
  if (noRrnRows.length === 0) return { cleared: 0, skippedAmbiguous: 0 };

  const bohStore = getBohStore();
  const today = todayIsoIST();
  const outlets = [...new Set(noRrnRows.map((r) => r.outlet))];
  const openByOutlet = new Map(
    await Promise.all(outlets.map(async (outlet) => [outlet, (await bohStore.list(outlet)).filter((e) => e.status === 'open')] as const)),
  );

  let cleared = 0;
  let skippedAmbiguous = 0;
  for (const row of noRrnRows) {
    const open = openByOutlet.get(row.outlet) ?? [];
    const candidates = open.filter((entry) => {
      const civilDate = bohCivilDateISO(entry.bohDate);
      return civilDate === row._businessDate && Math.abs(entry.amount - row.plAmount) < AMOUNT_EPSILON;
    });
    if (candidates.length === 0) continue;
    if (candidates.length > 1) {
      skippedAmbiguous++;
      continue;
    }
    const entry = candidates[0]!;
    const civilDate = bohCivilDateISO(entry.bohDate)!;
    if (daysBetween(civilDate, today) < MIN_AGE_DAYS) continue;
    await bohStore.clear(entry.id, today, mprSession.meta.id);
    cleared++;
  }
  return { cleared, skippedAmbiguous };
}
