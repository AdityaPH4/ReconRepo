/**
 * Behavioural tests for the justification & submit layer.
 *
 * Written the same way as `engine.test.ts`: each assertion encodes a specific
 * legacy behaviour (line-cited in comments where it isn't obvious), so a
 * future change that alters gating/residual/eligibility fails here loudly.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AMOUNT_EPSILON,
  THRESHOLD,
  advanceBalance,
  buildHdfcUpiItems,
  buildPinelabsItems,
  buildSnapshot,
  canSubmit,
  cashOk,
  bankOk,
  collectExplained,
  eligibleAdvances,
  autoStageBohRows,
  eligibleBohEntries,
  emptyJustificationState,
  entryNet,
  explainedTotals,
  hdfcUpiCompleteness,
  isAdvanceExhausted,
  isEligibleSquareOffPartner,
  pinelabsCompleteness,
  squareOffNet,
  toggleSquareOff,
  upiOk,
} from '../dist/index.js';
import type {
  Advance,
  AdvanceApplication,
  BohEntry,
  JustificationEntry,
  JustificationSource,
  OutletCode,
  PinelabsResult,
  ResolvableItem,
} from '../dist/index.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

function pr(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    orderNo: '1001',
    date: '01-Aug-2026 21:00:00',
    customer: 'Alice',
    employee: 'E1',
    paymentType: 'Card',
    paymentName: 'Pinelabs APOS',
    cardNo: '411111',
    authCode: 'A1',
    amount: 500,
    tips: 0,
    bank: 'HDFC',
    rrn: '100000000001',
    isAmex: false,
    tab: 'pinelabs',
    _src: 'PR',
    ...overrides,
  };
}

function zip(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    acquirer: 'Pinelabs',
    paymentMode: 'Card',
    name: 'Alice',
    cardIssuer: 'HDFC',
    amount: 500,
    tip: 0,
    date: '01/08/2026 09:00:00 PM',
    batchStatus: 'Matched',
    txnStatus: 'Sale',
    rrn: '100000000001',
    settlementDate: '02/08/2026',
    billInvoice: '',
    invoice: '',
    approvalCode: '',
    type: 'Sale',
    zone: '',
    store: 'Toit- Bangalore',
    tid: '',
    mid: '',
    isAmex: false,
    _src: 'ZIP',
    _amex: false,
    ...overrides,
  };
}

function reconRow(overrides: Partial<Record<string, unknown>> = {}) {
  const base = {
    rrn: '100000000001',
    plAmt: 500,
    prAmt: 500,
    diff: 0,
    orders: ['1001'],
    pr: pr(),
    prRows: [pr()],
    zip: zip(),
    isManualAPOS: false,
    squaredOff: false,
  };
  return { ...base, ...overrides };
}

function pinelabsResult(overrides: Partial<PinelabsResult> = {}): PinelabsResult {
  return {
    reconRows: [],
    onlyPOS: [],
    onlyTerm: [],
    dupRRN: [],
    amexOk: [],
    amexDup: [],
    amexDupTerm: [],
    ...overrides,
  } as PinelabsResult;
}

let entrySeq = 0;
function entry(overrides: Partial<JustificationEntry>): JustificationEntry {
  entrySeq += 1;
  return {
    id: `e-${entrySeq}`,
    source: 'cash' as JustificationSource,
    targetKey: null,
    direction: 'excess',
    remark: 'Tips',
    amount: 0,
    description: null,
    rrn: null,
    billNo: null,
    reason: null,
    staffName: null,
    empId: null,
    clientName: null,
    comment: null,
    notes: null,
    createdAdvanceId: null,
    appliedApplicationId: null,
    bohClearanceId: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

// ── Square-off ────────────────────────────────────────────────────────────

describe('square-off', () => {
  it('toggles a symmetric pairing on and off', () => {
    let map = toggleSquareOff({}, 'POS-1', 'PL-1', true);
    assert.deepEqual(map['POS-1'], ['PL-1']);
    assert.deepEqual(map['PL-1'], ['POS-1']);
    map = toggleSquareOff(map, 'POS-1', 'PL-1', false);
    assert.deepEqual(map['POS-1'], []);
    assert.deepEqual(map['PL-1'], []);
  });

  it('only offers opposite-sign items as square-off partners', () => {
    const excess: ResolvableItem = {
      globalId: 'PL-1',
      targetKey: 't1',
      diff: 500,
      label: 'Only in Terminal',
      orderNo: '',
      rrn: '',
      appearsInExplanation: true,
      countsTowardGate: true,
    };
    const shortage: ResolvableItem = {
      globalId: 'POS-1',
      targetKey: 't2',
      diff: -500,
      label: 'Only in POS',
      orderNo: '',
      rrn: '',
      appearsInExplanation: true,
      countsTowardGate: true,
    };
    const sameSign: ResolvableItem = {
      globalId: 'POS-2',
      targetKey: 't3',
      diff: -100,
      label: 'Only in POS',
      orderNo: '',
      rrn: '',
      appearsInExplanation: true,
      countsTowardGate: true,
    };
    assert.equal(isEligibleSquareOffPartner(excess, shortage), true);
    assert.equal(isEligibleSquareOffPartner(shortage, sameSign), false);
  });

  it('flags a lopsided pair as still net-unresolved', () => {
    const items: ResolvableItem[] = [
      {
        globalId: 'PL-1',
        targetKey: 't1',
        diff: 500,
        label: 'Only in Terminal',
        orderNo: '',
        rrn: '',
        appearsInExplanation: true,
        countsTowardGate: true,
      },
      {
        globalId: 'POS-1',
        targetKey: 't2',
        diff: -200,
        label: 'Only in POS',
        orderNo: '',
        rrn: '',
        appearsInExplanation: true,
        countsTowardGate: true,
      },
    ];
    const map = toggleSquareOff({}, 'PL-1', 'POS-1', true);
    const net = squareOffNet(map, 'PL-1', items);
    assert.equal(net, 300);
    assert.ok(Math.abs(net!) >= AMOUNT_EPSILON);
  });
});

// ── Completeness ──────────────────────────────────────────────────────────

describe('completeness', () => {
  it('an unreconciled Pinelabs row with no remark and no square-off blocks plOk', () => {
    const pinelabs = pinelabsResult({ reconRows: [reconRow({ diff: 250 })] as never });
    const result = pinelabsCompleteness(pinelabs, [], {});
    assert.equal(result.allResolved, false);
    assert.equal(result.unresolvedCount, 1);
  });

  it('a remark on the row resolves it', () => {
    const pinelabs = pinelabsResult({ reconRows: [reconRow({ rrn: 'R1', diff: 250 })] as never });
    const entries = [entry({ source: 'pinelabs', targetKey: 'R1', remark: 'Tips', direction: 'excess', amount: 250 })];
    const result = pinelabsCompleteness(pinelabs, entries, {});
    assert.equal(result.allResolved, true);
  });

  it('a square-off pair resolves both rows without any remark', () => {
    const pinelabs = pinelabsResult({
      reconRows: [reconRow({ rrn: 'R1', diff: 500 })] as never,
      onlyPOS: [{ orders: ['O1'], amount: 500, rrn: 'R2' }] as never,
    });
    // MM-1 is the reconRow (diff +500), POS-1 is the onlyPOS row (diff -500)
    const map = toggleSquareOff({}, 'MM-1', 'POS-1', true);
    const result = pinelabsCompleteness(pinelabs, [], map);
    assert.equal(result.allResolved, true);
  });

  it('count-based HDFC completeness is not fooled by opposite-sign items netting near zero', () => {
    const upiHdfc = {
      reconRows: [],
      onlyPOS: [{ orders: ['O1'], amount: 500, rrn: 'R1' }] as never,
      onlyTerm: [{ rrn: 'R2', amount: 500, date: new Date('2026-08-01') }] as never,
      dupRRN: [],
    };
    // Net diff is 0 (−500 + 500), but neither item has a remark or square-off.
    const result = hdfcUpiCompleteness(upiHdfc as never, [], {});
    assert.equal(result!.netDiff, 0);
    assert.equal(result!.allResolved, false);
    assert.equal(result!.unresolvedCount, 2);
  });

  it('returns null when no HDFC statement was uploaded', () => {
    assert.equal(hdfcUpiCompleteness(null, [], {}), null);
  });

  it('an unremarked HDFC-UPI dupRRN row is resolvable but never blocks the gate', () => {
    const upiHdfc = {
      reconRows: [],
      onlyPOS: [],
      onlyTerm: [],
      dupRRN: [{ rrn: 'R9', orders: [], _dupSrc: 'stmt', _note: 'duplicated' }] as never,
    };
    const items = buildHdfcUpiItems(upiHdfc as never);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.countsTowardGate, false);
    const result = hdfcUpiCompleteness(upiHdfc as never, [], {});
    assert.equal(result!.allResolved, true);
    assert.equal(result!.unresolvedCount, 0);
  });

  it('Cash gets the ₹300 leniency band that Bank does not', () => {
    assert.equal(cashOk(250, []), true); // under THRESHOLD entirely
    assert.equal(bankOk(true, 250, []), false); // Bank has no such leniency
  });

  it('Cash residual within THRESHOLD after justifications is ok', () => {
    const entries = [entry({ source: 'cash', direction: 'shortage', remark: 'Short Collection', amount: 900 })];
    // diff=1000 (excess), entryNet=-900 → residual=1900... use a case that actually lands within band
    assert.equal(cashOk(1000, [entry({ source: 'cash', direction: 'excess', remark: 'Tips', amount: 950 })]), true);
    assert.equal(entries.length, 1);
  });

  it('Bank requires exactness even with a justification entry, once outside epsilon', () => {
    const entries = [entry({ source: 'bank', direction: 'excess', remark: 'Tips', amount: 490 })];
    assert.equal(bankOk(true, 500, entries), false);
    const exact = [entry({ source: 'bank', direction: 'excess', remark: 'Tips', amount: 500 })];
    assert.equal(bankOk(true, 500, exact), true);
  });

  it('upiOk requires HDFC fully resolved AND Kotak within tolerance when a statement exists', () => {
    const resolvedHdfc = { netDiff: 0, unresolvedCount: 0, allResolved: true };
    assert.equal(
      upiOk({ hasSummary: true, hdfcCompleteness: resolvedHdfc, hdfcAggregateDiff: 0, kotakDiff: 0, entries: [] }),
      true,
    );
    const unresolvedHdfc = { netDiff: 500, unresolvedCount: 1, allResolved: false };
    assert.equal(
      upiOk({ hasSummary: true, hdfcCompleteness: unresolvedHdfc, hdfcAggregateDiff: 0, kotakDiff: 0, entries: [] }),
      false,
    );
  });
});

// ── Residual ──────────────────────────────────────────────────────────────

describe('residual', () => {
  it('collects row-level and aggregate entries into one signed list', () => {
    const pinelabsItems: ResolvableItem[] = [
      {
        globalId: 'MM-1',
        targetKey: 'R1',
        diff: 300,
        label: 'Amount mismatch',
        orderNo: '',
        rrn: 'R1',
        appearsInExplanation: true,
        countsTowardGate: true,
      },
    ];
    const entries = [
      entry({ source: 'pinelabs', targetKey: 'R1', remark: 'Tips', direction: 'excess', amount: 300 }),
      entry({ source: 'cash', direction: 'shortage', remark: 'Short Collection', amount: 100 }),
    ];
    const explained = collectExplained(entries, pinelabsItems, []);
    assert.equal(explained.length, 2);
    const totals = explainedTotals(explained);
    assert.equal(totals.excessTotal, 300);
    assert.equal(totals.shortTotal, 100);
  });

  it('a Pinelabs dupRRN row satisfies completeness via a remark but never becomes an explained row', () => {
    const dupItem: ResolvableItem = {
      globalId: 'DUP-1',
      targetKey: 'dup-R9',
      diff: 0,
      label: 'Ambiguous — duplicate RRN',
      orderNo: '',
      rrn: 'R9',
      appearsInExplanation: false,
      countsTowardGate: true,
    };
    const entries = [entry({ source: 'pinelabs', targetKey: 'dup-R9', remark: 'Other', comment: 'ambiguous' })];
    const explained = collectExplained(entries, [dupItem], []);
    assert.equal(explained.length, 0);
  });

  it('an HDFC-UPI dupRRN row, once remarked, does become an explained row (diff 0)', () => {
    const udupItem: ResolvableItem = {
      globalId: 'UDUP-1',
      targetKey: 'udup-R9',
      diff: 0,
      label: 'HDFC UPI — Duplicate RRN',
      orderNo: '',
      rrn: 'R9',
      appearsInExplanation: true,
      countsTowardGate: false,
    };
    const entries = [entry({ source: 'upi_hdfc', targetKey: 'udup-R9', remark: 'Other', comment: 'ambiguous' })];
    const explained = collectExplained(entries, [], [udupItem]);
    assert.equal(explained.length, 1);
    assert.equal(explained[0]!.diff, 0);
    assert.equal(explained[0]!.label, 'HDFC UPI — Duplicate RRN');
  });
});

// ── Submit gate ───────────────────────────────────────────────────────────

describe('canSubmit', () => {
  it('blocks when Pinelabs has an unresolved item, even if the net residual is small', () => {
    const pinelabs = pinelabsResult({ reconRows: [reconRow({ rrn: 'R1', diff: 250 })] as never });
    const result = canSubmit({
      pinelabs,
      upiHdfc: null,
      justification: emptyJustificationState(),
      grandDiff: 250,
      hasSummary: false,
      cashDiff: 0,
      bankDiff: 0,
      hdfcAggregateDiff: 0,
      kotakDiff: 0,
      applications: [],
    });
    assert.equal(result.ok, false);
    assert.ok(result.blockers.some((b) => b.includes('Pinelabs')));
  });

  it('blocks on net unexplained exceeding THRESHOLD even when every source individually looks fine', () => {
    const result = canSubmit({
      pinelabs: pinelabsResult(),
      upiHdfc: null,
      justification: emptyJustificationState(),
      grandDiff: THRESHOLD + 50,
      hasSummary: false,
      cashDiff: 0,
      bankDiff: 0,
      hdfcAggregateDiff: 0,
      kotakDiff: 0,
      applications: [],
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'needs_explanation');
  });

  it('an orphaned "Advance Applied" entry blocks submission', () => {
    const entries = [
      entry({ source: 'cash', direction: 'shortage', remark: 'Advance Applied', amount: 200, appliedApplicationId: 'missing' }),
    ];
    const result = canSubmit({
      pinelabs: pinelabsResult(),
      upiHdfc: null,
      justification: { ...emptyJustificationState(), entries },
      grandDiff: 0,
      hasSummary: false,
      cashDiff: 0,
      bankDiff: 0,
      hdfcAggregateDiff: 0,
      kotakDiff: 0,
      applications: [],
    });
    assert.equal(result.ok, false);
    assert.ok(result.blockers.some((b) => b.includes('backing advance')));
  });

  it('is ok, "balanced", when nothing is outstanding', () => {
    const result = canSubmit({
      pinelabs: pinelabsResult(),
      upiHdfc: null,
      justification: emptyJustificationState(),
      grandDiff: 0,
      hasSummary: false,
      cashDiff: 0,
      bankDiff: 0,
      hdfcAggregateDiff: 0,
      kotakDiff: 0,
      applications: [],
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'balanced');
  });
});

// ── Advances ──────────────────────────────────────────────────────────────

describe('advances', () => {
  const outlet: OutletCode = 'BLRT';
  const advance: Advance = {
    id: 'adv-1',
    outlet,
    custName: 'Priya',
    phone: null,
    eventDate: '2026-08-10',
    notes: null,
    originalAmount: 1000,
    recordedDate: '2026-08-01',
    recordedBySessionId: 's-1',
  };

  it('balance is original minus applications', () => {
    const applications: AdvanceApplication[] = [
      { id: 'ap-1', advanceId: 'adv-1', sessionId: 's-2', targetKey: null, amount: 400, appliedDate: '2026-08-02' },
    ];
    assert.equal(advanceBalance(advance, applications), 600);
    assert.equal(isAdvanceExhausted(advance, applications), false);
  });

  it('an exact shortage amount only makes exact-balance advances eligible', () => {
    const applications: AdvanceApplication[] = [];
    const [result] = eligibleAdvances([advance], applications, 700);
    assert.equal(result.eligible, false);
    const [exact] = eligibleAdvances([advance], applications, 1000);
    assert.equal(exact.eligible, true);
  });

  it('with no known shortage amount (Cash/UPI/Bank flow), every advance with balance is eligible', () => {
    const [result] = eligibleAdvances([advance], []);
    assert.equal(result.eligible, true);
  });

  it('an exhausted advance is excluded entirely', () => {
    const applications: AdvanceApplication[] = [
      { id: 'ap-1', advanceId: 'adv-1', sessionId: 's-2', targetKey: null, amount: 1000, appliedDate: '2026-08-02' },
    ];
    assert.equal(eligibleAdvances([advance], applications).length, 0);
  });
});

// ── Bills on hold ─────────────────────────────────────────────────────────

describe('bills on hold', () => {
  const outlet: OutletCode = 'BLRT';
  const open: BohEntry = {
    id: 'boh-1',
    outlet,
    orderNo: 'O-500',
    custName: 'Rahul',
    phone: null,
    amount: 750,
    bohDate: '2026-08-01',
    notes: null,
    recordedDate: '2026-08-01',
    status: 'open',
    clearedAt: null,
    clearedBySessionId: null,
  };

  it('excludes a different outlet entirely', () => {
    const other = { ...open, outlet: 'PUNT' as OutletCode };
    const result = eligibleBohEntries([other], { outlet, businessDate: '2026-08-02' });
    assert.equal(result.length, 0);
  });

  it('hides same-business-day entries unless includeToday is set', () => {
    const hidden = eligibleBohEntries([open], { outlet, businessDate: '2026-08-01' });
    assert.equal(hidden.length, 0);
    const shown = eligibleBohEntries([open], { outlet, businessDate: '2026-08-01', includeToday: true });
    assert.equal(shown.length, 1);
  });

  it('excludes an already-cleared entry — the durable fix over legacy', () => {
    const cleared = { ...open, status: 'cleared' as const };
    const result = eligibleBohEntries([cleared], { outlet, businessDate: '2026-08-05' });
    assert.equal(result.length, 0);
  });

  it('an exact amount gate disables non-matching entries', () => {
    const [result] = eligibleBohEntries([open], { outlet, businessDate: '2026-08-05', exactAmount: 700 });
    assert.equal(result.eligible, false);
    const [exact] = eligibleBohEntries([open], { outlet, businessDate: '2026-08-05', exactAmount: 750 });
    assert.equal(exact.eligible, true);
  });

  it('auto-stages every bills-on-hold row not already in the repository, with no name required', () => {
    const bills = [
      { orderNo: 'O-1', customer: 'Priya', amount: 400 } as never,
      { orderNo: 'O-2', customer: '', amount: 250 } as never,
    ];
    const staged = autoStageBohRows(bills, new Set(), '2026-08-10');
    assert.equal(staged.length, 2);
    assert.equal(staged[0]!.custName, 'Priya');
    assert.equal(staged[1]!.custName, '');
    assert.equal(staged[0]!.bohDate, '2026-08-10');
  });

  it('skips a bills-on-hold row already known to the repository', () => {
    const bills = [{ orderNo: 'O-500', customer: 'Rahul', amount: 750 } as never];
    const staged = autoStageBohRows(bills, new Set(['O-500']), '2026-08-10');
    assert.equal(staged.length, 0);
  });
});

// ── Snapshot ──────────────────────────────────────────────────────────────

describe('buildSnapshot', () => {
  it('produces the expected top-level shape', () => {
    const snapshot = buildSnapshot({
      outlet: 'BLRT',
      businessDate: '2026-08-01',
      businessWindow: '01 Aug 08:00 – 02 Aug 07:00',
      businessWindowStart: '2026-08-01T02:30:00.000Z',
      businessWindowEnd: '2026-08-02T01:30:00.000Z',
      submittedAt: '2026-08-02T10:00:00.000Z',
      submittedBy: 'gm@toit.local',
      prFileRows: 10,
      zipRows: 8,
      result: {
        pinelabs: pinelabsResult(),
        upiHdfc: null,
        swiggy: [],
        cash: [],
        upi: [],
        bills: [],
        bank: [],
        other: [],
        zipFiltered: [],
      } as never,
      summaryData: null,
      methodBreakdown: [],
      grandDiff: 0,
      residual: 0,
      status: 'balanced',
      justification: emptyJustificationState(),
      advances: [],
      applications: [],
      bohOpen: [],
      bohClearedThisSession: [],
    });

    assert.equal(snapshot.meta.outlet, 'BLRT');
    assert.equal(snapshot.finalReconSummary.status, 'balanced');
    assert.deepEqual(snapshot.settlementLedger, []);
    assert.deepEqual(snapshot.billsOnHold, { open: [], cleared: [] });
    assert.deepEqual(snapshot.cash.transactions, []);
    assert.deepEqual(snapshot.cash.justifications, []);
    assert.deepEqual(snapshot.bank.transactions, []);
    assert.deepEqual(snapshot.bank.justifications, []);
    assert.deepEqual(snapshot.swiggy.transactions, []);
    assert.deepEqual(snapshot.extraPayments, []);
  });

  it('carries per-transaction Cash/Bank/Swiggy rows and cash/bank justifications', () => {
    const entries = [
      entry({ source: 'cash', direction: 'excess', remark: 'Tips', amount: 50 }),
      entry({ source: 'bank', direction: 'shortage', remark: 'Tips', amount: 30 }),
    ];
    const snapshot = buildSnapshot({
      outlet: 'BLRT',
      businessDate: '2026-08-01',
      businessWindow: '01 Aug 08:00 – 02 Aug 07:00',
      businessWindowStart: '2026-08-01T02:30:00.000Z',
      businessWindowEnd: '2026-08-02T01:30:00.000Z',
      submittedAt: '2026-08-02T10:00:00.000Z',
      submittedBy: 'gm@toit.local',
      prFileRows: 10,
      zipRows: 8,
      result: {
        pinelabs: pinelabsResult(),
        upiHdfc: null,
        swiggy: [{ outlet: 'BLRT', orderNo: 'SW-1', date: '2026-08-01', paymentName: 'Swiggy', amount: 200 }],
        cash: [{ orderNo: 'C-1', date: '2026-08-01', amount: 100 }],
        upi: [],
        bills: [],
        bank: [{ orderNo: 'B-1', date: '2026-08-01', amount: 300 }],
        other: [],
        zipFiltered: [],
      } as never,
      summaryData: null,
      methodBreakdown: [],
      grandDiff: 0,
      residual: 0,
      status: 'balanced',
      justification: { ...emptyJustificationState(), entries },
      advances: [],
      applications: [],
      bohOpen: [],
      bohClearedThisSession: [],
    });

    assert.equal(snapshot.cash.transactions.length, 1);
    assert.equal(snapshot.cash.transactions[0]!.orderNo, 'C-1');
    assert.equal(snapshot.bank.transactions[0]!.orderNo, 'B-1');
    assert.equal(snapshot.swiggy.transactions[0]!.orderNo, 'SW-1');
    assert.equal(snapshot.cash.justifications.length, 1);
    assert.equal(snapshot.cash.justifications[0]!.remark, 'Tips');
    assert.equal(snapshot.bank.justifications.length, 1);
    assert.equal(snapshot.bank.justifications[0]!.sign, 'shortage');
  });
});
