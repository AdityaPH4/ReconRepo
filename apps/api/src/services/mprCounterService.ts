/**
 * Keeps the per-day MPR counters (`mpr_day_totals` / `mpr_day_cleared`) in
 * step with the ingest runs and with admin resolutions. See `schema.sql` for
 * what the counters are.
 *
 * Both entry points swallow and log their own failures: the day views read
 * the stored rows directly, so a missed counter update never makes a screen
 * wrong or fails a bank import — it only leaves the counter behind until the
 * next run touches that day or `scripts/rebuildMprCounters.ts` is run.
 */

import type { MprMatchResultDTO, MprSessionDTO, SessionDTO } from '@toit/contracts';
import { clearedRowsFromResult, dayTotalsFromSnapshot, type DayResultLike } from '@toit/mpr-core';
import { config } from '../config.js';
import { getMprCounterStore } from '../storage/index.js';

/** One ingest run: every successfully-ingested session's totals, plus what this run cleared. */
export async function applyRunToCounters(
  ingested: SessionDTO[],
  result: MprMatchResultDTO,
): Promise<void> {
  try {
    const sessions = ingested
      // Days before the MPR rollout date are out of scope entirely (the same cutoff `listPendingMpr` applies), so they never count as open.
      .filter((s) => s.snapshot != null && s.meta.businessDate && s.meta.businessDate >= config.mprMailbox.startDate)
      .map((s) => ({
        sessionId: s.meta.id,
        outlet: s.meta.outlet,
        businessDate: s.meta.businessDate!,
        totals: dayTotalsFromSnapshot(s.snapshot),
      }));
    const outletOf = new Map(sessions.map((s) => [s.sessionId, s.outlet] as const));
    const cleared = clearedRowsFromResult(result as unknown as DayResultLike, (sid) => outletOf.get(sid)).filter((r) => outletOf.has(r.sessionId));
    await getMprCounterStore().applyRun(sessions, cleared);
  } catch (err) {
    console.error('[mpr-counters] failed to apply run:', err);
  }
}

/** An admin resolved one open row of a stored run — it now counts as cleared. */
export async function recordResolvedRow(
  session: MprSessionDTO,
  bucket: keyof MprMatchResultDTO,
  row: MprMatchResultDTO[keyof MprMatchResultDTO][number],
): Promise<void> {
  try {
    if (bucket === 'ambiguous' || bucket === 'unexpected' || bucket === 'settled') return; // not a JSON transaction, or already cleared
    const mini = { settled: [], amountMismatch: [], pending: [], amexResults: [], upiResults: [], [bucket]: [row] } as unknown as DayResultLike;
    const outletBySession = new Map(session.meta.jsonFiles.flatMap((f) => (f.sourceSessionId && f.outlet ? [[f.sourceSessionId, f.outlet] as const] : [])));
    const rows = clearedRowsFromResult(mini, (sid) => outletBySession.get(sid));
    if (rows.length) await getMprCounterStore().markResolved(rows);
  } catch (err) {
    console.error('[mpr-counters] failed to record a resolved row:', err);
  }
}
