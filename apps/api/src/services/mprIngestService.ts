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
 * VPC-attached (needs RDS) but reaches S3 through the free S3 Gateway VPC
 * Endpoint, never the open internet — no NAT Gateway needed, unlike Stage A
 * which needs real internet access for IMAP and so deliberately runs
 * outside any VPC instead.
 *
 * Ordering matters for safety under a crash/partial failure: persist the
 * `MprSessionDTO` first, THEN save the updated per-day reconciled
 * accumulators, THEN flag each source session's `mprIncludedInSessionId`,
 * THEN relocate the consumed S3 objects. A crash at any point leaves the
 * system safely retryable — worst case, a narrow window produces a
 * visible, auditable duplicate (an already-flagged session reprocessed, an
 * already-moved S3 object re-read, or an accumulator write repeated —
 * upserts are idempotent by key), never silent wrong money. See the
 * approved plan for the full reasoning.
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
import { applyReconciledAccumulator, type ReconciledDay } from '@toit/mpr-core';
import { config } from '../config.js';
import { autoClearBohFromNoRrn } from './bohMprAutoClear.js';
import { enrichMprMatchResult, runMprReconciliation, type MprInputFile, type MprSnapshotInput } from './mprService.js';
import { loadReconciledDay, loadRecentSettledKeys, mergeReconciledItems, saveReconciledDay } from './reconciledStore.js';
import { getMprSessionStore, getSessionStore } from '../storage/index.js';
import { createRawS3Client } from '../storage/s3ObjectStore.js';

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
}

export async function runMprIngest(): Promise<MprIngestResult> {
  const s3 = createRawS3Client(config.objectStore);
  const sessionStore = getSessionStore();

  const pendingKeys = await listPendingKeys(s3);
  const pendingSessions = await sessionStore.listPendingMpr();

  if (!pendingKeys.length && !pendingSessions.length) {
    console.log('[mpr-ingest] nothing pending on either side — no-op.');
    return {
      ranReconciliation: false, mprSessionId: null, bankFilesProcessed: 0,
      jsonSnapshotsProcessed: 0, sourceSessionsFlagged: 0, sourceSessionsStillOpen: 0,
      bohAutoCleared: 0, bohSkippedAmbiguous: 0,
    };
  }

  const mprInputs: MprInputFile[] = [];
  for (const key of pendingKeys) {
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

  const outcome = runMprReconciliation(jsonInputs, mprInputs);

  const mprSessionId = randomUUID();
  const now = new Date().toISOString();

  // Load every touched business date's accumulator up front, then let the
  // pure matcher-adjacent logic in @toit/mpr-core decide what's genuinely
  // new vs. already resolved by an earlier run, and which sessions still
  // have real work left for a future run to pick up.
  const accumulatorsByDate = new Map<string, ReconciledDay>(
    await Promise.all(outcome.businessDates.map(async (d) => [d, await loadReconciledDay(s3, d)] as const)),
  );
  // Independent of `accumulatorsByDate` above (which only covers business
  // dates *this run's own* JSON snapshots touch) — a resent bank file's
  // rows have no Layer-1 session of their own, so recognizing them as
  // "already reconciled" needs a broader, session-agnostic lookback. See
  // `loadRecentSettledKeys`'s own doc comment.
  const recentSettledKeys = await loadRecentSettledKeys(s3);
  const reconciled = applyReconciledAccumulator(outcome.result, accumulatorsByDate, mprSessionId, now, recentSettledKeys);

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

  // Only after the accumulator is saved — flag every source session that
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

  // Only after that flagging is done — relocate the consumed S3 objects.
  // S3 has no atomic rename: copy then delete.
  for (const key of pendingKeys) {
    const destKey = key.replace(config.mprMailbox.s3PendingPrefix, config.mprMailbox.s3ProcessedPrefix);
    await s3.send(
      new CopyObjectCommand({
        Bucket: config.objectStore.bucket,
        CopySource: `${config.objectStore.bucket}/${key}`,
        Key: destKey,
      }),
    );
    await s3.send(new DeleteObjectCommand({ Bucket: config.objectStore.bucket, Key: key }));
  }

  console.log(
    `[mpr-ingest] created MPR session ${mprSession.meta.id} — ${mprInputs.length} bank file(s), ${jsonInputs.length} snapshot(s), ` +
      `${sourceSessionsFlagged} source session(s) flagged, ${reconciled.stillOpenSessionIds.size} left open for retry, ` +
      `${bohAutoClear.cleared} BOH auto-cleared (${bohAutoClear.skippedAmbiguous} skipped, ambiguous)`,
  );

  return {
    ranReconciliation: true,
    mprSessionId: mprSession.meta.id,
    bankFilesProcessed: mprInputs.length,
    jsonSnapshotsProcessed: jsonInputs.length,
    sourceSessionsFlagged,
    sourceSessionsStillOpen: reconciled.stillOpenSessionIds.size,
    bohAutoCleared: bohAutoClear.cleared,
    bohSkippedAmbiguous: bohAutoClear.skippedAmbiguous,
  };
}
