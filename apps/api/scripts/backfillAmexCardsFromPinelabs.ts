/**
 * Fills in `cardNo` on stored AMEX settlement-ledger rows that have none, from
 * each session's own Pinelabs terminal report (the "Customer Payment Mode ID"
 * column — the only place a tip, advance or squared-off AMEX charge has a
 * card). A row is paired with its terminal transaction by exact date-time
 * string and amount (plus approval code when the row has one). Only missing
 * cards are written; a backup of every touched ledger is saved first.
 *
 *   cd apps/api && npx tsx scripts/backfillAmexCardsFromPinelabs.ts            # dry run
 *   cd apps/api && npx tsx scripts/backfillAmexCardsFromPinelabs.ts --apply
 */

import { writeFileSync } from 'node:fs';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { parseTransactionsZip } from '@toit/recon-core';
import { config } from '../src/config.js';
import { getPool } from '../src/storage/postgres/pool.js';
import { createRawS3Client } from '../src/storage/s3ObjectStore.js';

const apply = process.argv.includes('--apply');
const pool = getPool();
const s3 = createRawS3Client(config.objectStore);
const last4 = (raw: unknown) => String(raw ?? '').replace(/\D/g, '').slice(-4);
const noCard = (r: { acquirer?: string; cardNo?: string }) => r.acquirer === 'AMEX' && last4(r.cardNo).length < 4;

type Row = { acquirer?: string; cardNo?: string; plDate?: string; plAmount?: number; authCode?: string };

const { rows: sessions } = await pool.query<{ id: string; outlet: string; bd: string; zip_key: string | null; ledger: Row[] }>(
  `SELECT id, outlet, data->'meta'->>'businessDate' AS bd,
     (SELECT f->>'storageKey' FROM jsonb_array_elements(data->'meta'->'files') f WHERE f->>'role' = 'zip' LIMIT 1) AS zip_key,
     data->'snapshot'->'settlementLedger' AS ledger
   FROM recon.sessions
   WHERE status = 'submitted' AND EXISTS (
     SELECT 1 FROM jsonb_array_elements(data->'snapshot'->'settlementLedger') x
     WHERE x->>'acquirer' = 'AMEX' AND length(regexp_replace(coalesce(x->>'cardNo', ''), '\D', '', 'g')) < 4)`,
);

const backup: Array<{ id: string; ledger: Row[] }> = [];
const tally = { sessions: sessions.length, rowsWithoutCard: 0, filled: 0, notInTerminalReport: 0, terminalCardBlank: 0, ambiguous: 0 };
for (const s of sessions) {
  const missing = s.ledger.filter(noCard);
  tally.rowsWithoutCard += missing.length;
  if (!s.zip_key) {
    tally.notInTerminalReport += missing.length;
    continue;
  }
  const obj = await s3.send(new GetObjectCommand({ Bucket: config.objectStore.bucket, Key: s.zip_key }));
  const { inside } = await parseTransactionsZip(Buffer.from(await obj.Body!.transformToByteArray()), null);
  const amexRows = inside.filter((z) => z.isAmex);

  let changed = 0;
  const next = s.ledger.map((r) => {
    if (!noCard(r)) return r;
    const hits = amexRows.filter((z) => z.date === r.plDate && Math.abs(z.amount - (r.plAmount ?? 0)) < 0.01 && (!r.authCode || z.approvalCode === r.authCode));
    if (hits.length !== 1) {
      hits.length ? tally.ambiguous++ : tally.notInTerminalReport++;
      return r;
    }
    if (last4(hits[0]!.cardNo).length < 4) {
      tally.terminalCardBlank++;
      return r;
    }
    changed++;
    tally.filled++;
    return { ...r, cardNo: hits[0]!.cardNo };
  });
  if (!changed) continue;
  backup.push({ id: s.id, ledger: s.ledger });
  if (apply) {
    await pool.query(`UPDATE recon.sessions SET data = jsonb_set(data, '{snapshot,settlementLedger}', $2::jsonb) WHERE id = $1`, [s.id, JSON.stringify(next)]);
  }
  console.log(`${apply ? 'updated' : 'would update'} ${s.outlet} ${s.bd}: ${changed} row(s)`);
}
if (apply && backup.length) {
  const file = `amex-card-backfill-backup-${Date.now()}.json`;
  writeFileSync(file, JSON.stringify(backup));
  console.log(`backup of the ${backup.length} changed ledger(s): ${file}`);
}
console.log(JSON.stringify(tally));
console.log(apply ? 'applied' : 'dry run — nothing written (add --apply)');
await pool.end();
