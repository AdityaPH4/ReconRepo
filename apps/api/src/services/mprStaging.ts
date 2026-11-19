/**
 * The pure half of MPR staging: turning parsed bank files into staged rows,
 * staged rows back into engine input, and deciding — after a match — what
 * happens to each staged row. See
 * docs/superpowers/specs/2026-11-19-mpr-staging-layer-design.md.
 *
 * A staged row ends a run in exactly one of three states:
 *  - consumed — the engine matched it (settled / amount mismatch / UPI match);
 *  - emitted  — nothing matched it and its outlet's POS days are submitted, so
 *               it goes to the Unexpected (or Duplicate-RRN) list;
 *  - waiting  — everything else; it stays staged for a later run.
 * The match engine itself is untouched.
 */

import type { AdapterKey, MatchResult, MprRow, ParsedMprFile, UnexpectedMprRow } from '@toit/mpr-core';
import type { StagedBank, StagedRow, StagedRowInput } from '../storage/types.js';
import { addDays, classifyFile, outletOfTerminal } from './mailFetchLedger.js';

/** Banks whose files go through staging, by the adapter the file name resolves to. */
export const STAGED_ADAPTERS: Partial<Record<AdapterKey, StagedBank>> = { KOTAK: 'kotak', HDFC_UPI: 'hdfc_upi' };

/** The match engine's own row identity (`engine/match.ts`) — what makes two rows "the same row" across files. */
export const rowIdentity = (r: Pick<MprRow, '_source' | 'rrn' | 'grossAmount' | 'txnDateRaw' | 'txnDate' | 'settlementDate'>): string =>
  `${r._source}|${r.rrn}|${r.grossAmount}|${r.txnDateRaw || r.txnDate}|${r.settlementDate}`;

/** The identity of the bank row behind an `unexpected` entry — built from the same fields the engine copied out of it. */
export const unexpectedIdentity = (u: Pick<UnexpectedMprRow, '_source' | 'rrn' | 'mprAmount' | 'mprTxnDate' | 'mprDate'>): string =>
  `${u._source}|${u.rrn}|${u.mprAmount}|${u.mprTxnDate}|${u.mprDate}`;

const readableDate = (s: string | null | undefined): string | null => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);

/**
 * One parsed bank file → the rows to stage. A row dated before `startDate` is out of MPR's scope and dropped;
 * one whose date can't be read is kept (with a null date) so it can wait and be reported.
 */
export function toStagedRows(parsed: ParsedMprFile, bank: StagedBank, originalName: string, startDate: string): StagedRowInput[] {
  const terminal = classifyFile(originalName)?.terminal ?? '';
  const outlet = outletOfTerminal(bank, terminal);
  const seen = new Map<string, number>();
  const out: StagedRowInput[] = [];
  for (const row of parsed.rows as MprRow[]) {
    const txnDate = readableDate(row.txnDate);
    if (txnDate && txnDate < startDate) continue;
    const identity = rowIdentity(row);
    const occurrence = (seen.get(identity) ?? 0) + 1;
    seen.set(identity, occurrence);
    out.push({ bank, identity, occurrence, rrn: row.rrn, txnDate, terminal, outlet, fileName: parsed.filename, row });
  }
  return out;
}

/** Staged rows regrouped by the file they came from, in load order — the shape `runMatch` reads. */
export function rowsToParsedFiles(staged: StagedRow[]): ParsedMprFile[] {
  const files = new Map<string, ParsedMprFile>();
  for (const s of staged) {
    const key = `${s.bank}|${s.fileName}`;
    let file = files.get(key);
    if (!file) {
      file = { source: s.row._source, matchStrategy: 'rrn', rows: [], filename: s.fileName };
      files.set(key, file);
    }
    (file.rows as MprRow[]).push(s.row);
  }
  return [...files.values()];
}

export interface PartitionContext {
  /** `${outlet}|${yyyy-mm-dd}` of every submitted POS day (`SessionStore.submittedDays`). */
  submitted: ReadonlySet<string>;
  /** Every outlet code — a row from a terminal with no known outlet has to wait for all of them. */
  outlets: readonly string[];
  /** `MPR_START_DATE`: a day before it counts as submitted. */
  startDate: string;
}

/**
 * Whether an unmatched row may be called Unexpected: its outlet's POS day (the row's own date) and the day before
 * are both submitted. The day before, because a 1 AM sale is dated the next day but belongs to the previous POS day.
 */
export function readyToReport(row: Pick<StagedRow, 'txnDate' | 'outlet'>, ctx: PartitionContext): boolean {
  if (!row.txnDate) return false;
  const days = [row.txnDate, addDays(row.txnDate, -1)];
  return (row.outlet ? [row.outlet] : ctx.outlets).every((o) => days.every((d) => d < ctx.startDate || ctx.submitted.has(`${o}|${d}`)));
}

export interface Partition {
  consumed: StagedRow[];
  emitted: StagedRow[];
  waiting: StagedRow[];
  /** The match result without the Unexpected / Duplicate-RRN entries of rows that are still waiting; emitted Unexpected rows carry their outlet and date. */
  result: MatchResult;
}

export function partitionStaged(staged: StagedRow[], result: MatchResult, ctx: PartitionContext): Partition {
  const stagedBy = new Map<string, StagedRow>(); // first occurrence stands for its twins: they share a file, terminal and date
  for (const s of staged) if (!stagedBy.has(s.identity)) stagedBy.set(s.identity, s);

  const consumedIds = new Set<string>();
  for (const r of [...result.settled, ...result.amountMismatch]) consumedIds.add(rowIdentity(r.mpr));
  for (const u of result.upiResults) if (u.mpr) consumedIds.add(rowIdentity(u.mpr));

  const emittedIds = new Set<string>();
  const unexpected: UnexpectedMprRow[] = [];
  for (const u of result.unexpected) {
    const id = unexpectedIdentity(u);
    const s = stagedBy.get(id);
    if (!s) {
      unexpected.push(u); // a row from a file outside staging — reported as before
    } else if (!consumedIds.has(id) && readyToReport(s, ctx)) {
      unexpected.push({ ...u, ...(s.outlet ? { outlet: s.outlet } : {}), txnDate: s.txnDate });
      emittedIds.add(id);
    }
  }

  const ambiguous: MatchResult['ambiguous'] = [];
  for (const a of result.ambiguous) {
    const open = [...new Set(a.candidates.map(rowIdentity))].filter((id) => stagedBy.has(id) && !consumedIds.has(id));
    if (open.every((id) => readyToReport(stagedBy.get(id)!, ctx))) {
      ambiguous.push(a);
      for (const id of open) emittedIds.add(id);
    }
  }

  const out: Partition = { consumed: [], emitted: [], waiting: [], result: { ...result, unexpected, ambiguous } };
  for (const s of staged) (consumedIds.has(s.identity) ? out.consumed : emittedIds.has(s.identity) ? out.emitted : out.waiting).push(s);
  return out;
}
