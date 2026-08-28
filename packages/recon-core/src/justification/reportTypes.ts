/**
 * A `recon-core`-local mirror of `@toit/contracts`' `FrsRowDTO` shape.
 *
 * `recon-core` never imports from `contracts` (the dependency direction is
 * one-way: `contracts` → `recon-core`, see README), but `buildSnapshot` needs
 * the FRS row shape the API already computes via `frsRowAmounts` to build the
 * snapshot's method breakdown. Keeping this shape identical to `FrsRowDTO`
 * means the API can pass `session.frs.rows` straight through with no mapping.
 */
export interface FrsRowDTOLike {
  label: string;
  pr: number;
  drawerAmt: number | null;
  sourceAmt: number | null;
  diff: number;
  usingSource: boolean;
  basis: 'source_report' | 'drawer_summary';
  assumedReconciled: boolean;
  reconciledNote: string | null;
}
