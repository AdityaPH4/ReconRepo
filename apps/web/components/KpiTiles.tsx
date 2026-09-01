'use client';

/**
 * Clickable KPI tiles.
 * Ported from `reconciliation (68).html` lines 1289–1425 (`renderSummaryTiles`,
 * `makeTile`).
 *
 * As in the legacy tool, the tiles *are* the navigation — there is no tab bar
 * for the panels; clicking a tile reveals its panel below.
 *
 * Colouring is legacy's own three-way scheme, not a plain ok/err binary:
 * **excess is always green, shortage is always red, and a truly balanced or
 * fully-explained tile is neutral** (`makeTile`'s `isExcess ? green :
 * needsAction ? red : black`, lines 1373–1374) — an unusually large excess
 * still reads as good news, never alarming.
 *
 * Legacy has two independently-computed formulas for "is this source ok" —
 * the tile-stat one here (`cashStat`/`bankStat`/`upiStat`, 1300–1332) and a
 * second, subtly different one gating the submit button in `renderFRS`
 * (3729–3767, `cashOk`/`bankOk`/`upiOk`). Rather than reproduce that drift,
 * this reuses the exact same canonical `cashOk`/`bankOk`/`upiOk`/
 * `hdfcUpiCompleteness`/`entryNet` recon-core already computes for the real
 * submit gate — consistent with the "one canonical calculation" fix the
 * justification layer already made (see README).
 */

import type { SessionDTO } from '@toit/contracts';
import { bankOk, cashOk, fmt, hdfcUpiCompleteness, pinelabsCompleteness, upiOk } from '@toit/recon-core/display';

export type PanelId = 'pinelabs' | 'swiggy' | 'cash' | 'upi' | 'bills' | 'bank' | 'advances';

/** `ok` = neutral/no action needed, `err` = shortage (red), `excess` = excess (green, never alarming). */
type Stat = 'ok' | 'err' | 'excess' | 'neutral';

interface Tile {
  id: PanelId;
  label: string;
  main: string;
  note: string;
  stat: Stat;
}

interface Props {
  session: SessionDTO;
  active: PanelId;
  onSelect: (id: PanelId) => void;
}

const STAT_CLASS: Record<Stat, string> = {
  ok: 'kpi-value',
  neutral: 'kpi-value',
  err: 'kpi-value kpi-value-err',
  excess: 'kpi-value kpi-value-ok',
};

export function KpiTiles({ session, active, onSelect }: Props) {
  const tiles = buildTiles(session);

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

/** `fmt(|diff|) + ' excess'/' shortage'`, or `'Balanced'` within tolerance — legacy's exact tile-text formula. */
function diffLabel(diff: number, hasSummary: boolean): string {
  if (!hasSummary) return 'No summary';
  if (Math.abs(diff) < 0.5) return 'Balanced';
  return `${fmt(Math.abs(diff))} ${diff > 0 ? 'excess' : 'shortage'}`;
}

/** `ok` → neutral; otherwise the raw diff's sign decides shortage(red)/excess(green) — legacy never colors an excess red, however large. */
function directionalStat(ok: boolean, diff: number): Stat {
  if (ok) return 'ok';
  return diff < 0 ? 'err' : 'excess';
}

function buildTiles(session: SessionDTO): Tile[] {
  const { counts, totals, justification, result, summaryData } = session;
  const hasSummary = summaryData !== null;
  const entries = justification.entries;

  // ── Pinelabs ──────────────────────────────────────────────────────────
  // `counts.pinelabs.*` are structural row counts fixed at upload time — they
  // never shrink as remarks/square-offs resolve rows, so the tile would keep
  // showing the original total forever. `pinelabsCompleteness`'s
  // `unresolvedCount` is the same live, entries-aware count the submit gate
  // itself uses (see `canSubmit`'s `plOk`), so the tile now tracks it too.
  const plCompleteness = pinelabsCompleteness(result.pinelabs as never, entries, justification.squareOff);
  const plOutstanding = plCompleteness.unresolvedCount;
  const plRecTotal = counts.pinelabs.reconciled;

  // ── Cash ──────────────────────────────────────────────────────────────
  const cashDiff = totals.cash.diff ?? 0;
  const cashResolved = cashOk(cashDiff, entries);

  // ── Static UPI (HDFC txn-level completeness + Kotak aggregate) ─────────
  const hdfcCompleteness = hdfcUpiCompleteness(result.upiHdfc as never, entries, justification.squareOff);
  const hdfcAggregateDiff = totals.hdfcUpi.diff ?? 0;
  const kotakDiff = totals.kotakUpi.diff ?? 0;
  const upiDiff = (hdfcCompleteness ? hdfcCompleteness.netDiff : hdfcAggregateDiff) + kotakDiff;
  const upiResolved = upiOk({ hasSummary, hdfcCompleteness, hdfcAggregateDiff, kotakDiff, entries });

  // ── Bank ──────────────────────────────────────────────────────────────
  const bankDiff = totals.bank.diff ?? 0;
  const bankResolved = bankOk(hasSummary, bankDiff, entries);

  return [
    {
      id: 'pinelabs',
      label: 'Pinelabs',
      main: plOutstanding > 0 ? `${plOutstanding} need remarks` : 'All reconciled',
      note: plOutstanding > 0 ? `${plRecTotal} matched already` : `${plRecTotal} transactions`,
      stat: plOutstanding > 0 ? 'err' : 'ok',
    },
    {
      id: 'cash',
      label: 'Cash',
      main: diffLabel(cashDiff, hasSummary),
      note: `${result.cash.length} PR transactions`,
      stat: directionalStat(cashResolved, cashDiff),
    },
    {
      id: 'upi',
      label: 'HDFC / Kotak UPI',
      main: diffLabel(upiDiff, hasSummary),
      note: `${result.upi.length} PR rows`,
      stat: directionalStat(upiResolved, upiDiff),
    },
    {
      id: 'bank',
      label: 'Bank Transfer',
      main: diffLabel(bankDiff, hasSummary),
      note: `${result.bank.length} PR rows`,
      stat: directionalStat(bankResolved, bankDiff),
    },
    {
      id: 'swiggy',
      label: 'Swiggy / Zomato',
      main: `${result.swiggy.length} transactions`,
      note: fmt(totals.swiggy.prTotal),
      stat: 'neutral',
    },
    {
      id: 'bills',
      label: 'Bills on Hold',
      main: `${counts.bills} today`,
      note: fmt(totals.bills.prTotal),
      stat: 'neutral',
    },
    {
      id: 'advances',
      label: 'Advances',
      main: String(justification.draftAdvances.length),
      note: `${justification.draftApplications.length} applied this session`,
      stat: 'neutral',
    },
  ];
}
