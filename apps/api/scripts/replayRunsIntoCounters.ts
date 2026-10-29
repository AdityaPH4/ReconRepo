/**
 * Read-only against production, writes only to a SCRATCH database: replays
 * every stored MPR run, oldest first, into the counters the way the importer
 * does after each run (`applyRunToCounters`), then compares the end state with
 * what the dashboard tiles count for each outlet-day. This tests the live,
 * incremental update path — not the from-scratch rebuild.
 *
 *   COUNTER_TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:55432/t npx tsx apps/api/scripts/replayRunsIntoCounters.ts
 */

import { Pool } from 'pg';
import { config } from '../src/config.js';
import { bankFamily, clearedRowsFromResult, dayTotalsFromSnapshot, type CounterBank, type DayResultLike } from '@toit/mpr-core';
import { getMprSessionStore } from '../src/storage/index.js';
import { getPool } from '../src/storage/postgres/pool.js';
import { buildDaySession, dayRowsFromRuns } from '../src/services/mprDayView.js';
import { createPostgresMprCounterStore } from '../src/storage/postgres/postgresMprCounterStore.js';

const url = process.env.COUNTER_TEST_DATABASE_URL;
if (!url) throw new Error('Set COUNTER_TEST_DATABASE_URL to a scratch database — this script truncates its counter tables.');
if (url.includes('amazonaws.com')) throw new Error('Refusing to write counters to an AWS database from a replay script.');
const scratch = new Pool({ connectionString: url });
const store = createPostgresMprCounterStore(scratch);

const runs = await getMprSessionStore().listFull({ limit: 200 });
const ingested = new Set(runs.flatMap((r) => r.meta.jsonFiles.flatMap((f) => (f.sourceSessionId && !f.error ? [f.sourceSessionId] : []))));
// Every session an ingest touched, including ones since re-submitted (superseded) — a replay has to see them as the importer did.
const { rows: all } = await getPool().query<{ id: string; outlet: string; bd: string; status: string; snapshot: unknown }>(
  `SELECT id, outlet, data->'meta'->>'businessDate' AS bd, status, data->'snapshot' AS snapshot FROM recon.sessions WHERE data->'meta'->>'businessDate' >= $2 AND id = ANY($1)`,
  [[...ingested], config.mprMailbox.startDate],
);
const byId = new Map(all.map((s) => [s.id, s] as const));
const outletOf = new Map(all.map((s) => [s.id, s.outlet] as const));

await store.reset();
for (const run of [...runs].reverse()) {
  const sessions = run.meta.jsonFiles
    .flatMap((f) => (f.sourceSessionId && !f.error && byId.has(f.sourceSessionId) ? [byId.get(f.sourceSessionId)!] : []))
    .map((s) => ({ sessionId: s.id, outlet: s.outlet, businessDate: s.bd, totals: dayTotalsFromSnapshot(s.snapshot) }));
  await store.applyRun(sessions, clearedRowsFromResult(run.result as unknown as DayResultLike, (sid) => outletOf.get(sid)));
}
console.log(`replayed ${runs.length} runs`);

// Compare, for the sessions that are the current record of their day.
const current = all.filter((s) => s.status === 'submitted');
const BANKS: CounterBank[] = ['amex', 'kotak', 'pinelabs', 'hdfc_upi', 'hdfc_dynamic', 'hdfc_link', 'hdfc_static'];
let cells = 0;
const bad: Array<Record<string, unknown>> = [];
for (const s of current) {
  const view = buildDaySession(s.bd, dayRowsFromRuns(runs, new Set([s.bd])), s.outlet);
  const tiles = Object.fromEntries(BANKS.map((b) => [b, { total: 0, cleared: 0 }])) as Record<CounterBank, { total: number; cleared: number }>;
  for (const r of [...view.result.settled, ...view.result.amountMismatch, ...view.result.pending]) {
    const c = tiles[bankFamily(r.acquirer)];
    c.total++;
    if (r.status === 'closed') c.cleared++;
  }
  for (const r of view.result.amexResults.filter((x) => x._match !== 'unexpected')) {
    tiles.amex.total++;
    if (r.status === 'closed') tiles.amex.cleared++;
  }
  const all_ = new Set<string>();
  const done = new Set<string>();
  for (const r of view.result.upiResults) {
    for (const p of (Array.isArray(r.pr) ? r.pr : [r.pr]) as Array<{ source?: string; orderNo?: string }>) {
      if (p?.source !== 'HDFC' || !p.orderNo) continue;
      all_.add(p.orderNo);
      if (r.status === 'closed') done.add(p.orderNo);
    }
  }
  tiles.hdfc_static = { total: all_.size, cleared: done.size };

  const counters = await store.dayCounters(s.bd, s.outlet);
  for (const b of BANKS) {
    cells++;
    const c = counters[b];
    if (c.total !== tiles[b].total || c.settled + c.resolved !== tiles[b].cleared) {
      bad.push({ day: `${s.outlet} ${s.bd}`, bank: b, tiles: `${tiles[b].cleared}/${tiles[b].total}`, replayedCounters: `${c.settled + c.resolved}/${c.total}` });
    }
  }
}
console.log(JSON.stringify({ outletDays: current.length, cellsCompared: cells, disagreements: bad.length, openTransactions: await store.openTotal() }));
if (bad.length) console.table(bad);
await scratch.end();
await getPool().end();
