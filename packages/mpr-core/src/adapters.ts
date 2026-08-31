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
      netAmount: ['NET', 'Net Amount', 'Amount Paid'],
      txnDate: ['Txn Date', 'Transaction Date'],
      settlementDate: ['PAID Date', 'Settlement Date', 'Paid Date'],
      mid: ['MID', 'Merchant ID'],
      tid: ['TID', 'Terminal ID'],
      channel: ['Channel Type', 'Channel'],
      cardType: ['Card', 'Card Type'],
      fee: ['MSF', 'MSF Amount'],
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
      netAmount: ['Paid to Merchant A/c', 'Net Amount'],
      txnDate: ['Txn Date', 'Transaction Date'],
      settlementDate: ['Settlement Date'],
      store: ['Store Name', 'Store ID'],
      tid: ['TID', 'Terminal ID'],
      fee: ['Total Fee(including Taxes)', 'Total Fee'],
      acquirer: ['Acquirer name/Netbanking name/wallet name/pbp name', 'Acquirer'],
      cardNetwork: ['Card network'],
      foreign: ['Foreign/ Domestic'],
    },
  },
  AMEX: {
    label: 'AMEX MPR',
    color: '#0369a1',
    matchStrategy: 'batch',
    headerFingerprint: ['Settlement date', 'Settlement number', 'Submission amount', 'DBA name'],
    fields: {
      settlementDate: ['Settlement date', 'Settlement Date'],
      settlementNumber: ['Settlement number', 'Settlement No', 'Settlement No.'],
      submissionAmount: ['Submission amount', 'Submission Amt', 'Total charges'],
      merchantFees: ['Merchant Fees', 'Merchant Service Fee', 'MSF'],
      settlementAmount: ['Settlement amount', 'Amount Paid To Bank'],
      dbaName: ['DBA name', 'DBA Name', 'Branch', 'Merchant Name'],
    },
  },
  HDFC_UPI: {
    label: 'HDFC UPI MPR',
    color: '#0f766e',
    headerFingerprint: ['Txn ref no. (RRN)', 'Merchant VPA', 'External MID', 'UPI Merchant ID'],
    fields: {
      rrn: ['Txn ref no. (RRN)', 'RRN', 'Reference No'],
      grossAmount: ['Transaction Amount', 'Txn Amount'],
      netAmount: ['Net Amount'],
      txnDate: ['Transaction Req Date', 'Txn Date'],
      settlementDate: ['Settlement Date'],
      merchantVPA: ['Merchant VPA'],
      merchantName: ['Merchant Name'],
      mid: ['External MID', 'MID'],
      fee: ['MSF Amount', 'MSF'],
    },
    // Footer rows have a null RRN column — drop them.
    nullRRNStrategy: 'skip_null',
  },
};

/**
 * Filename-based adapter guess — tried first, at upload time. If it fails,
 * `parseMprFile` falls back to content sniffing (fingerprint-scanning every
 * sheet). `0790431`/`925792` are literal substrings observed in real bank
 * export filenames — brittle but intentional, ported as-is.
 */
export function detectAdapter(filename: string): AdapterKey | null {
  if (/kotak.*mpr|mpr.*kotak|0790431/i.test(filename)) return 'KOTAK';
  if (/pinelabs|pos.*authmerchan|merchantmpr|^mpr__/i.test(filename)) return 'PINELABS';
  if (/amex|settlements\d{8}/i.test(filename)) return 'AMEX';
  if (/\.csv$/i.test(filename) && /settlement/i.test(filename)) return 'AMEX';
  if (/merchant_payout_report.*stid|925792/i.test(filename)) return 'HDFC_UPI';
  return null;
}
