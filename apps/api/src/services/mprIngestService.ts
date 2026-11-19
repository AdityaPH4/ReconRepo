/**
 * Stage B of automated MPR (Layer 2) ingestion.
 *
 * Runs on its own EventBridge schedule (deliberately NOT triggered by an S3
 * event per object — see the module doc comment on why that would be
 * wrong: `runMatch()` reconciles an entire batch of bank files together, so
 * triggering once per file landing would produce multiple incomplete,
 * incorrect `MprSessionDTO`s from files that arrive minutes apart). Each
 * run: reads everything Stage A (`mailFetchService.ts`) has staged in S3
 * plus every Layer-1 session not yet folded into a completed MPR run, and
 * calls the exact same `runMprReconciliation()`/`enrichMprMatchResult()`
 * the manual upload endpoint uses — a session this produces is
 * indistinguishable in shape from one a human created by hand.
 *
 * Kotak and HDFC UPI files do not go through that batch directly. Their rows
 * are loaded into Postgres staging tables (see `mprStaging.ts` and
 * docs/superpowers/specs/2026-11-19-mpr-staging-layer-design.md) and the file
 * moves on as soon as its rows are saved — so a POS day submitted after its
 * bank file arrived still finds its rows. Every run matches ALL staged rows
 * against ALL open POS days; a row leaves staging when it is matched, or when
 * nothing matches it and its outlet's POS days are submitted (then it is
 * reported as Unexpected). Other banks keep the old path: parsed in memory
 * with the batch, files moved after the run.
 *
 * VPC-attached (needs RDS) but reaches S3 through the free S3 Gateway VPC
 * Endpoint, never the open internet — no NAT Gateway needed, unlike Stage A
 * which needs real internet access for IMAP and so deliberately runs
 * outside any VPC instead.
 *
 * Ordering matters for safety under a crash/partial failure: persist the
 * `MprSessionDTO` first, THEN save the updated per-day reconciled
 * accumulators, THEN delete the staged rows it consumed, THEN flag each source
 * session's `mprIncludedInSessionId`, THEN relocate the consumed S3 objects. A
 * crash at any point leaves the system safely retryable — worst case, a narrow
 * window produces a visible, auditable duplicate (an already-flagged session
 * reprocessed, an already-moved S3 object re-read, or an accumulator write
 * repeated — upserts are idempotent by key), never silent wrong money. A staged
 * row the match consumed, left behind by a crash after the accumulator save, is
 * swept by the next run (its RRN is already in the settled keys); one that was
 * reported as Unexpected is reported again — a visible duplicate. A file is
 * moved out of `pending/` only after its rows are committed, so an error leaves
 * it there for the next run, without stopping the other files.
 *
 * A session is only flagged `mprIncludedInSessionId` once every one of its
 * rows has a conclusive outcome — settled, mismatched, ambiguous, or "No
 * RRN" pending (a data problem no retry fixes). A row that's `pending`
 * only because no bank file has arrived *yet* ("Not in MPR", or an AMEX
 * row with no date+card match) leaves its session unflagged, so the next
 * run's `listPendingMpr()` naturally offers it again — see
 * `reconcileRetry.ts` in `@toit/mpr-core` for the matching logic, and
 * `reconciledStore.ts` for the accumulator that stops a retry from
 * regressing an already-settled row back to `pending`.
 */

import { randomUUID } from 'node:crypto';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { MprSessionDTO } from '@toit/contracts';
import { applyReconciledAccumulator, detectAdapter, parseMprFile, type ReconciledDay } from '@toit/mpr-core';
import { OUTLET_CODES } from '@toit/recon-core';
import { config } from '../config.js';
import { tryIngestLock } from '../storage/ingestLock.js';
import { autoClearBohFromNoRrn } from './bohMprAutoClear.js';
import { applyRunToCounters } from './mprCounterService.js';
import { enrichMprMatchResult, runMprReconciliation, type MprInputFile, type MprSnapshotInput } from './mprService.js';
import { missingDays, partitionStaged, rowsToParsedFiles, STAGED_ADAPTERS, toStagedRows, type PartitionContext } from './mprStaging.js';
import { loadReconciledDay, loadRecentSettledKeys, mergeReconciledItems, saveReconciledDay } from './reconciledStore.js';
import { getMprSessionStore, getMprStagingStore, getSessionStore } from '../storage/index.js';
import { createRawS3Client } from '../storage/s3ObjectStore.js';
import type { MprStagingStore, StagedBank, StagedRow } from '../storage/types.js';

