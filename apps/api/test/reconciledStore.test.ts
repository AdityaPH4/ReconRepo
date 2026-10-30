import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import type { S3Client } from '@aws-sdk/client-s3';
import { isAmexBankRowSettled } from '@toit/mpr-core';
import { loadRecentSettledKeys } from '../src/services/reconciledStore.ts';

const item = (key: string, mprAmount: number, mprTxnAt?: string) => ({ key, sourceSessionId: 's1', rrn: null, acquirer: 'AMEX', outlet: 'BAGT', plAmount: mprAmount, mprAmount, diff: 0, matchStatus: 'settled', mprFile: null, mprTxnAt, resolvedInMprSessionId: 'r', resolvedAt: '' });
// Every date's accumulator holds the same two items — enough for the lookback to find them.
const fakeS3 = (items: unknown[]) => ({ send: async () => ({ Body: Readable.from([JSON.stringify({ businessDate: '2026-10-16', updatedAt: '', items })]) }) }) as unknown as S3Client;

describe('loadRecentSettledKeys() — AMEX', () => {
  it('a new-format item recognises only its own bank row; an old-format item still covers every row on that card and day', async () => {
    const keys = await loadRecentSettledKeys(
      fakeS3([item('s1|amex|2026-10-16|2006|200|2026-10-16 14:25:44', 200, '2026-10-16 14:25:44'), item('s1|amex|2026-10-15|1005', 800)]),
      new Date('2026-10-20T00:00:00Z'),
    );
    assert.ok(isAmexBankRowSettled(keys, '2026-10-16', '2006', 200, '2026-10-16 14:25:44'));
    assert.ok(!isAmexBankRowSettled(keys, '2026-10-16', '2006', 200, '2026-10-16 19:47:33'), 'same-amount twin at another time');
    assert.ok(isAmexBankRowSettled(keys, '2026-10-15', '1005', 800, '2026-10-15 12:00:00'));
    assert.ok(isAmexBankRowSettled(keys, '2026-10-15', '1005', 1500, '2026-10-15 12:01:00'), 'old record stood for all twins');
  });
});
