/**
 * Rebuilds the per-day MPR counters (`mpr_day_totals` / `mpr_day_cleared`)
 * from everything already stored: the totals from each ingested session's
 * saved JSON, and the cleared transactions from the one-row-per-transaction
 * day view of the stored runs.
 *
 * Run once after creating the tables, and again any time the counters are
 * suspected of drifting:
 *
 *   npx tsx apps/api/scripts/rebuildMprCounters.ts --dry-run   # compute and print, write nothing
 *   npx tsx apps/api/scripts/rebuildMprCounters.ts             # replace the counters
 *
 * Loads every stored run into memory once (a few hundred MB) — not something
 * to run on a loop.
 */

import { clearedRowsFromResult, dayTotalsFromSnapshot, type ClearedRow, type DayResultLike } from '@toit/mpr-core';
import { config } from '../src/config.js';
import { getMprCounterStore, getMprSessionStore } from '../src/storage/index.js';
import { getPool } from '../src/storage/postgres/pool.js';
import { buildDaySession, dayRowsFromRuns } from '../src/services/mprDayView.js';

const dryRun = process.argv.includes('--dry-run');

const runs = await getMprSessionStore().listFull({ limit: 200 });
console.log(`loaded ${runs.length} stored runs`);

// Only sessions an ingest run actually folded in have counters; a day no run has touched yet isn't an MPR item.
const ingested = new Set(runs.flatMap((r) => r.meta.jsonFiles.flatMap((f) => (f.sourceSessionId && !f.error ? [f.sourceSessionId] : []))));
const { rows: sessions } = await getPool().query<{ id: string; outlet: string; bd: string; snapshot: unknown }>(
  `SELECT id, outlet, data->'meta'->>'businessDate' AS bd, data->'snapshot' AS snapshot
   FROM recon.sessions WHERE status = 'submitted' AND data->'meta'->>'businessDate' >= $2 AND id = ANY($1)`,
  [[...ingested], config.mprMailbox.startDate],
);
console.log(`${sessions.length} submitted sessions have been through an MPR run`);

const outletOf = new Map(sessions.map((s) => [s.id, s.outlet] as const));
const currentSession = new Map(sessions.map((s) => [`${s.bd}|${s.outlet}`, s.id] as const));

const counterSessions = sessions.map((s) => ({ sessionId: s.id, outlet: s.outlet, businessDate: s.bd, totals: dayTotalsFromSnapshot(s.snapshot) }));
const cleared: ClearedRow[] = [];
for (const s of sessions) {
  const view = buildDaySession(s.bd, dayRowsFromRuns(runs, new Set([s.bd])), s.outlet);
  // Rows from an older, since re-submitted session of the same day don't describe the day any more.
  const mine = clearedRowsFromResult(view.result as unknown as DayResultLike, (sid) => outletOf.get(sid)).filter(
    (r) => r.outlet === s.outlet && r.sessionId === currentSession.get(`${r.businessDate}|${r.outlet}`),
  );
  cleared.push(...mine);
}

const totalTx = counterSessions.reduce((n, s) => n + Object.values(s.totals).reduce((a, b) => a + b, 0), 0);
const done = cleared.filter((r) => r.state !== 'mismatch').length;
console.log(`transactions: ${totalTx} total · ${done} cleared · ${cleared.length - done} mismatched · ${totalTx - done} open`);

if (dryRun) {
  console.log('dry run — nothing written');
} else {
  const store = getMprCounterStore();
  await store.reset();
  await store.applyRun(counterSessions, cleared);
  console.log(`written — open transactions now: ${await store.openTotal()}`);
}
await getPool().end();
