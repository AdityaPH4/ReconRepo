'use client';

/**
 * One outlet's month-at-a-glance submission calendar — green for fully
 * submitted and clean, yellow for fully submitted but flagged for review,
 * orange for partially submitted, red for missed, blue for today (nothing
 * submitted yet, but not due until end of day), blank for the future.
 * Monday-first grid. Shared by the GM dashboard (its own outlet) and the
 * admin dashboard (every outlet, one of these per card, with the outlet's
 * assigned GM email(s) shown — empty on the GM dashboard's own call).
 */

import type { OutletSubmissionsDTO, SubmissionDayStatus } from '@toit/contracts';

const DAY_TAG: Record<SubmissionDayStatus, string> = {
  green: 'tag-ok',
  yellow: 'tag-warn',
  orange: 'tag-orange',
  red: 'tag-err',
  today: 'tag-accent',
};

/** Solid fills for the legend's small dots — `tag-*`'s own pale `-soft` backgrounds read as washed-out at 8px, unlike on a full pill. */
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

export function SubmissionCalendar({ outlet }: { outlet: OutletSubmissionsDTO }) {
  const leadingBlanks = outlet.days.length > 0 ? mondayFirstWeekday(outlet.days[0]!.date) : 0;
  const doneCount = outlet.days.filter((d) => d.status === 'green' || d.status === 'yellow').length;
  const flaggedCount = outlet.days.filter((d) => d.status === 'yellow').length;
  const partialCount = outlet.days.filter((d) => d.status === 'orange').length;
  const missedCount = outlet.days.filter((d) => d.status === 'red').length;

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
          {outlet.days.map((day) => {
            const dayNum = Number(day.date.slice(-2));
            return (
              <span
                key={day.date}
                title={dayLabel(day.date, day.status)}
                className={`inline-flex items-center justify-center rounded-full text-tiny h-7 w-7 mx-auto ${
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
