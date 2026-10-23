/**
 * Per-business-date accumulator of everything MPR has ever matched for
 * that date, across however many automated ingest runs it took.
 *
 * Why this exists: Stage B (`mprIngestService.ts`) now lets a session with
 * genuinely-open rows (no bank file for them *yet* — not a data problem)
 * stay eligible for a future run to retry, instead of being flagged
 * "done" after one pass. But by the time that retry runs, the bank file
 * that already settled this *same* session's other rows has been
 * relocated out of the pending S3 prefix and is gone from the pool — so
 * without a durable record of "this specific row already settled, on an
 * earlier run", a retry would wrongly show it as `pending` again,
 * regressing a correct result. This file is that durable record: one
 * JSON object per business date, upserted by every ingest run (automated
 * or manual) that touches that date.
 *
 * Scoped by business date, not by session or outlet — multiple outlets'
 * sessions for the same date land in the same file; `sourceSessionId` on
 * each item is what keeps their keys from colliding.
 */

import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { ReconciledDay, ReconciledItem } from '@toit/mpr-core';
import { config } from '../config.js';

function emptyDay(businessDate: string): ReconciledDay {
  return { businessDate, updatedAt: new Date().toISOString(), items: [] };
}

function keyFor(businessDate: string): string {
  return `${config.mprMailbox.s3ReconciledPrefix}${businessDate}.json`;
}

async function streamToString(stream: unknown): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Reads one business date's accumulator, or an empty one if it's never
 * been written.
 *
 * The S3 credentials this app uses are deliberately scoped to only
 * `s3:GetObject`/`s3:PutObject` on this bucket's objects — no
 * `s3:ListBucket` (least privilege; it never needs to enumerate the
 * bucket). Without `s3:ListBucket`, S3's own documented behavior is to
 * return `403 AccessDenied` for a `GetObject` on a key that doesn't
 * exist, instead of the usual `404 NoSuchKey` — it deliberately avoids
 * confirming or denying existence to a caller who can't list the bucket
 * either way. So here, `AccessDenied` reads the same as `NoSuchKey`: the
 * day's accumulator simply hasn't been created yet, same as every
 * business date's very first ingest run ever hits.
 */
export async function loadReconciledDay(s3: S3Client, businessDate: string): Promise<ReconciledDay> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: config.objectStore.bucket, Key: keyFor(businessDate) }));
    const text = await streamToString(res.Body);
    return text ? (JSON.parse(text) as ReconciledDay) : emptyDay(businessDate);
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === 'NoSuchKey' || name === 'AccessDenied') return emptyDay(businessDate);
    throw err;
  }
}

export async function saveReconciledDay(s3: S3Client, day: ReconciledDay): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: config.objectStore.bucket,
      Key: keyFor(day.businessDate),
      Body: JSON.stringify(day, null, 2),
      ContentType: 'application/json',
    }),
  );
}

/**
 * Upserts `incoming` into `existing` by `key` — a key already present gets
 * overwritten (a later run's resolution wins), everything else is kept
 * as-is. Pure and exported on its own so the merge logic is unit-testable
 * without touching S3.
 */
export function mergeReconciledItems(existing: readonly ReconciledItem[], incoming: readonly ReconciledItem[]): ReconciledItem[] {
  const byKey = new Map(existing.map((i) => [i.key, i] as const));
  for (const item of incoming) byKey.set(item.key, item);
  return [...byKey.values()];
}

/** How many trailing calendar dates `loadRecentSettledKeys` checks — see its own doc comment. */
export const RECENT_SETTLED_LOOKBACK_DAYS = 10;

/**
 * Every settled/mismatch item's lookup key — bare RRN, or (AMEX, which has
 * none) its `date|cardLast4` composite, pulled from `item.key`'s own
 * `sourceSessionId|...` suffix — across the trailing
 * `RECENT_SETTLED_LOOKBACK_DAYS` calendar dates' accumulators.
 *
 * Why this is keyed independent of `sourceSessionId`, unlike every other
 * read of this accumulator: a bank resending a file it already sent
 * produces rows with no Layer-1 session of their own to pair with this
 * time (that session was already folded in on the earlier run) — they're
 * `unexpected` from the first line of matching, not merely `pending`. This
 * is the one check that has to recognize "already reconciled" across runs
 * with nothing but the bank row itself to go on.
 */
export async function loadRecentSettledKeys(s3: S3Client, today = new Date()): Promise<Set<string>> {
  const keys = new Set<string>();
  for (let i = 0; i < RECENT_SETTLED_LOOKBACK_DAYS; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const day = await loadReconciledDay(s3, d.toISOString().slice(0, 10));
    for (const item of day.items) {
      if (item.rrn) {
        keys.add(item.rrn);
      } else if (item.acquirer === 'AMEX') {
        const [, date, card] = item.key.slice(item.sourceSessionId.length + 1).split('|');
        if (date && card) keys.add(`${date}|${card}`);
      }
    }
  }
  return keys;
}
