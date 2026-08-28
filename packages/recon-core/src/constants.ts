/**
 * Business constants, ported verbatim from `reconciliation (68).html` lines 456–519.
 *
 * Values here encode operational policy (which payment names route where, the
 * submission threshold, the store→outlet mapping). They are intentionally
 * unchanged from the legacy file — any edit is a business decision, not a
 * refactor.
 */

import type { FrsMethod, OutletCode, Tab } from './types.js';

// ── Remark vocabularies ───────────────────────────────────────────────────
// Shared by the Pinelabs, Cash, UPI and Bank panels.
export const REMARKS_EXCESS = [
  'Advance Received',
  'Tips',
  'Extra Payment Received',
  'Bill on Hold Cleared',
  'Other',
] as const;

export const REMARKS_SHORTAGE = [
  'Advance Applied',
  'Short Collection',
  'Other',
] as const;

export const REMARKS_ALL = [...REMARKS_EXCESS, ...REMARKS_SHORTAGE] as const;

export type RemarkExcess = (typeof REMARKS_EXCESS)[number];
export type RemarkShortage = (typeof REMARKS_SHORTAGE)[number];
export type Remark = (typeof REMARKS_ALL)[number] | 'Paid In' | 'Paid Out';

// ── Cash-tab-only remarks — same list as above, plus Paid In/Out ──────────
export const CASH_REMARKS_EXCESS = ['Paid In', ...REMARKS_EXCESS] as const;
export const CASH_REMARKS_SHORTAGE = ['Paid Out', ...REMARKS_SHORTAGE] as const;

/** Remarks that require the Bill Number / Reason fields (Cash tab only). */
export const CASH_BILL_REMARKS = ['Paid In', 'Paid Out'] as const;

/** Remarks that pop a modal to capture supplementary details, across every context. */
export const MODAL_REMARKS = [
  'Advance Received',
  'Advance Applied',
  'Bill on Hold Cleared',
  'Extra Payment Received',
  'Short Collection',
  'Other',
] as const;

/**
 * On the UPI aggregate tab, every remark requires a 12-digit RRN except
 * these four — they represent money with no identifiable UPI transaction of
 * its own; whatever *was* actually collected reconciles through normal
 * transaction matching, not this form.
 */
export const NO_RRN_REMARKS = ['Bill on Hold Cleared', 'Advance Applied', 'Short Collection', 'Other'] as const;

/** Sources a Bills-on-Hold clearance can be attributed to when opened from the BOH tab directly. */
export const BOH_SOURCES = ['Cash', 'Static UPI', 'Pinelabs', 'MPR'] as const;

/** Net-unexplained ceiling (₹) above which a session cannot be submitted. */
export const THRESHOLD = 300;

/**
 * Amount tolerance (₹) below which two figures are treated as equal.
 * The legacy code inlined `0.5` at every comparison site; naming it keeps
 * every comparison provably consistent.
 */
export const AMOUNT_EPSILON = 0.5;

// ── Payment-name → panel routing ──────────────────────────────────────────
export const PINELABS_NAMES = ['pinelabs apos', 'manual apos', 'card/upi', 'card'];
export const SWIGGY_NAMES = ['swiggy', 'zomato'];
export const CASH_NAMES = ['cash'];
export const UPI_NAMES = ['hdfc static upi', 'kotak static upi'];
export const BILLS_NAMES = ['bills on hold', 'others'];
export const BANK_NAMES = ['bank transfer'];

/**
 * Routes a Payment Report `paymentName` to its panel.
 *
 * Match semantics differ per family and are preserved exactly as in the legacy
 * file: Pinelabs/Swiggy/Bills/Bank use substring matching, Cash and UPI require
 * an exact (lowercased, trimmed) equality. Order matters — the first family to
 * match wins.
 */
export function routePayName(pn: string | null | undefined): Tab {
  const n = (pn || '').trim().toLowerCase();
  if (PINELABS_NAMES.some((x) => n === x || n.includes(x))) return 'pinelabs';
  if (SWIGGY_NAMES.some((x) => n.includes(x))) return 'swiggy';
  if (CASH_NAMES.includes(n)) return 'cash';
  if (UPI_NAMES.includes(n)) return 'upi';
  if (BILLS_NAMES.some((x) => n.includes(x))) return 'bills';
  if (BANK_NAMES.some((x) => n.includes(x))) return 'bank';
  return 'other';
}

// ── Outlets ───────────────────────────────────────────────────────────────
export const OUTLET_NAMES: Record<OutletCode, string> = {
  BLRT: 'Toit Bengaluru',
  BAGT: 'Toit Bagmane',
  PUNT: 'Toit Pune',
};

export const OUTLET_CODES = Object.keys(OUTLET_NAMES) as OutletCode[];

