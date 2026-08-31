import type { DirectionDTO, JustificationSourceDTO, SessionDTO } from '@toit/contracts';

/** The six remarks that pop a modal to capture supplementary details, everywhere they appear. */
export type ModalKind =
  | 'advance-received'
  | 'advance-applied'
  | 'boh-clear'
  | 'boh-add'
  | 'epr'
  | 'other'
  | 'short-collection';

/**
 * What a modal needs to know regardless of where it was opened from — a
 * Pinelabs/HDFC-UPI row remark, or a Cash/UPI/Bank aggregate-tab form.
 */
export interface ModalRequest {
  kind: ModalKind;
  source: JustificationSourceDTO;
  /** The row this modal is attached to, or `null` for an aggregate-tab entry. */
  targetKey: string | null;
  /** The row's own `|diff|`, or the amount already entered on an aggregate form. */
  amount: number;
  direction: DirectionDTO;
  /** `boh-clear` only — locks the source field when opened from a row/tab rather than the BOH tab itself. */
  lockedSource?: string;
  /**
   * The UPI aggregate tab's 12-digit RRN, already validated (format +
   * session-uniqueness) before the modal opened — legacy captures this on
   * the form itself and carries it into whichever modal handles the rest of
   * the entry, since "Advance Received"/"Extra Payment Received" on the UPI
   * tab represent a real, identifiable transaction the RRN traces back to.
   */
  rrn?: string | null;
  /** `boh-add` only — the underlying Bills-on-Hold PR row this stages a repository entry for. */
  bohRow?: { orderNo: string; custName: string; amount: number; bohDate: string };
}

/** Shared props every modal component takes. */
export interface ModalProps {
  session: SessionDTO;
  request: ModalRequest;
  onClose: () => void;
  onSaved: (session: SessionDTO) => void;
}

export function modalKindForRemark(remark: string): ModalKind | null {
  switch (remark) {
    case 'Advance Received':
      return 'advance-received';
    case 'Advance Applied':
      return 'advance-applied';
    case 'Bill on Hold Cleared':
      return 'boh-clear';
    case 'Extra Payment Received':
      return 'epr';
    case 'Short Collection':
      return 'short-collection';
    case 'Other':
      return 'other';
    default:
      return null;
  }
}
