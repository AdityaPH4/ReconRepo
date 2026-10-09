'use client';

/**
 * One outlet's month-at-a-glance submission calendar — green for fully
 * submitted and clean, yellow for fully submitted but flagged for review,
 * orange for partially submitted, red for missed, blue for today (nothing
 * submitted yet, but not due until end of day), blank for the future.
 * Monday-first grid. Shared by the GM dashboard (its own outlet) and the
 * admin dashboard (every outlet, one of these per card, with the outlet's
 * assigned GM email(s) shown — empty on the GM dashboard's own call).
 *
 * Defaults to the current month; a left arrow next to the month label steps
 * back to the previous one (the only other month the API sends — see
 * `OutletSubmissionsDTO.previousMonth`/`previousMonthDays`), and a right
 * arrow appears to step back to the current month. No further history is
 * fetched or shown — exactly these two months.
 */

import { useState } from 'react';
import type { OutletSubmissionsDTO, SubmissionDayStatus } from '@toit/contracts';

/**
 * A tinted fill (the solid color at partial opacity, over the panel's own
 * white background) with its matching dark `-ink` text — the original pale
 * `tag-*-soft` background read as washed-out at this size, but the full
 * solid fill (an earlier pass at this) read as too flashy across a whole
 * month grid. This is the middle ground.
 */
const DAY_TAG: Record<SubmissionDayStatus, string> = {
  green: 'bg-ok/35 text-ok-ink',
  yellow: 'bg-warn/35 text-warn-ink',
  orange: 'bg-orange/35 text-orange-ink',
  red: 'bg-err/35 text-err-ink',
  today: 'bg-accent/35 text-accent-ink',
};

const LEGEND_DOT: Record<SubmissionDayStatus, string> = {
  green: 'bg-ok',
  yellow: 'bg-warn',
  orange: 'bg-orange',
  red: 'bg-err',
  today: 'bg-accent',
};

const STATUS_LABEL: Record<SubmissionDayStatus, string> = {
  green: 'Submitted — clean',
  yellow: 'Submitted — flagged for review',
  orange: 'Partially submitted',
  red: 'Missed',
  today: 'Today',
};

const LEGEND: Array<{ status: SubmissionDayStatus; label: string }> = [
  { status: 'green', label: 'Clean' },
  { status: 'yellow', label: 'Flagged' },
  { status: 'orange', label: 'Partial' },
  { status: 'red', label: 'Missed' },
  { status: 'today', label: 'Today' },
];

/** Monday=0 … Sunday=6, so the grid lines up under Mon-first weekday headers. */
function mondayFirstWeekday(iso: string): number {
  const jsDay = new Date(`${iso}T00:00:00Z`).getUTCDay(); // Sun=0 … Sat=6
  return (jsDay + 6) % 7;
}

function dayLabel(iso: string, status: SubmissionDayStatus | null): string {
  const d = new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  return status ? `${d} — ${STATUS_LABEL[status]}` : d;
}

/** `yyyy-mm` → "October 2026". */
function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function SubmissionCalendar({ outlet }: { outlet: OutletSubmissionsDTO }) {
  const [showPrevious, setShowPrevious] = useState(false);
  const activeMonth = showPrevious ? outlet.previousMonth : outlet.month;
  const activeDays = showPrevious ? outlet.previousMonthDays : outlet.days;

  const leadingBlanks = activeDays.length > 0 ? mondayFirstWeekday(activeDays[0]!.date) : 0;
  const doneCount = activeDays.filter((d) => d.status === 'green' || d.status === 'yellow').length;
  const flaggedCount = activeDays.filter((d) => d.status === 'yellow').length;
  const partialCount = activeDays.filter((d) => d.status === 'orange').length;
  const missedCount = activeDays.filter((d) => d.status === 'red').length;

  return (
    <div className="panel">
      <div className="panel-header">
        <div className="panel-header-left">
          <div className="panel-icon">📅</div>
          <div>
            <p className="panel-title">{outlet.outletName}</p>
            <p className="panel-subtitle">
              {doneCount} submitted
              {flaggedCount > 0 ? (
                <>
                  {', '}
                  <span className="text-warn-ink font-semibold">{flaggedCount} flagged</span>
                </>
              ) : (
                ''
              )}
              {partialCount > 0 ? (
                <>
                  {', '}
                  <span className="text-orange-ink font-semibold">{partialCount} partial</span>
                </>
              ) : (
                ''
              )}
              {missedCount > 0 ? (
                <>
                  {', '}
                  <span className="text-err-ink font-semibold">{missedCount} missed</span>
                </>
              ) : (
                ''
              )}
            </p>
            {outlet.assignedGms.length > 0 && (
              <p className="text-tiny text-ink-3 mt-0.5">Assigned: {outlet.assignedGms.join(', ')}</p>
            )}
          </div>
        </div>
      </div>
      <div className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <button
            type="button"
            className="btn btn-sm"
            aria-label="Previous month"
            onClick={() => setShowPrevious(true)}
            disabled={showPrevious}
          >
            ◀
          </button>
          <span className="font-semibold text-body min-w-36 text-center">{monthLabel(activeMonth)}</span>
          <button
            type="button"
            className="btn btn-sm"
            aria-label="Current month"
            onClick={() => setShowPrevious(false)}
            disabled={!showPrevious}
          >
            ▶
          </button>
        </div>
        <div className="flex items-center gap-3 mb-3 text-tiny text-ink-3">
          {LEGEND.map(({ status, label }) => (
            <span key={status} className="inline-flex items-center gap-1">
              <span className={`inline-block w-2 h-2 rounded-full ${LEGEND_DOT[status]}`} />
              {label}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1.5 text-center text-tiny text-ink-3 mb-1.5">
          {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
            <span key={i}>{d}</span>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1.5">
          {Array.from({ length: leadingBlanks }).map((_, i) => (
            <span key={`blank-${i}`} />
          ))}
          {activeDays.map((day) => {
            const dayNum = Number(day.date.slice(-2));
            return (
              <span
                key={day.date}
                title={dayLabel(day.date, day.status)}
                className={`inline-flex items-center justify-center rounded-full text-tiny font-semibold h-7 w-7 mx-auto ${
                  day.status ? DAY_TAG[day.status] : 'text-ink-3'
                }`}
              >
                {dayNum}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
