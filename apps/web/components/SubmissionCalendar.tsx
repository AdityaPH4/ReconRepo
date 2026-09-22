'use client';

/**
 * One outlet's month-at-a-glance submission calendar — green for a
 * submitted day, red for missed, blue for today, blank for the future.
 * Monday-first grid. Shared by the GM dashboard (its own outlet) and the
 * admin dashboard (every outlet, one of these per card).
 */

import type { OutletSubmissionsDTO, SubmissionDayStatus } from '@toit/contracts';

const DAY_TAG: Record<SubmissionDayStatus, string> = {
  done: 'tag-ok',
  missed: 'tag-err',
  today: 'tag-accent',
};

/** Monday=0 … Sunday=6, so the grid lines up under Mon-first weekday headers. */
function mondayFirstWeekday(iso: string): number {
  const jsDay = new Date(`${iso}T00:00:00Z`).getUTCDay(); // Sun=0 … Sat=6
  return (jsDay + 6) % 7;
}

export function SubmissionCalendar({ outlet }: { outlet: OutletSubmissionsDTO }) {
  const leadingBlanks = outlet.days.length > 0 ? mondayFirstWeekday(outlet.days[0]!.date) : 0;
  const doneCount = outlet.days.filter((d) => d.status === 'done').length;
  const missedCount = outlet.days.filter((d) => d.status === 'missed').length;

  return (
    <div className="panel">
      <div className="panel-header">
        <div className="panel-header-left">
          <div className="panel-icon">📅</div>
          <div>
            <p className="panel-title">{outlet.outletName}</p>
            <p className="panel-subtitle">
              {doneCount} submitted{missedCount > 0 ? `, ${missedCount} missed` : ''}
            </p>
          </div>
        </div>
      </div>
      <div className="p-4">
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
                title={day.date}
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
