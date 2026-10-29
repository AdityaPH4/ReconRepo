/**
 * Bank MPR adapter definitions — column-name aliases, no hardcoded positions.
 * Ported from `mpr-recon (10).html` lines 239–311.
 */

import type { AdapterDef, AdapterKey } from './types.js';

export const ADAPTERS: Record<AdapterKey, AdapterDef> = {
  KOTAK: {
    label: 'Kotak MPR',
    color: '#ea580c',
    headerFingerprint: ['RRN No.', 'Txn Amt', 'PAID Date', 'Txn Date', 'MID'],
    fields: {
      rrn: ['RRN No.', 'RRN Number', 'Retrieval Ref No', 'Ret Ref No'],
      grossAmount: ['Txn Amt', 'Transaction Amount', 'Gross Amount'],
      txnDate: ['Txn Date', 'Transaction Date'],
      settlementDate: ['PAID Date', 'Settlement Date', 'Paid Date'],
    },
    // Footer detection — a row containing this text ends the data.
    nullRRNMarker: 'Payout Summary',
  },
  PINELABS: {
    label: 'Pinelabs MPR',
    color: '#7c3aed',
    sheet: 'Trxn details',
    // 0-indexed; row 0 is a grouping-label row, row 1 is real headers — this
    // bypasses fingerprint scanning for the header row (unlike the other
    // three adapters), matching legacy exactly. If Pinelabs ever changes
    // this template, it will silently misalign rather than raise an error —
    // a known legacy fragility, preserved rather than speculatively guarded.
    headerRow: 1,
    headerFingerprint: ['RRN number', 'Gross Txn Amount', 'Store Name', 'Store ID'],
    fields: {
      rrn: ['RRN number', 'RRN No', 'Retrieval Reference Number'],
      grossAmount: ['Gross Txn Amount', 'Transaction Amount'],
      txnDate: ['Txn Date', 'Transaction Date'],
      settlementDate: ['Settlement Date'],
    },
  },
  AMEX: {
    label: 'AMEX MPR',
    color: '#0369a1',
    matchStrategy: 'batch',
    headerFingerprint: ['Record Type', 'Transaction Timestamp', 'Card Number', 'Charge Amount'],
    // Unused by AMEX — `parseAmexCSV` resolves its own columns directly
    // (same as before this adapter's export format changed). Kept only so
    // `AdapterDef.fields` stays non-optional like every other adapter's.
    fields: {
      settlementDate: ['Payment Date'],
      settlementNumber: ['Settlement Number'],
      submissionAmount: ['Charge Amount'],
      merchantFees: [],
      settlementAmount: [],
      dbaName: [],
    },
  },
  HDFC_UPI: {
    label: 'HDFC UPI MPR',
    color: '#0f766e',
    headerFingerprint: ['Txn ref no. (RRN)', 'Merchant VPA', 'External MID', 'UPI Merchant ID'],
    fields: {
      rrn: ['Txn ref no. (RRN)', 'RRN', 'Reference No'],
      grossAmount: ['Transaction Amount', 'Txn Amount'],
      txnDate: ['Transaction Req Date', 'Txn Date'],
      settlementDate: ['Settlement Date'],
    },
    // Footer rows have a null RRN column — drop them.
    nullRRNStrategy: 'skip_null',
  },
  HDFC_LINK: {
    label: 'HDFC Link',
    color: '#1d4ed8',
    // Distinctive to this aggregator's export — won't collide with Kotak/
    // Pinelabs/HDFC_UPI's own fingerprints.
    headerFingerprint: ['SG MID', 'Merchant Order ID', 'SG Txn ID', 'SG Refund ID'],
    fields: {
      // No RRN column exists on this file — UPI rows carry a UTR, card rows
      // an ARN instead, neither populated on every row. Merchant Order ID
      // is, so it's aliased as the join key here (see `snapshot.ts`'s
      // `hdfcLinkSettlementLedger()` on the Layer-1 side, which does the same).
      rrn: ['Merchant Order ID'],
      grossAmount: ['Txn Amount'],
      txnDate: ['Txn Date'],
      settlementDate: ['Settlement Date'],
    },
  },
};

/**
 * Filename-based adapter guess — tried first, at upload time. If it fails,
 * `parseMprFile` falls back to content sniffing (fingerprint-scanning every
 * sheet). `0790431`/`925792` are literal substrings observed in real bank
 * export filenames — brittle but intentional, ported as-is. Kotak's real
 * mail attachments are named starting with `0790` (one file per mail), so
 * that's matched as a filename prefix, not just the old `0790431` substring.
 */
export function detectAdapter(filename: string): AdapterKey | null {
  if (/kotak.*mpr|mpr.*kotak|0790431|^0790/i.test(filename)) return 'KOTAK';
  if (/pinelabs|pos.*authmerchan|merchantmpr|^mpr__/i.test(filename)) return 'PINELABS';
  if (/merchant_payout_report.*stid|925792/i.test(filename)) return 'HDFC_UPI';
  // Checked before the broad "any .csv named *settlement*" AMEX rule below —
  // otherwise a name like "HDFC_Link_Settlement.csv" would match that first.
  if (/hdfc.*link/i.test(filename)) return 'HDFC_LINK';
  if (/amex|settlements\d{8}/i.test(filename)) return 'AMEX';
  if (/\.csv$/i.test(filename) && /settlement/i.test(filename)) return 'AMEX';
  return null;
}
