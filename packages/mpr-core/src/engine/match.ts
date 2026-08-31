/**
 * The Layer-2 matching engine.
 * Ported from `mpr-recon (10).html` lines 889–1256 (`runMatch`).
 *
 * Pure: no DOM, no I/O. Three independent matchers share one input: the
 * primary RRN matcher (Kotak/Pinelabs/HDFC-terminal), the AMEX batch/SOC
 * matcher, and the HDFC Static UPI two-pass-plus-justification matcher.
 * Layer 1's own `l1Status`/remark/square-off state is carried through on
 * every row but never consulted to skip Layer-2 matching — Layer 1 answers
 * "did PR and POS agree", Layer 2 answers "did the money actually land",
 * and every ledger row is checked against the bank independent of what
 * Layer 1 already decided about it.
 */

import { adjustPRDate, amexNormDate, normDate, normRRN, parseTxnTimestamp, splitRRNs } from '../util/normalize.js';
import type {
  AmbiguousMprRow,
  AmexMprRow,
  AmexResult,
  MatchInput,
  MatchResult,
  MprRow,
  TaggedUpiJustification,
  TaggedUpiTransaction,
  UpiResult,
} from '../types.js';

const AMOUNT_EPSILON = 0.5;
const AMEX_EPSILON = 1;
const UPI_DATE_WINDOW_SEC = 3600;

const EXCESS_REMARKS = new Set(['Advance Received', 'Extra Payment Received', 'Bill on Hold Cleared', 'Tips', 'Valet Tips']);

function isExcessJust(j: TaggedUpiJustification): boolean {
  return (j.sign === 'excess' || EXCESS_REMARKS.has(j.remark)) && (!j.source || j.source === 'HDFC/Kotak UPI');
}

export function runMatch(input: MatchInput): MatchResult {
  const { sessions, mprParsed, upiPRRows, upiJustifications } = input;

  // ── Lookup construction ───────────────────────────────────────────────
  // `mprByRRN` is deliberately not a bare last-write-wins map — see the
  // "ambiguous RRN collision" fix in the plan/README. A collision is
  // recorded in `ambiguous` and neither candidate is available to match.
  const mprByRRNCandidates = new Map<string, MprRow[]>();
  const mprHdfcUpi: MprRow[] = [];
  const mprAmex: AmexMprRow[] = [];

  for (const parsed of mprParsed) {
    if (parsed.error) continue;
    if (parsed.matchStrategy === 'batch') {
      mprAmex.push(...(parsed.rows as AmexMprRow[]));
      continue;
    }
    for (const row of parsed.rows as MprRow[]) {
      if (parsed.source === 'HDFC_UPI') mprHdfcUpi.push(row);
      if (row.rrn) {
        const list = mprByRRNCandidates.get(row.rrn) ?? [];
        list.push(row);
        mprByRRNCandidates.set(row.rrn, list);
      }
    }
  }

  const ambiguous: AmbiguousMprRow[] = [];
  const mprByRRN = new Map<string, MprRow>();
  for (const [rrn, candidates] of mprByRRNCandidates) {
    if (candidates.length > 1) ambiguous.push({ rrn, candidates });
    else mprByRRN.set(rrn, candidates[0]!);
  }

  const result: MatchResult = {
    settled: [],
    amountMismatch: [],
    pending: [],
    ambiguous,
    unexpected: [],
    amexResults: [],
    upiResults: [],
  };

  const usedMPRRRNs = new Set<string>();
  const usedHdfcUpiIdxs = new Set<number>();

  // ── Primary RRN match — Kotak / Pinelabs / HDFC-terminal ──────────────
  for (const row of sessions) {
    if (row.acquirer === 'AMEX') continue;
    if (!row.rrn || row.rrn === '000000000000') {
      result.pending.push({ ...row, _reason: 'No RRN' });
      continue;
    }
    const mpr = mprByRRN.get(row.rrn);
    if (!mpr) {
      result.pending.push({ ...row, _reason: 'Not in MPR' });
      continue;
    }
    usedMPRRRNs.add(row.rrn);
    const diff = (row.plAmount || 0) - (mpr.grossAmount || 0);
    if (Math.abs(diff) < AMOUNT_EPSILON) {
      result.settled.push({ ...row, mpr, _diff: diff });
    } else {
      result.amountMismatch.push({ ...row, mpr, _diff: diff });
    }
  }

  // ── Unexpected Kotak/Pinelabs MPR credits ─────────────────────────────
  // **Fix over legacy**: `results.unexpected` is only ever populated from
  // the AMEX and HDFC-UPI matchers (`results.unexpected.push` appears
  // exactly once in the whole legacy file, inside the UPI section) — a
  // Kotak or Pinelabs MPR row with no settlement-ledger counterpart is
  // silently dropped, even though the results screen is fully built to
  // group and display exactly this case for every source, Kotak/Pinelabs
  // included (`SOURCE_LABELS`). Real money the bank settled with no record
  // in Layer 1 at all is the most important case to surface, not the
  // easiest to skip. HDFC_UPI rows are excluded here — they get their own,
  // more thorough unexpected-detection (RRN/amount/justification-aware) in
  // `runUpiMatch` below.
  for (const [rrn, mpr] of mprByRRN) {
    if (mpr._source === 'HDFC_UPI' || usedMPRRRNs.has(rrn)) continue;
    result.unexpected.push({
      rrn,
      mprAmount: mpr.grossAmount,
      mprDate: mpr.settlementDate,
      mprTxnDate: mpr.txnDateRaw || mpr.txnDate,
      _source: mpr._source,
      _file: mpr._file,
    });
  }

  // ── AMEX submission-level matching ────────────────────────────────────
  runAmexMatch(sessions, mprAmex, result);

  // ── HDFC Static UPI matching ───────────────────────────────────────────
  runUpiMatch(upiPRRows, upiJustifications, mprHdfcUpi, usedHdfcUpiIdxs, usedMPRRRNs, result);

  return result;
}