/** Automated runs are attributed to a fixed, recognizable identity — never a real user email — so a human scanning `/mpr` can tell an automated run apart from a manual one at a glance. */
const AUTOMATION_ACTOR = 'automation@mpr-ingest';

async function streamToBuffer(stream: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** `mpr-inbound/pending/2026-09-29/<uuid>_Kotak_MPR.xlsx` → `Kotak_MPR.xlsx` — strips the date-folder and the dedup-uuid Stage A prepended, recovering the name `detectAdapter()` actually keys on. */
function originalNameFromKey(key: string): string {
  const base = key.split('/').pop() ?? key;
  const underscoreIdx = base.indexOf('_');
  return underscoreIdx === -1 ? base : base.slice(underscoreIdx + 1);
}

async function listPendingKeys(s3: S3Client): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: config.objectStore.bucket,
        Prefix: config.mprMailbox.s3PendingPrefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of res.Contents ?? []) {
      // A zero-byte "folder marker" object (some S3 consoles create these
      // when you click "Create folder") has no real content to parse.
      if (obj.Key && obj.Size && obj.Size > 0) keys.push(obj.Key);
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

/** S3 has no atomic rename: copy then delete. `pending/<date>/<file>` → `<toPrefix><date>/<file>`. */
async function relocate(s3: S3Client, key: string, toPrefix: string): Promise<void> {
  await s3.send(
    new CopyObjectCommand({
      Bucket: config.objectStore.bucket,
      CopySource: `${config.objectStore.bucket}/${key}`,
      Key: key.replace(config.mprMailbox.s3PendingPrefix, toPrefix),
    }),
  );
  await s3.send(new DeleteObjectCommand({ Bucket: config.objectStore.bucket, Key: key }));
}

async function deleteStaged(staging: MprStagingStore, rows: StagedRow[]): Promise<void> {
  const byBank = new Map<StagedBank, Set<string>>();
  for (const r of rows) byBank.set(r.bank, (byBank.get(r.bank) ?? new Set()).add(r.identity));
  for (const [bank, identities] of byBank) await staging.deleteByIdentity(bank, [...identities]);
}

/** What staging did this run — printed in the Lambda's output so what is waiting is visible without a screen for it. */
export interface StagingReport {
  /** Rows newly staged from this run's files. */
  loaded: number;
  /** Rows dropped because their RRN was already reconciled — a bank resending a file (at load), or what a crash left staged. */
  swept: number;
  consumed: number;
  emitted: number;
  /** Rows still waiting, by `${bank} ${outlet}` (`unmapped` when the terminal has no known outlet). */
  waiting: Record<string, number>;
  /** Earliest transaction date among the rows still waiting. */
  oldestWaiting: string | null;
  /** Waiting rows whose transaction date could not be read — they can never become Unexpected. */
  undated: number;
  /** Waiting rows by the unsubmitted POS day (`${outlet} ${yyyy-mm-dd}`) holding each back — submitting that day releases them. */
  awaitingSubmission: Record<string, number>;
  /** Terminals whose files named no known outlet. */
  unmappedTerminals: string[];
  /** Files that could not be read — moved to `failed/`. */
  failedFiles: string[];
  /** Files that hit an error while loading (database, storage) — left in `pending/`, tried again next run. */
  erroredFiles: string[];
}

const emptyStaging = (): StagingReport => ({
  loaded: 0, swept: 0, consumed: 0, emitted: 0, waiting: {}, oldestWaiting: null, undated: 0, awaitingSubmission: {}, unmappedTerminals: [], failedFiles: [], erroredFiles: [],
});

/** Fills the report's "what is still waiting, and why" part. `all` is every staged row this run saw. */
function describeWaiting(report: StagingReport, waiting: StagedRow[], all: StagedRow[], ctx: PartitionContext): void {
  for (const r of waiting) {
    const k = `${r.bank} ${r.outlet ?? 'unmapped'}`;
    report.waiting[k] = (report.waiting[k] ?? 0) + 1;
    const holding = missingDays(r, ctx);
    if (holding === null) {
      report.undated++;
      continue;
    }
    if (r.txnDate && (!report.oldestWaiting || r.txnDate < report.oldestWaiting)) report.oldestWaiting = r.txnDate;
    for (const day of holding) {
      const key = day.replace('|', ' ');
      report.awaitingSubmission[key] = (report.awaitingSubmission[key] ?? 0) + 1;
    }
  }
  report.unmappedTerminals = [...new Set(all.filter((r) => !r.outlet && r.terminal).map((r) => `${r.bank} ${r.terminal}`))].sort();
}

export interface MprIngestResult {
  ranReconciliation: boolean;
  mprSessionId: string | null;
  bankFilesProcessed: number;
  jsonSnapshotsProcessed: number;
  sourceSessionsFlagged: number;
  /** Sessions with at least one row still genuinely open (no bank file yet) — left unflagged so the next run retries them. */
  sourceSessionsStillOpen: number;
  /** Bills on Hold auto-cleared via a matching "No RRN" MPR row this run — see `bohMprAutoClear.ts`. */
  bohAutoCleared: number;
  /** "No RRN" rows that matched more than one open BOH entry at the same outlet+date+amount — left open rather than guessed. */
  bohSkippedAmbiguous: number;
  staging: StagingReport;
  /** Set when the run did nothing because another run was in progress. */
  skipped?: string;
}

const emptyResult = (o: Partial<MprIngestResult> = {}): MprIngestResult => ({
  ranReconciliation: false, mprSessionId: null, bankFilesProcessed: 0, jsonSnapshotsProcessed: 0, sourceSessionsFlagged: 0,
  sourceSessionsStillOpen: 0, bohAutoCleared: 0, bohSkippedAmbiguous: 0, staging: emptyStaging(), ...o,
});

export interface MprIngestDeps {
  /** Tests pass a fake; production builds the real client. */
  s3?: S3Client;
  /** Tests pin the clock; it sets how far back the settled-key lookback reaches. */
  now?: Date;
}

export async function runMprIngest(deps: MprIngestDeps = {}): Promise<MprIngestResult> {
  const release = await tryIngestLock();
  if (!release) {
    console.log('[mpr-ingest] another run is in progress — skipping.');
    return emptyResult({ skipped: 'another run is in progress' });
  }
  try {
    return await ingest(deps.s3 ?? createRawS3Client(config.objectStore), deps.now ?? new Date());
  } finally {
    await release();
  }
}

async function ingest(s3: S3Client, clock: Date): Promise<MprIngestResult> {
  const sessionStore = getSessionStore();
  const staging = getMprStagingStore();
  const startDate = config.mprMailbox.startDate;
  const report = emptyStaging();

  const pendingKeys = await listPendingKeys(s3);

  // Independent of the per-date accumulators below (which only cover business dates this run's own snapshots touch) — a resent bank
  // file's rows have no Layer-1 session of their own, so recognizing them as "already reconciled" needs a broader, session-agnostic
  // lookback. See `loadRecentSettledKeys`'s own doc comment.
  const recentSettledKeys = await loadRecentSettledKeys(s3, clock);
  const alreadyReconciled = (r: { rrn: string | null }) => !!r.rrn && recentSettledKeys.has(r.rrn);

  // 1. Load: Kotak / HDFC UPI files go into staging and move on as soon as their rows are saved; other banks stay for the batch below.
  // A file that errors is left where it is for the next run, and does not stop the others (nor the other banks) from going through.
  const batchKeys: string[] = [];
  let stagedFiles = 0;
  for (const key of pendingKeys) {
    const name = originalNameFromKey(key);
    const adapter = detectAdapter(name);
    const bank = adapter ? STAGED_ADAPTERS[adapter] : undefined;
    if (!adapter || !bank) {
      batchKeys.push(key);
      continue;
    }
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: config.objectStore.bucket, Key: key }));
      const parsed = parseMprFile(name, await streamToBuffer(res.Body), adapter);
      if (parsed.error) {
        console.error(`[mpr-ingest] ${name}: ${parsed.error} — moved to failed/`);
        await relocate(s3, key, config.mprMailbox.s3FailedPrefix);
        report.failedFiles.push(name);
        continue;
      }
      const rows = toStagedRows(parsed, bank, name, startDate);
      const fresh = rows.filter((r) => !alreadyReconciled(r)); // a bank resending a file: rows already reconciled are not staged again
      report.swept += rows.length - fresh.length;
      report.loaded += await staging.insertRows(fresh);
      await relocate(s3, key, config.mprMailbox.s3ProcessedPrefix); // only after the rows are committed
      stagedFiles++;
    } catch (err) {
      console.error(`[mpr-ingest] ${name}: ${(err as Error).message} — left in pending/ for the next run`);
      report.erroredFiles.push(name);
    }
  }

  // 2. Sweep: a staged row whose RRN is reconciled by now — what a crash after the accumulator save left behind — is not waiting for anything.
  const allStaged = await staging.listAll();
  const leftovers = allStaged.filter(alreadyReconciled);
  if (leftovers.length) await deleteStaged(staging, leftovers);
  report.swept += leftovers.length;
  const stagedRows = allStaged.filter((r) => !alreadyReconciled(r));

  // The submitted days are read BEFORE the open sessions: a day submitted mid-run can then never count as submitted
  // without having been matched (that would call a row Unexpected too early).
  const submitted = await sessionStore.submittedDays(startDate);
  const pendingSessions = await sessionStore.listPendingMpr();
  const ctx: PartitionContext = { submitted, outlets: OUTLET_CODES, startDate };

  // Nothing new on any side: the staged rows were judged with exactly these inputs on an earlier run, so there is nothing to match.
  if (!batchKeys.length && !pendingSessions.length && !report.loaded) {
    console.log('[mpr-ingest] nothing new on either side — no-op.');
    describeWaiting(report, stagedRows, stagedRows, ctx);
    return emptyResult({ bankFilesProcessed: stagedFiles, staging: report });
  }

  const mprInputs: MprInputFile[] = [];
  for (const key of batchKeys) {
    const res = await s3.send(new GetObjectCommand({ Bucket: config.objectStore.bucket, Key: key }));
    const buffer = await streamToBuffer(res.Body);
    mprInputs.push({ buffer, originalName: originalNameFromKey(key) });
  }

  const jsonInputs: MprSnapshotInput[] = pendingSessions
    .filter((s) => s.snapshot != null)
    .map((s) => ({
      snapshot: s.snapshot,
      sourceSessionId: s.meta.id,
      label: `${s.meta.outlet}-${s.meta.businessDate ?? 'unknown'}-${s.meta.id.slice(0, 8)}.json`,
    }));

  const outcome = runMprReconciliation(jsonInputs, mprInputs, rowsToParsedFiles(stagedRows));
  // Which staged rows the match consumed, which now count as Unexpected, and which keep waiting (those are dropped from the result).
  const partition = partitionStaged(stagedRows, outcome.result, ctx);

  const mprSessionId = randomUUID();
  const now = clock.toISOString();

  // Load every touched business date's accumulator up front, then let the
  // pure matcher-adjacent logic in @toit/mpr-core decide what's genuinely
  // new vs. already resolved by an earlier run, and which sessions still
  // have real work left for a future run to pick up.
  const accumulatorsByDate = new Map<string, ReconciledDay>(
    await Promise.all(outcome.businessDates.map(async (d) => [d, await loadReconciledDay(s3, d)] as const)),
  );
  const reconciled = applyReconciledAccumulator(partition.result, accumulatorsByDate, mprSessionId, now, recentSettledKeys);

  const mprSession: MprSessionDTO = {
    meta: {
      id: mprSessionId,
      createdAt: now,
      createdBy: AUTOMATION_ACTOR,
      jsonFiles: outcome.jsonFiles,
      mprFiles: outcome.mprFiles,
      businessDates: outcome.businessDates,
      outlets: outcome.outlets,
    },
    result: enrichMprMatchResult(reconciled.result),
  };

  await getMprSessionStore().create(mprSession);

  // Per-day counters: each ingested session's totals (from its JSON) and the transactions this run cleared. Only the sessions that were folded in without error.
  const ingestedIds = new Set(outcome.jsonFiles.filter((f) => f.sourceSessionId && !f.error).map((f) => f.sourceSessionId!));
  await applyRunToCounters(pendingSessions.filter((s) => ingestedIds.has(s.meta.id)), mprSession.result);

  // Only after the MprSessionDTO is durably persisted — a "No RRN" row can
  // never be matched by any future bank file either, so if it lines up with
  // an open Bill on Hold (same outlet + date + amount, unambiguous, old
  // enough), auto-clear it. See `bohMprAutoClear.ts`'s own doc comment.
  const bohAutoClear = await autoClearBohFromNoRrn(mprSession);

  // Only after the MprSessionDTO is durably persisted — merge this run's
  // newly-resolved rows into each touched date's accumulator. An upsert by
  // key is idempotent, so repeating this after a crash/retry is harmless.
  for (const [businessDate, newItems] of reconciled.newItemsByBusinessDate) {
    const existing = accumulatorsByDate.get(businessDate) ?? { businessDate, updatedAt: now, items: [] };
    await saveReconciledDay(s3, { businessDate, updatedAt: now, items: mergeReconciledItems(existing.items, newItems) });
  }

  // Only after the accumulator is saved — the staged rows this run matched or reported are done with.
  await deleteStaged(staging, [...partition.consumed, ...partition.emitted]);

  // Only after that — flag every source session that
  // was folded in without error AND has no row left genuinely open, so
  // the next run's listPendingMpr() correctly excludes it. A session with
  // a still-open row (no bank file for it *yet*) is deliberately left
  // unflagged, so that same query naturally retries it next time.
  let sourceSessionsFlagged = 0;
  const byId = new Map(pendingSessions.map((s) => [s.meta.id, s] as const));
  for (const jf of outcome.jsonFiles) {
    if (!jf.sourceSessionId || jf.error) continue;
    if (reconciled.stillOpenSessionIds.has(jf.sourceSessionId)) continue;
    const full = byId.get(jf.sourceSessionId);
    if (!full) continue;
    await sessionStore.update(full.meta.id, {
      ...full,
      meta: { ...full.meta, mprIncludedInSessionId: mprSession.meta.id },
    });
    sourceSessionsFlagged++;
  }

  // Only after that flagging is done — relocate the consumed S3 objects of the banks still on the batch path.
  for (const key of batchKeys) await relocate(s3, key, config.mprMailbox.s3ProcessedPrefix);

  report.consumed = partition.consumed.length;
  report.emitted = partition.emitted.length;
  describeWaiting(report, partition.waiting, stagedRows, ctx);

  console.log(
    `[mpr-ingest] created MPR session ${mprSession.meta.id} — ${mprInputs.length + stagedFiles} bank file(s), ${jsonInputs.length} snapshot(s), ` +
      `${sourceSessionsFlagged} source session(s) flagged, ${reconciled.stillOpenSessionIds.size} left open for retry, ` +
      `${bohAutoClear.cleared} BOH auto-cleared (${bohAutoClear.skippedAmbiguous} skipped, ambiguous); ` +
      `staging: ${report.loaded} loaded, ${report.swept} swept, ${report.consumed} consumed, ${report.emitted} emitted, ${partition.waiting.length} waiting, ${report.failedFiles.length} failed, ${report.erroredFiles.length} errored`,
  );

  return {
    ranReconciliation: true,
    mprSessionId: mprSession.meta.id,
    bankFilesProcessed: mprInputs.length + stagedFiles,
    jsonSnapshotsProcessed: jsonInputs.length,
    sourceSessionsFlagged,
    sourceSessionsStillOpen: reconciled.stillOpenSessionIds.size,
    bohAutoCleared: bohAutoClear.cleared,
    bohSkippedAmbiguous: bohAutoClear.skippedAmbiguous,
    staging: report,
  };
}
