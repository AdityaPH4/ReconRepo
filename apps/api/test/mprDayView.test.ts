import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
});