function runAmexMatch(
  sessions: MatchInput['sessions'],
  mprAmex: AmexMprRow[],
  result: MatchResult,
): void {
  const amexRows = sessions.filter((r) => r.acquirer === 'AMEX');

  interface L1AmexGroup {
    mid: string;
    timestamp: string;
    subDate: string | null;
    rows: MatchInput['sessions'];
    total: number;
    maxInvoice: number;
    socExpected: number | null;
    outlet: string;
  }

  const l1Groups = new Map<string, L1AmexGroup>();
  for (const r of amexRows) {
    const mid = (r.mid ?? '').replace(/^'/, '');
    const timestamp = r.plSettlementDate || '';
    if (!mid || !timestamp) continue;
    const key = mid + '|' + timestamp;
    let g = l1Groups.get(key);
    if (!g) {
      g = {
        mid,
        timestamp,
        subDate: amexNormDate(timestamp),
        rows: [],
        total: 0,
        maxInvoice: 0,
        socExpected: null,
        outlet: r.outlet || '',
      };
      l1Groups.set(key, g);
    }
    g.rows.push(r);
    g.total += r.plAmount || 0;
    const inv = parseInt(r.invoice || '0', 10) || 0;
    if (inv > 0 && inv > g.maxInvoice) {
      g.maxInvoice = inv;
      g.socExpected = inv + 1;
    }
  }

  const usedMPRSubmissions = new Set<string>();

  for (const l1 of l1Groups.values()) {
    const candidates = mprAmex.filter((m) => {
      const mKey = m.mid + '|' + m.submissionDate + '|' + m.socNumber;
      return (
        !usedMPRSubmissions.has(mKey) &&
        m.mid === l1.mid &&
        m.submissionDate === l1.subDate &&
        Math.abs(m.submissionAmount - l1.total) < AMEX_EPSILON
      );
    });

    let mprMatch: AmexMprRow | null = null;
    if (l1.socExpected && candidates.length > 1) {
      mprMatch = candidates.find((m) => parseInt(m.socNumber, 10) === l1.socExpected) ?? candidates[0] ?? null;
    } else {
      mprMatch = candidates[0] ?? null;
    }

    if (mprMatch) {
      const mKey = mprMatch.mid + '|' + mprMatch.submissionDate + '|' + mprMatch.socNumber;
      usedMPRSubmissions.add(mKey);
      const entry: AmexResult = {
        mid: l1.mid,
        date: l1.subDate,
        timestamp: l1.timestamp,
        outlet: l1.outlet,
        txnCount: l1.rows.length,
        l1Total: l1.total,
        mprRow: mprMatch,
        _match: 'settled',
        socNumber: mprMatch.socNumber,
        dbaName: mprMatch.dbaName,
        socExpected: l1.socExpected,
        socMatch: l1.socExpected ? parseInt(mprMatch.socNumber, 10) === l1.socExpected : null,
      };
      result.amexResults.push(entry);
    } else {
      const mprDiff = mprAmex.find((m) => m.mid === l1.mid && m.submissionDate === l1.subDate) ?? null;
      const entry: AmexResult = {
        mid: l1.mid,
        date: l1.subDate,
        timestamp: l1.timestamp,
        outlet: l1.outlet,
        txnCount: l1.rows.length,
        l1Total: l1.total,
        mprRow: mprDiff,
        _match: mprDiff ? 'mismatch' : 'pending',
        _diff: mprDiff ? mprDiff.submissionAmount - l1.total : null,
        socNumber: mprDiff?.socNumber ?? '',
        dbaName: mprDiff?.dbaName ?? '',
        socExpected: l1.socExpected,
      };
      result.amexResults.push(entry);
    }
  }

  for (const m of mprAmex) {
    const mKey = m.mid + '|' + m.submissionDate + '|' + m.socNumber;
    if (!usedMPRSubmissions.has(mKey)) {
      result.amexResults.push({
        mid: m.mid,
        date: m.submissionDate,
        timestamp: null,
        outlet: '',
        txnCount: m.transactionCount,
        l1Total: null,
        mprRow: m,
        _match: 'unexpected',
        socNumber: m.socNumber,
        dbaName: m.dbaName,
      });
    }
  }
}

function runUpiMatch(
  upiPRRows: TaggedUpiTransaction[],
  upiJustifications: TaggedUpiJustification[],
  mprHdfcUpi: MprRow[],
  usedHdfcUpiIdxs: Set<number>,
  usedMPRRRNs: Set<string>,
  result: MatchResult,
): void {
  // Step 0: group PR rows by RRN (multiple PR rows can share one RRN).
  const upiPRByRRN = new Map<string, TaggedUpiTransaction[]>();
  const upiPRNoRRN: TaggedUpiTransaction[] = [];
  for (const pr of upiPRRows) {
    const rrn = (pr.rrn || '').replace(/\D/g, '');
    if (rrn.length === 12) {
      const list = upiPRByRRN.get(rrn) ?? [];
      list.push(pr);
      upiPRByRRN.set(rrn, list);
    } else {
      upiPRNoRRN.push(pr);
    }
  }

  // Pass 1 — RRN match, handling MPR rows whose RRN cell holds several RRNs.
  const upiPRMatchedRRNs = new Set<string>();
  for (let mi = 0; mi < mprHdfcUpi.length; mi++) {
    if (usedHdfcUpiIdxs.has(mi)) continue;
    const mprRow = mprHdfcUpi[mi]!;
    const { valid: validRRNs, invalid: invalidRRNs } = splitRRNs(mprRow.rrn);
    if (validRRNs.length === 0) continue;

    const matchedGroups: Array<{ rrn: string; prRows: TaggedUpiTransaction[]; total: number }> = [];
    const missingRRNs: string[] = [];
    for (const rrn of validRRNs) {
      const prGroup = upiPRByRRN.get(rrn);
      if (prGroup && prGroup.length && !upiPRMatchedRRNs.has(rrn)) {
        matchedGroups.push({ rrn, prRows: prGroup, total: prGroup.reduce((s, p) => s + (p.amount || 0), 0) });
      } else {
        missingRRNs.push(rrn);
      }
    }
    if (missingRRNs.length > 0) continue;

    const prTotal = matchedGroups.reduce((s, g) => s + g.total, 0);
    const diff = prTotal - (mprRow.grossAmount || 0);
    const amtOk = Math.abs(diff) < AMOUNT_EPSILON;
    const hasInvalid = invalidRRNs.length > 0;
    const allPRRows = matchedGroups.flatMap((g) => g.prRows);

    usedHdfcUpiIdxs.add(mi);
    for (const g of matchedGroups) upiPRMatchedRRNs.add(g.rrn);

    result.upiResults.push({
      pr: allPRRows,
      mpr: mprRow,
      _match: !amtOk ? 'mismatch' : hasInvalid ? 'partial' : 'settled',
      _diff: diff,
      _matchBy: 'RRN',
      _multiRRN: validRRNs.length > 1 || allPRRows.length > 1,
      _invalidRRNs: invalidRRNs,
      _dateAdjusted: false,
      _timeDiffSec: null,
    });
  }

  const upiUnmatchedPR: TaggedUpiTransaction[] = [];
  for (const [rrn, prRows] of upiPRByRRN) {
    if (!upiPRMatchedRRNs.has(rrn)) upiUnmatchedPR.push(...prRows);
  }
  upiUnmatchedPR.push(...upiPRNoRRN);

  // Pass 2 — amount + transaction-timestamp match, ±1hr window, closest wins.
  for (const pr of upiUnmatchedPR) {
    const prDt = parseTxnTimestamp(pr.date);
    const prAdj = adjustPRDate(prDt);

    let bestIdx = -1;
    let bestDiff = Infinity;
    for (let i = 0; i < mprHdfcUpi.length; i++) {
      if (usedHdfcUpiIdxs.has(i)) continue;
      const mprRow = mprHdfcUpi[i]!;
      if (Math.abs((mprRow.grossAmount || 0) - (pr.amount || 0)) >= AMOUNT_EPSILON) continue;
      const mprDt = parseTxnTimestamp(mprRow.txnDateRaw || mprRow.txnDate);
      if (!mprDt || !prAdj) continue;
      const diffSec = Math.abs(prAdj.getTime() - mprDt.getTime()) / 1000;
      if (diffSec <= UPI_DATE_WINDOW_SEC && diffSec < bestDiff) {
        bestDiff = diffSec;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      usedHdfcUpiIdxs.add(bestIdx);
      const mprRow = mprHdfcUpi[bestIdx]!;
      const diff = (pr.amount || 0) - (mprRow.grossAmount || 0);
      const adjusted = !!prDt && adjustPRDate(prDt) !== prDt;
      result.upiResults.push({
        pr: [pr],
        mpr: mprRow,
        _match: 'settled',
        _diff: diff,
        _matchBy: 'Amount + Date',
        _multiRRN: false,
        _invalidRRNs: [],
        _dateAdjusted: adjusted,
        _timeDiffSec: Math.round(bestDiff),
      });
    } else {
      result.upiResults.push({
        pr: [pr],
        mpr: null,
        _match: 'pending',
        _diff: null,
        _matchBy: null,
      });
    }
  }

  // Excess-justification pass — the only channel Layer-1 BOH/Advances reach Layer 2 through.
  const upiJustByRRN = new Map<string, TaggedUpiJustification>();
  const upiJustByAmt = new Map<number, TaggedUpiJustification[]>();
  for (const j of upiJustifications) {
    if (!isExcessJust(j)) continue;
    const rrn = (j.rrn || '').replace(/[^0-9]/g, '');
    if (rrn.length === 12 && !/^0+$/.test(rrn) && !/^9+$/.test(rrn)) upiJustByRRN.set(rrn, j);
    const amt = parseFloat(String(j.amount)) || 0;
    const list = upiJustByAmt.get(amt) ?? [];
    list.push(j);
    upiJustByAmt.set(amt, list);
  }

  const mprDateFor = (m: MprRow) => normDate(m.txnDateRaw || m.txnDate) || '';

  for (const j of upiJustifications) {
    if (!isExcessJust(j)) continue;
    const rrn = (j.rrn || '').replace(/[^0-9]/g, '');
    const hasRealRRN = rrn.length === 12 && !/^0+$/.test(rrn) && !/^9+$/.test(rrn);
    const bizDate = j._businessDate || '';
    const matchedByRRN =
      hasRealRRN &&
      mprHdfcUpi.some((m) => {
        const md = mprDateFor(m);
        return normRRN(m.rrn) === normRRN(rrn) && (!bizDate || (md && md >= bizDate));
      });
    const matchedByAmt = mprHdfcUpi.some((m) => {
      const md = mprDateFor(m);
      return Math.abs(m.grossAmount - (parseFloat(String(j.amount)) || 0)) < AMOUNT_EPSILON && (!bizDate || (md && md >= bizDate));
    });
    if (!matchedByRRN && !matchedByAmt) {
      result.upiResults.push({
        pr: { amount: parseFloat(String(j.amount)) || 0, orderNo: '—', date: j._businessDate || '—', outlet: j.outlet || '', rrn: rrn || '' },
        mpr: null,
        _match: 'pending',
        _diff: null,
        _matchBy: null,
        _gmNote: j.remark + (j.description ? ': ' + j.description : ''),
      });
    }
  }

  for (let i = 0; i < mprHdfcUpi.length; i++) {
    if (usedHdfcUpiIdxs.has(i)) continue;
    const mprRow = mprHdfcUpi[i]!;
    const mprRRNList = splitRRNs(mprRow.rrn).valid;
    const mprAlreadyUsed =
      mprRRNList.length > 0 ? mprRRNList.every((r) => usedMPRRRNs.has(r)) : usedMPRRRNs.has(mprRow.rrn || '');
    if (mprAlreadyUsed) continue;

    const mprTxnDateNorm = normDate(mprRow.txnDateRaw || mprRow.txnDate) || '';
    const mprFirstRRN = mprRRNList[0] || normRRN(mprRow.rrn) || '';

    const justByRRN = upiJustByRRN.get(mprFirstRRN);
    if (justByRRN && !justByRRN._usedForMPR && (!justByRRN._businessDate || (mprTxnDateNorm && mprTxnDateNorm >= justByRRN._businessDate))) {
      justByRRN._usedForMPR = true;
      result.upiResults.push({
        pr: { amount: parseFloat(String(justByRRN.amount)) || 0, orderNo: '—', date: justByRRN._businessDate || '—', outlet: justByRRN.outlet || '', rrn: normRRN(mprRow.rrn) || '' },
        mpr: mprRow,
        _match: 'settled',
        _diff: 0,
        _matchBy: 'rrn',
        _dateAdjusted: false,
        _timeDiffSec: null,
        _gmNote: justByRRN.remark + (justByRRN.description ? ': ' + justByRRN.description : ''),
      });
      continue;
    }

    const justByAmt = (upiJustByAmt.get(mprRow.grossAmount) ?? []).find(
      (j) => !j._usedForMPR && isExcessJust(j) && (!j._businessDate || (mprTxnDateNorm && mprTxnDateNorm >= j._businessDate)),
    );
    if (justByAmt) {
      justByAmt._usedForMPR = true;
      result.upiResults.push({
        pr: { amount: mprRow.grossAmount, orderNo: '—', date: justByAmt._businessDate || '—', outlet: justByAmt.outlet || '', rrn: justByAmt.rrn || '' },
        mpr: mprRow,
        _match: 'settled',
        _diff: 0,
        _matchBy: 'amount',
        _dateAdjusted: false,
        _timeDiffSec: null,
        _gmNote: justByAmt.remark + (justByAmt.description ? ': ' + justByAmt.description : ''),
      });
    } else {
      result.unexpected.push({
        rrn: mprRow.rrn || '',
        mprAmount: mprRow.grossAmount,
        mprDate: mprRow.settlementDate,
        mprTxnDate: mprRow.txnDateRaw || mprRow.txnDate,
        _source: 'HDFC_UPI',
        _file: mprRow._file,
      });
    }
  }
}
