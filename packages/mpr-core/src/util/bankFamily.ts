/**
 * Which bank's tile a settlement-ledger row belongs to, by its `acquirer`.
 * One definition shared by the API (counting the saved JSON's rows) and the
 * dashboard (counting the tiles' rows), so the two can never disagree about
 * grouping. Anything Kotak/HDFC/AMEX don't acquire settles through Pinelabs.
 */

export type BankFamily = 'amex' | 'kotak' | 'pinelabs' | 'hdfc_upi' | 'hdfc_dynamic' | 'hdfc_link';

export function bankFamily(acquirer: string | null | undefined): BankFamily {
  if (acquirer === 'AMEX') return 'amex';
  if (/^KOTAK/i.test(acquirer ?? '')) return 'kotak';
  if (acquirer === 'HDFC UPI') return 'hdfc_upi';
  if (acquirer === 'HDFC') return 'hdfc_dynamic';
  if (acquirer === 'HDFC_LINK') return 'hdfc_link';
  return 'pinelabs';
}
