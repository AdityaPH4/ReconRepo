'use client';

/**
 * Clickable KPI tiles.
 * Ported from `reconciliation (68).html` lines 1289–1425 (`renderSummaryTiles`,
 * `makeTile`).
 *
 * As in the legacy tool, the tiles *are* the navigation — there is no tab bar
 * for the panels; clicking a tile reveals its panel below.
 */

import type { PanelSummariesDTO, ReconCountsDTO } from '@toit/contracts';
import { fmt } from '@toit/recon-core/display';

export type PanelId = 'pinelabs' | 'swiggy' | 'cash' | 'upi' | 'bills' | 'bank';

/** `ok` = nothing outstanding, `err` = needs attention, `neutral` = FYI only. */
type Stat = 'ok' | 'err' | 'neutral';

interface Tile {
  id: PanelId;
  label: string;
  main: string;
  note: string;
  stat: Stat;
}

interface Props {
  counts: ReconCountsDTO;
  totals: PanelSummariesDTO;
  active: PanelId;
  onSelect: (id: PanelId) => void;
}

const STAT_CLASS: Record<Stat, string> = {
  ok: 'kpi-value kpi-value-ok',
  err: 'kpi-value kpi-value-err',
  neutral: 'kpi-value',
};

export function KpiTiles({ counts, totals, active, onSelect }: Props) {
  const tiles = buildTiles(counts, totals);

  return (
    <div className="kpi-grid">
      {tiles.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`kpi${active === t.id ? ' kpi-active' : ''}`}
          aria-pressed={active === t.id}
          onClick={() => onSelect(t.id)}
        >
          <span className="kpi-label">{t.label}</span>
          <span className={STAT_CLASS[t.stat]}>{t.main}</span>
          <span className="kpi-note">{t.note}</span>
        </button>
      ))}
    </div>
  );
}

function buildTiles(counts: ReconCountsDTO, totals: PanelSummariesDTO): Tile[] {
  // Everything on the Pinelabs panel that still needs a human decision.
  const plOutstanding =
    counts.pinelabs.unreconciled +
    counts.pinelabs.onlyPOS +
    counts.pinelabs.onlyTerm +
    counts.pinelabs.dupRRN +
    counts.pinelabs.amexDup +
    counts.pinelabs.amexDupTerm;

  const upiOutstanding = counts.upiHdfc
    ? counts.upiHdfc.unreconciled + counts.upiHdfc.onlyPOS + counts.upiHdfc.onlyTerm
    : null;

  const upiAggregateDiff = sumDiffs(totals.hdfcUpi.diff, totals.kotakUpi.diff);

  return [
    {
      id: 'pinelabs',
      label: 'Pinelabs',
      main: String(plOutstanding),
      note:
        plOutstanding === 0
          ? `${counts.pinelabs.reconciled} reconciled`
          : `${counts.pinelabs.reconciled} reconciled · needs review`,
      stat: plOutstanding === 0 ? 'ok' : 'err',
    },
    {
      id: 'cash',
      label: 'Cash',
      main: fmt(totals.cash.diff),
      note: `POS ${fmt(totals.cash.prTotal)}`,
      stat: diffStat(totals.cash.diff),
    },
    {
      id: 'upi',
      label: 'Static UPI',
      main: upiOutstanding === null ? fmt(upiAggregateDiff) : String(upiOutstanding),
      note:
        upiOutstanding === null
          ? 'aggregate flow'
          : `${counts.upiHdfc!.reconciled} matched · txn level`,
      stat:
        upiOutstanding === null
          ? diffStat(upiAggregateDiff)
          : upiOutstanding === 0
            ? 'ok'
            : 'err',
    },
    {
      id: 'bank',
      label: 'Bank transfer',
      main: fmt(totals.bank.diff),
      note: `POS ${fmt(totals.bank.prTotal)}`,
      stat: diffStat(totals.bank.diff),
    },
    {
      id: 'bills',
      label: 'Bills on hold',
      main: String(counts.bills),
      note: fmt(totals.bills.prTotal),
      stat: 'neutral',
    },
    {
      id: 'swiggy',
      label: 'Swiggy / Zomato',
      main: String(counts.swiggy),
      note: fmt(totals.swiggy.prTotal),
      stat: 'neutral',
    },
  ];
}

/** A null diff means no drawer figure existed to compare against. */
function diffStat(diff: number | null): Stat {
  if (diff === null) return 'neutral';
  return Math.abs(diff) < 0.5 ? 'ok' : 'err';
}

function sumDiffs(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}
