/**
 * Read-only: for every outlet-day that has been through an MPR run, builds the
 * counters the way `rebuildMprCounters.ts` would, then compares each bank's
 * total and cleared count with what the dashboard tiles count for that day
 * (re-implemented here independently of the counter code). Prints every
 * disagreement.
 *
 *   npx tsx apps/api/scripts/verifyCountersAgainstTiles.ts
 */

import { bankFamily, clearedRowsFromResult, dayTotalsFromSnapshot, type CounterBank, type DayResultLike } from '@toit/mpr-core';
import { config } from '../src/config.js';
import { getMprSessionStore } from '../src/storage/index.js';
import { getPool } from '../src/storage/postgres/pool.js';
import { buildDaySession, dayRowsFromRuns } from '../src/services/mprDayView.js';

const runs = await getMprSessionStore().listFull({ limit: 200 });
const ingested = new Set(runs.flatMap((r) => r.meta.jsonFiles.flatMap((f) => (f.sourceSessionId && !f.error ? [f.sourceSessionId] : []))));
const { rows: sessions } = await getPool().query<{ id: string; outlet: string; bd: string; snapshot: unknown }>(
  `SELECT id, outlet, data->'meta'->>'businessDate' AS bd, data->'snapshot' AS snapshot FROM recon.sessions WHERE status = 'submitted' AND data->'meta'->>'businessDate' >= $2 AND id = ANY($1) ORDER BY 3, 2`,
  [[...ingested], config.mprMailbox.startDate],
);
const outletOf = new Map(sessions.map((s) => [s.id, s.outlet] as const));
const current = new Map(sessions.map((s) => [`${s.bd}|${s.outlet}`, s.id] as const));

type Cell = { total: number; cleared: number };
const BANKS: CounterBank[] = ['amex', 'kotak', 'pinelabs', 'hdfc_upi', 'hdfc_dynamic', 'hdfc_link', 'hdfc_static'];
const blank = () => Object.fromEntries(BANKS.map((b) => [b, { total: 0, cleared: 0 }])) as Record<CounterBank, Cell>;

let cells = 0;
const bad: Array<Record<string, unknown>> = [];
for (const s of sessions) {
  const view = buildDaySession(s.bd, dayRowsFromRuns(runs, new Set([s.bd])), s.outlet);

  // What the tiles count (the dashboard's own rule: a row is reconciled when its status is 'closed').
  const tiles = blank();
  for (const r of [...view.result.settled, ...view.result.amountMismatch, ...view.result.pending]) {
    const c = tiles[bankFamily(r.acquirer)];
    c.total++;
    if (r.status === 'closed') c.cleared++;
  }
  for (const r of view.result.amexResults.filter((x) => x._match !== 'unexpected')) {
    tiles.amex.total++;
    if (r.status === 'closed') tiles.amex.cleared++;
  }
  const staticAll = new Set<string>();
  const staticDone = new Set<string>();
  for (const r of view.result.upiResults) {
    for (const p of Array.isArray(r.pr) ? r.pr : [r.pr]) {
      const t = p as { source?: string; orderNo?: string } | null;
      if (t?.source !== 'HDFC' || !t.orderNo) continue;
      staticAll.add(t.orderNo);
      if (r.status === 'closed') staticDone.add(t.orderNo);
    }
  }
  tiles.hdfc_static.total = staticAll.size;
  tiles.hdfc_static.cleared = staticDone.size;

  // What the counters would hold.
  const counters = blank();
  const totals = dayTotalsFromSnapshot(s.snapshot);
  for (const b of BANKS) counters[b].total = totals[b];
  for (const r of clearedRowsFromResult(view.result as unknown as DayResultLike, (sid) => outletOf.get(sid))) {
    if (r.outlet === s.outlet && r.sessionId === current.get(`${r.businessDate}|${r.outlet}`) && r.state !== 'mismatch') counters[r.bank].cleared++;
  }

  for (const b of BANKS) {
    cells++;
    if (tiles[b].total !== counters[b].total || tiles[b].cleared !== counters[b].cleared) {
      bad.push({ day: `${s.outlet} ${s.bd}`, bank: b, tilesCleared: `${tiles[b].cleared}/${tiles[b].total}`, countersCleared: `${counters[b].cleared}/${counters[b].total}` });
    }
  }
}
console.log(JSON.stringify({ outletDays: sessions.length, cellsCompared: cells, disagreements: bad.length }));
if (bad.length) console.table(bad);
await getPool().end();
