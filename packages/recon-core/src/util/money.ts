/**
 * Amount parsing, comparison and formatting.
 * Ported from `reconciliation (68).html` lines 738–764.
 */

import { AMOUNT_EPSILON } from '../constants.js';

/**
 * Parses a currency cell into a number, stripping thousands separators,
 * whitespace and the rupee sign.
 *
 * Returns `NaN` for blank/unparseable input — this is load-bearing. The legacy
 * code relies on `NaN` propagating so that "no value" is visibly distinct from
 * "zero" in the UI (`fmt()` renders it as an em dash). Do not "fix" this to
 * return 0.
 */
export function money(s: string | number | null | undefined): number {
  if (s === null || s === undefined) return NaN;
  return parseFloat(String(s).replace(/[,\s₹]/g, ''));
}

/** Strips leading apostrophes that Excel prepends to preserve long digits. */
export function cleanRRN(s: string | null | undefined): string {
  return s ? String(s).trim().replace(/^'+/, '').trim() : '';
}

/** Strips surrounding apostrophes from auth/approval codes. */
export function cleanCode(s: string | null | undefined): string {
  return s ? String(s).trim().replace(/^'+|'+$/g, '').trim() : '';
}

/** True when two amounts are equal within the shared tolerance. */
export function amountsEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < AMOUNT_EPSILON;
}

/** True when a difference is large enough to require explanation. */
export function isMaterial(diff: number): boolean {
  return Math.abs(diff) >= AMOUNT_EPSILON;
}

/** Formats an amount as Indian-locale rupees; `NaN`/undefined render as `—`. */
export function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return (
    '₹' +
    n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

/** Detects AMEX from a PR `bank` or ZIP `acquirer` value. */
export function isAmex(s: string | null | undefined): boolean {
  return /amex|american\s*express/i.test(s || '');
}

/**
 * Legacy aliases. The original file had two identical implementations —
 * `isAmexBank` for the PR side and `isAmexAcq` for the terminal side — kept
 * here so ported call sites read the same as the code they came from.
 */
export const isAmexBank = isAmex;
export const isAmexAcq = isAmex;