/** Pinelabs terminal store names (lowercased) → outlet code. */
export const STORE_OUTLET_MAP: Record<string, OutletCode> = {
  'toit ammaeyav': 'BLRT',
  'toit- bangalore': 'BLRT',
  'toit orr east': 'BAGT',
  'toit orreast': 'BAGT',
  'toit- pune': 'PUNT',
  'toit bagmane cdukbyah': 'BAGT',
};

/** HDFC statement `City` column → outlet code. */
export const HDFC_STATEMENT_CITY_TO_OUTLET: Record<string, OutletCode> = {
  PUNE: 'PUNT',
  BANGALORE: 'BLRT',
  BENGALURU: 'BLRT',
};

/**
 * Resolves a terminal store name to an outlet code: exact match on the
 * normalised key first, then a bidirectional substring fallback.
 */
export function storeToOutlet(storeName: string | null | undefined): OutletCode | null {
  if (!storeName) return null;
  const key = storeName.trim().toLowerCase().replace(/\s+/g, ' ');
  const exact = STORE_OUTLET_MAP[key];
  if (exact) return exact;
  for (const [k, v] of Object.entries(STORE_OUTLET_MAP)) {
    if (key.includes(k) || k.includes(key)) return v;
  }
  return null;
}

/** Infers the outlet from the ZIP's store names — first resolvable one wins. */
export function detectOutletFromZip(
  zipInside: ReadonlyArray<{ store?: string }> | null | undefined,
): OutletCode | null {
  const storeNames = [...new Set((zipInside || []).map((r) => r.store).filter(Boolean))];
  for (const store of storeNames) {
    const detected = storeToOutlet(store);
    if (detected) return detected;
  }
  return null;
}

// ── Final Recon Summary method table ─────────────────────────────────────
/**
 * The FRS rows, in display order.
 *
 * `Pinelabs` is `source` because its truth is the terminal report, not the
 * drawer summary (which can itself contain clerical errors). `HDFC Static UPI`
 * is `conditional` — transaction-level when a statement is uploaded, drawer
 * otherwise. Swiggy and Zomato are POS-integrated and never block submission.
 */
export const FRS_METHODS: FrsMethod[] = [
  {
    label: 'Pinelabs',
    sourceType: 'source',
    prKeys: ['Pinelabs APOS', 'Manual APOS', 'Card/UPI'],
    sumKeys: ['Pinelabs APOS', 'Manual APOS', 'Card/UPI'],
  },
  {
    label: 'Swiggy',
    sourceType: 'drawer',
    prKeys: ['Swiggy', 'Swiggy-Online'],
    sumKeys: ['Swiggy', 'Swiggy-Online'],
    assumedReconciled: true,
    reconciledNote: 'POS integrated',
  },
  {
    label: 'Zomato',
    sourceType: 'drawer',
    prKeys: ['ZOMATO', 'Zomato-Online'],
    sumKeys: ['ZOMATO', 'Zomato-Online'],
    assumedReconciled: true,
    reconciledNote: 'POS integrated',
  },
  { label: 'Cash', sourceType: 'drawer', prKeys: ['Cash'], sumKeys: ['Cash'] },
  {
    label: 'HDFC Static UPI',
    sourceType: 'conditional',
    prKeys: ['HDFC Static UPI'],
    sumKeys: ['HDFC Static UPI'],
  },
  {
    label: 'Kotak Static UPI',
    sourceType: 'drawer',
    prKeys: ['Kotak Static UPI'],
    sumKeys: ['Kotak Static UPI'],
  },
  {
    label: 'Bills on Hold',
    sourceType: 'drawer',
    prKeys: ['Bills on Hold'],
    sumKeys: ['Bills on Hold'],
  },
  {
    label: 'Bank Transfer',
    sourceType: 'drawer',
    prKeys: ['Bank transfer'],
    sumKeys: ['Bank transfer'],
  },
  {
    label: 'Gift From Toit',
    sourceType: 'drawer',
    prKeys: ['Gift From Toit'],
    sumKeys: ['Gift From Toit'],
  },
  { label: 'Vouchers', sourceType: 'drawer', prKeys: ['VOUCHERS'], sumKeys: ['VOUCHERS'] },
];

/** Explanation categories offered in the FRS manual-explanation form. */
export const EXPLAIN_TYPES = [
  { value: '', label: 'Select type…' },
  { value: 'Advance Received', label: 'Advance Received', color: 'var(--ok)' },
  { value: 'Advance Applied', label: 'Advance Applied', color: 'var(--err)' },
  { value: 'Tips', label: 'Tips', color: 'var(--accent-t)' },
  { value: 'Manual APOS', label: 'Manual APOS', color: 'var(--pur-t)' },
  { value: 'Cash Variance', label: 'Cash Variance', color: 'var(--warn-t)' },
  { value: 'Other', label: 'Other', color: 'var(--t2)' },
] as const;
