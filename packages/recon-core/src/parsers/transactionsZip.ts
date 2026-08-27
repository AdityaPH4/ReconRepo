/**
 * "All Transactions" ZIP reader — the Pinelabs terminal report.
 * Ported from `reconciliation (68).html` lines 908–959 (`readZIP`, `zipRow`).
 */

import JSZip from 'jszip';
import type { BusinessWindow, ZipParse, ZipRow } from '../types.js';
import { cell, headerIndex, parseCSV } from '../util/csv.js';
import { inWin, parseZipDT } from '../util/dates.js';
import { cleanCode, cleanRRN, isAmexAcq, money } from '../util/money.js';

type ColMap = Record<string, number>;

/**
 * Maps one terminal CSV row to a `ZipRow`.
 *
 * Note on `invoice`: the legacy `zipRow` object literal declared `invoice`
 * twice — first as `cleanRRN(...)`, then again as a plain `.trim()`. In JS the
 * later key wins, so the apostrophe-stripping never applied. The plain trim is
 * reproduced here to preserve behaviour; `billInvoice` does still get
 * `cleanRRN` as it did originally.
 */
function zipRow(r: readonly string[], C: ColMap): ZipRow {
  const acq = cell(r, C.acquirer!);
  return {
    acquirer: acq,
    paymentMode: cell(r, C.paymentMode!),
    name: cell(r, C.name!),
    cardIssuer: cell(r, C.cardIssuer!),
    amount: money(cell(r, C.amount!)),
    tip: money(cell(r, C.tip!) || '0'),
    date: cell(r, C.date!),
    batchStatus: cell(r, C.batchStatus!),
    txnStatus: cell(r, C.txnStatus!),
    rrn: cleanRRN(cell(r, C.rrn!)),
    settlementDate: cell(r, C.settlementDate!),
    billInvoice: cleanRRN(cell(r, C.billInvoice!)),
    invoice: cell(r, C.invoice!),
    approvalCode: cleanCode(cell(r, C.approvalCode!)),
    type: cell(r, C.type!),
    zone: cell(r, C.zone!),
    store: cell(r, C.store!),
    tid: cell(r, C.tid!),
    mid: cell(r, C.mid!).replace(/^'/, ''),
    isAmex: isAmexAcq(acq),
    _src: 'ZIP',
    _amex: isAmexAcq(acq),
  };
}

/**
 * Reads the first CSV found inside the uploaded ZIP and splits its rows into
 * those that count toward reconciliation (`inside`) and those excluded
 * (`filtered`, each carrying a `_fReason`).
 *
 * Three exclusions apply, in order:
 *  1. `Txn Status` other than `success`
 *  2. Paper POS rows — no digital amount, so not part of electronic settlement
 *  3. Timestamps outside the business window (AMEX included — the legacy
 *     comment is explicit that the window applies to both)
 */
export async function parseTransactionsZip(
  data: Buffer | ArrayBuffer | Uint8Array,
  win: BusinessWindow | null,
): Promise<ZipParse> {
  const z = await JSZip.loadAsync(data);
  const cn = Object.keys(z.files).find((n) => n.toLowerCase().endsWith('.csv'));
  if (!cn) return { inside: [], filtered: [] };

  const txt = await z.files[cn]!.async('text');
  const rows = parseCSV(txt);
  if (rows.length < 2) return { inside: [], filtered: [] };

  const H = headerIndex(rows[0]!);
  const C: ColMap = {
    acquirer: H.preferExact('acquirer'),
    paymentMode: H.preferExact('payment mode'),
    name: H.preferExact('name'),
    cardIssuer: H.preferExact('card issuer'),
    amount: H.preferExact('amount'),
    tip: H.preferExact('tip amount'),
    date: H.preferExact('date'),
    batchStatus: H.preferExact('batch status'),
    txnStatus: H.preferExact('txn status'),
    rrn: H.preferExact('rrn'),
    settlementDate: H.preferExact('settlement date'),
    billInvoice: H.preferExact('bill invoice'),
    // Exact only — a loose match would collide with "Bill Invoice".
    invoice: H.exact('invoice'),
    approvalCode: H.preferExact('approval code'),
    type: H.preferExact('type'),
    zone: H.preferExact('zone'),
    store: H.preferExact('store name'),
    tid: H.preferExact('tid'),
    mid: H.preferExact('mid'),
    hardwareModel: H.preferExact('hardware model'),
  };

  const inside: ZipRow[] = [];
  const filtered: ZipRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.length < 5 || !r[0]?.trim()) continue;

    const rawStatus = cell(r, C.txnStatus!);
    if (rawStatus.toLowerCase() !== 'success') {
      filtered.push({ ...zipRow(r, C), _fReason: `Not successful (${rawStatus})` });
      continue;
    }

    const hwModel = cell(r, C.hardwareModel!).toUpperCase();
    const pmMode = cell(r, C.paymentMode!).toUpperCase();
    if (hwModel === 'PAPER POS' || pmMode === 'PAPER POS') {
      filtered.push({ ...zipRow(r, C), _fReason: 'Paper POS — excluded from recon' });
      continue;
    }

    const dt = parseZipDT(cell(r, C.date!));
    const row = zipRow(r, C);

    if (win && dt) {
      if (inWin(dt, win)) inside.push(row);
      else filtered.push({ ...row, _fReason: 'Outside business window' });
    } else {
      // No window (no business date) or an unparseable timestamp — retained,
      // matching the legacy fallback rather than silently dropping the row.
      inside.push(row);
    }
  }

  return { inside, filtered };
}
