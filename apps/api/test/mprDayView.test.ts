import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { amexSettledKeys } from '@toit/mpr-core';
import { buildDaySession } from '../src/services/mprDayView.ts';
import type { MprDayRows } from '../src/storage/types.ts';

const meta = (id: string) => ({ id, createdAt: '', createdBy: '', jsonFiles: [], mprFiles: [], businessDates: [], outlets: [] }) as never;
const amexRow = (o: Record<string, unknown>) => ({ date: '2026-10-16', cardLast4: '', outlet: 'BAGT', l1Amount: 200, mprRow: null, _match: 'pending', _businessDate: '2026-10-16', _sourceSessionId: 's1', ...o });

describe('buildDaySession() — AMEX rows', () => {
  it('counts a row once when an older run holds it without a card and a newer run holds it with one — even if the older run has other carded rows', () => {
    const data = {
      runs: [{ id: 'new', meta: meta('new') }, { id: 'old', meta: meta('old') }], // newest first
      rows: [
        { runId: 'new', bucket: 'amexResults', row: amexRow({ cardLast4: '2006', _match: 'ambiguous' }) },
        { runId: 'old', bucket: 'amexResults', row: amexRow({}) }, // same ₹200, no card yet
        { runId: 'old', bucket: 'amexResults', row: amexRow({ cardLast4: '2009', l1Amount: 664, _match: 'settled' }) }, // makes the old run "carded"
      ],
      bankRows: [],
      settledKeys: new Set<string>(),
    } as unknown as MprDayRows;
    const { result } = buildDaySession('2026-10-16', data, 'BAGT');
    assert.equal(result.amexResults.length, 2);
    assert.deepEqual(result.amexResults.map((r) => r.l1Amount).sort(), [200, 664]);
  });

  it('keeps a no-card row that no other run has with a card', () => {
    const data = {
      runs: [{ id: 'a', meta: meta('a') }],
      rows: [{ runId: 'a', bucket: 'amexResults', row: amexRow({}) }],
      bankRows: [],
      settledKeys: new Set<string>(),
    } as unknown as MprDayRows;
    assert.equal(buildDaySession('2026-10-16', data, 'BAGT').result.amexResults.length, 1);
  });

  it('hides a bank-only AMEX row only when that same row (same timestamp) settled — not its same-card, same-amount twin', () => {
    const bank = (txnAt: string | undefined) => ({ date: '2026-10-16', at: txnAt ?? null, cardLast4: '2006', outlet: '', l1Amount: null, mprRow: { txnDate: '2026-10-16', txnAt, cardLast4: '2006', amount: 200, settlementDate: null, _file: 'f' }, _match: 'unexpected' });
    const data = {
      runs: [{ id: 'new', meta: meta('new') }, { id: 'old', meta: meta('old') }],
      rows: [],
      bankRows: [
        { runId: 'new', bucket: 'amexResults', row: bank('2026-10-16 19:47:33') }, // the twin nobody claimed
        { runId: 'old', bucket: 'amexResults', row: bank('2026-10-16 14:25:44') }, // the one that settled
      ],
      settledKeys: new Set(amexSettledKeys('2026-10-16', '2006', 200, '2026-10-16 14:25:44')),
    } as unknown as MprDayRows;
    const shown = buildDaySession('2026-10-16', data, null).result.amexResults;
    assert.deepEqual(shown.map((r) => r.mprRow?.txnAt), ['2026-10-16 19:47:33']);
  });

  it('does not let a settled twin from one run stand in for an unmatched twin from another', () => {
    const bank = (txnAt: string) => ({ date: '2026-10-16', at: txnAt, cardLast4: '2006', outlet: '', l1Amount: null, mprRow: { txnDate: '2026-10-16', txnAt, cardLast4: '2006', amount: 200, settlementDate: null, _file: 'f' }, _match: 'unexpected' });
    const data = {
      runs: [{ id: 'r2', meta: meta('r2') }, { id: 'r1', meta: meta('r1') }, { id: 'r0', meta: meta('r0') }],
      rows: [],
      bankRows: [
        { runId: 'r1', bucket: 'amexResults', row: bank('2026-10-16 14:25:44') }, // settled later, in r2
        { runId: 'r0', bucket: 'amexResults', row: bank('2026-10-16 19:47:33') }, // never claimed
      ],
      settledKeys: new Set(amexSettledKeys('2026-10-16', '2006', 200, '2026-10-16 14:25:44')),
    } as unknown as MprDayRows;
    assert.deepEqual(buildDaySession('2026-10-16', data, null).result.amexResults.map((r) => r.mprRow?.txnAt), ['2026-10-16 19:47:33']);
  });
});
