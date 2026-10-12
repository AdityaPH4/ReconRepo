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

/** Reads one business date's accumulator, or an empty one if it's never been written. */
export async function loadReconciledDay(s3: S3Client, businessDate: string): Promise<ReconciledDay> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: config.objectStore.bucket, Key: keyFor(businessDate) }));
    const text = await streamToString(res.Body);
    return text ? (JSON.parse(text) as ReconciledDay) : emptyDay(businessDate);
  } catch (err) {
    if ((err as { name?: string })?.name === 'NoSuchKey') return emptyDay(businessDate);
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
