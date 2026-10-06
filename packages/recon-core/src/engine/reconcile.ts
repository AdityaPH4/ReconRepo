/**
 * The top-level reconciliation pass.
 * Ported from `reconciliation (68).html` lines 1118–1225 (`reconcile`).
 *
 * Pure: same inputs always give the same output, no clock, no I/O, no globals.
 * Everything a human subsequently adds — remarks, advances, BOH clears,
 * square-offs — is session state layered on top of this result, never mixed
 * into it. That separation is what makes a session re-runnable and auditable.
 */

import type {
  MatchResult,
  PRRow,
  ReconResult,
  ReconcileInput,
  Tab,
  ZipRow,
} from '../types.js';
import { groupAmexPR, matchAmex } from './amex.js';
import { matchTransactionLevel } from './match.js';

/** Buckets Payment Report rows by the panel their payment name routes to. */
function bucketByTab(prData: readonly PRRow[]): Record<Tab, PRRow[]> {
  const byTab: Record<Tab, PRRow[]> = {
    pinelabs: [],
    swiggy: [],
    cash: [],
    upi: [],
    bills: [],
    bank: [],
    hdfc_link: [],
    other: [],
  };
  for (const r of prData) {
    const bucket = byTab[r.tab];
    if (bucket) bucket.push(r);
    else byTab.other.push(r);
  }
  return byTab;
}

export function reconcile(input: ReconcileInput): ReconResult {
  const { prData, zipInside, hdfcStmtRows, linkStmtRows, outlet } = input;

  const byTab = bucketByTab(prData);

  // ── Pinelabs: split AMEX out, since the two sides key differently ───────
  const plAll = byTab.pinelabs;
  const plAmexRows = plAll.filter((r) => r.isAmex);
  const plNonAmexRows = plAll.filter((r) => !r.isAmex);
  const zipAmex = zipInside.filter((r) => r._amex);
  const zipNonAmex = zipInside.filter((r) => !r._amex);

  const plAmexGroups = groupAmexPR(plAmexRows);

  const { reconRows, onlyPOS, onlyTerm, dupRRN } = matchTransactionLevel<ZipRow>(
    plNonAmexRows,
    zipNonAmex,
  );

  // ── Optional: transaction-level Static UPI ──────────────────────────────
  // Runs only when an HDFC statement was uploaded, and only for HDFC rows.
  // Kotak Static UPI stays on the aggregate drawer flow — no Kotak statement
  // format exists yet.
  let upiHdfc: MatchResult<never> | ReconResult['upiHdfc'] = null;
  if (hdfcStmtRows && hdfcStmtRows.length) {
    const upiHdfcRows = byTab.upi.filter((r) => /hdfc/i.test(r.paymentName || ''));
    const stmtForOutlet = hdfcStmtRows.filter((r) => !outlet || r.outlet === outlet);
    if (upiHdfcRows.length || stmtForOutlet.length) {
      upiHdfc = matchTransactionLevel(upiHdfcRows, stmtForOutlet);
    }
  }

  // ── Optional: transaction-level HDFC Payment Link ───────────────────────
  // Runs only when a Payment Link report was uploaded. Matched by ARN —
  // the Payment Report's own `rrn` already carries it for a Payment Link
  // transaction (same column every other payment method's RRN comes from),
  // exactly the same shape as the HDFC Static UPI match just above. No
  // padding/aliasing needed, unlike the Layer-2 MPR feed's own Merchant
  // Order ID convention (`hdfcLinkSettlementLedger()`), which is unrelated.
  let linkStmt: MatchResult<never> | ReconResult['linkStmt'] = null;
  if (linkStmtRows && linkStmtRows.length) {
    if (byTab.hdfc_link.length || linkStmtRows.length) {
      linkStmt = matchTransactionLevel(byTab.hdfc_link, linkStmtRows);
    }
  }

  // ── AMEX: auth code, then amount ────────────────────────────────────────
  const amex = matchAmex(plAmexGroups, zipAmex);

  return {
    pinelabs: {
      reconRows,
      // AMEX exceptions merge into the same buckets so the UI and the
      // submission gate see one unified set of unmatched Pinelabs rows.
      onlyPOS: [...onlyPOS, ...amex.amexOnlyPOS],
      onlyTerm: [...onlyTerm, ...amex.amexOnlyTerm],
      dupRRN,
      amexOk: amex.amexOk,
      amexDup: amex.amexDup,
      amexDupTerm: amex.amexDupTerm,
    },
    upiHdfc: upiHdfc as ReconResult['upiHdfc'],
    linkStmt: linkStmt as ReconResult['linkStmt'],
    swiggy: byTab.swiggy,
    cash: byTab.cash,
    upi: byTab.upi,
    bills: byTab.bills,
    bank: byTab.bank,
    hdfcLink: byTab.hdfc_link,
    other: byTab.other,
    zipFiltered: [],
  };
}
