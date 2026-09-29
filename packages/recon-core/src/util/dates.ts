/**
 * Date parsing, the business window, and display formatting.
 * Ported from `reconciliation (68).html` lines 741–762, 767–808, 863–869.
 *
 * ── Why this file is not a straight copy ──────────────────────────────────
 * The legacy code ran in a browser on an IST machine, so every
 * `new Date(y, m, d, h, ...)` was implicitly Asia/Kolkata. Running the same
 * expression in a Node process (usually UTC) shifts every timestamp — and
 * therefore the 08:00→07:00 business window — by 5h30m, silently including or
 * excluding real transactions at the window edges.
 *
 * So all wall-clock construction goes through `istDate()` and all formatting
 * pins `timeZone: 'Asia/Kolkata'`. The observable behaviour matches the legacy
 * app as it actually ran; it is now independent of server timezone.
 */

import type { BusinessWindow, CivilDate } from '../types.js';

/** IST is UTC+05:30 year-round — India observes no daylight saving. */
const IST_OFFSET_MINUTES = 330;

export const IST_TIMEZONE = 'Asia/Kolkata';

/**
 * Builds the `Date` for an IST wall-clock reading.
 *
 * `istDate(2026, 7, 1, 8, 0, 0)` is 08:00 on 1 Aug 2026 in Bengaluru,
 * regardless of the host machine's timezone.
 */
export function istDate(
  y: number,
  monthIndex: number,
  d: number,
  h = 0,
  min = 0,
  s = 0,
): Date {
  return new Date(Date.UTC(y, monthIndex, d, h, min, s) - IST_OFFSET_MINUTES * 60_000);
}

/** Month abbreviation → month index. Lookup is case-insensitive; see `parsePRDate`. */
const MON: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Month index → zero-padded month number, for `fmtDate`. */
const MON_NUM = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];

/**
 * Parses the business date from a Payment Report date cell. Two confirmed
 * real export shapes:
 *  - `dd-Mon-yyyy`, optionally followed by a time (the original, most common
 *    shape this was built against) — e.g. `23-Sep-2026 20:14:03`.
 *  - `M/D/yyyy H:MM`, no leading zeros, no seconds, 24-hour — e.g.
 *    `9/23/2026 0:04`. Confirmed against a real Toit Bagmane export whose
 *    "Transaction Date" column uses this instead, unlike every other sample
 *    seen so far. Assumed month-first (US order): unambiguous whenever
 *    either half is >12, which every real row of this shape seen so far is;
 *    a file where every single transaction happens on a day-of-month <=12
 *    would be genuinely ambiguous, but there's no way to tell from the
 *    string alone, and no such file has actually shown up yet.
 *
 * Note: the legacy lookup was case-sensitive with an `?? 0` fallback, so a
 * cell reading `01-AUG-2026` would have resolved to *January*. The lookup here
 * is case-insensitive and returns `null` on an unknown month rather than
 * defaulting to January. For the documented `01-Aug-2026` casing the result is
 * identical; for other casings it is correct instead of silently wrong.
 */
export function parsePRDate(s: string | null | undefined): CivilDate | null {
  if (!s) return null;
  const str = String(s);

  const dashForm = str.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (dashForm) {
    const monthIndex = MON[dashForm[2]!.toLowerCase()];
    if (monthIndex === undefined) return null;
    return { y: +dashForm[3]!, m: monthIndex, d: +dashForm[1]! };
  }

  const slashForm = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (slashForm) {
    const month = +slashForm[1]!;
    const day = +slashForm[2]!;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { y: +slashForm[3]!, m: month - 1, d: day };
  }

  return null;
}

/**
 * Parses a Pinelabs ZIP timestamp: `dd/mm/yyyy hh:mm:ss AM/PM`, read as IST.
 * Returns `null` when the format does not match exactly — the legacy code
 * treats an unparseable timestamp as "no date", not as epoch zero.
 */
export function parseZipDT(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = String(s)
    .trim()
    .match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(AM|PM)$/i);
  if (!m) return null;
  const [, d, mo, yr, hhRaw, mm, ss, ap] = m;
  let hh = +hhRaw!;
  const meridiem = ap!.toUpperCase();
  if (meridiem === 'PM' && hh !== 12) hh += 12;
  if (meridiem === 'AM' && hh === 12) hh = 0;
  return istDate(+yr!, +mo! - 1, +d!, hh, +mm!, +ss!);
}

/**
 * Parses an HDFC statement timestamp: date as `YYYY-MM-DD`, time as
 * `H:MM:SS AM/PM`, read as IST.
 */
export function parseHDFCTime12h(
  dateStr: string | null | undefined,
  timeStr: string | null | undefined,
): Date | null {
  const dm = String(dateStr || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const tm = String(timeStr || '').trim().match(/^(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i);
  if (!dm || !tm) return null;
  let h = parseInt(tm[1]!, 10);
  const ap = tm[4]!.toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return istDate(+dm[1]!, +dm[2]! - 1, +dm[3]!, h, +tm[2]!, +tm[3]!);
}

/**
 * The business-date window: 08:00 IST on the business date through
 * 07:00 IST the next morning.
 *
 * The end is 07:00 rather than 02:00 because on special occasions (e.g. late
 * football screenings) outlets can trade until around 06:00, and those
 * transactions belong to the previous business date.
 */
export function buildWin(bd: CivilDate): BusinessWindow {
  return {
    start: istDate(bd.y, bd.m, bd.d, 8, 0, 0),
    end: istDate(bd.y, bd.m, bd.d + 1, 7, 0, 0),
  };
}

/** Inclusive window test. A null date is never in window. */
export function inWin(dt: Date | null | undefined, w: BusinessWindow): boolean {
  return !!dt && dt >= w.start && dt <= w.end;
}

/** Human-readable window label, e.g. `01 Aug, 08:00 AM – 02 Aug, 07:00 AM`. */
export function fmtWin(w: BusinessWindow): string {
  const o: Intl.DateTimeFormatOptions = {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: IST_TIMEZONE,
  };
  return (
    w.start.toLocaleString('en-IN', o) + ' – ' + w.end.toLocaleString('en-IN', o)
  );
}

/** A `CivilDate` as `YYYY-MM-DD` — the business-date key used for storage. */
export function civilToISO(bd: CivilDate): string {
  return `${bd.y}-${String(bd.m + 1).padStart(2, '0')}-${String(bd.d).padStart(2, '0')}`;
}

/**
 * Inverse of `civilToISO` — `yyyy-mm-dd` → `CivilDate`, or `null` if not
 * that exact shape or the month/day is out of range. Used only for a
 * manually entered business-date fallback (a zero-transaction Payment
 * Report has no date of its own to read) — a real file's own date always
 * comes from `parsePRDate`, never this.
 */
export function isoToCivil(iso: string): CivilDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const y = +m[1]!;
  const mo = +m[2]!;
  const d = +m[3]!;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo - 1, d };
}

/**
 * "Today" as `yyyy-mm-dd`, read in IST — not `new Date().toISOString().slice(0, 10)`,
 * which is always UTC and so is a full calendar day *behind* the true IST date
 * for 5h30m every night (UTC 18:30–23:59 = IST 00:00–05:29, already tomorrow
 * in IST but still "today" by a naive UTC slice). The same "why this file is
 * not a straight copy" concern as everywhere else here, just for "what day is
 * it" instead of a parsed timestamp — every caller that means "today's
 * business date" should use this, not a raw UTC slice.
 */
export function todayIsoIST(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: IST_TIMEZONE }).format(now);
}

/** A `CivilDate` as `dd MMM yyyy`, for the header line. */
export function fmtCivil(bd: CivilDate): string {
  return istDate(bd.y, bd.m, bd.d, 12).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: IST_TIMEZONE,
  });
}

/**
 * Normalises any of three source date formats to `dd/mm/yy hh:mm:ss AM/PM`
 * for display. Handles the ZIP format (already 12-hour), the PR format
 * (24-hour, `dd-Mon-yyyy`), and the alternate PR format (24-hour,
 * `M/D/yyyy H:MM`, no leading zeros or seconds — see `parsePRDate`'s own doc
 * comment for where this was confirmed); anything else is returned unchanged.
 */
export function fmtDate(raw: string | null | undefined): string {
  if (!raw) return '—';
  const s = String(raw).trim();

  // ZIP: dd/mm/yyyy hh:mm:ss AM/PM
  const m1 = s.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(AM|PM)$/i);
  if (m1) {
    const [, d, mo, yr, hh, mm, ss, ap] = m1;
    return `${d}/${mo}/${yr!.slice(2)} ${hh!.padStart(2, '0')}:${mm}:${ss} ${ap!.toUpperCase()}`;
  }

  // PR: dd-Mon-yyyy hh:mm:ss (24-hour)
  const m2 = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (m2) {
    const [, d, mo, yr, hh, mm, ss] = m2;
    const monthIndex = MON[mo!.toLowerCase()];
    const moNum = monthIndex === undefined ? '??' : MON_NUM[monthIndex]!;
    let h = parseInt(hh!, 10);
    const ap = h >= 12 ? 'PM' : 'AM';
    if (h === 0) h = 12;
    else if (h > 12) h -= 12;
    return `${d!.padStart(2, '0')}/${moNum}/${yr!.slice(2)} ${String(h).padStart(2, '0')}:${mm}:${ss} ${ap}`;
  }

  // PR (alternate export): M/D/yyyy H:MM (24-hour, no seconds)
  const m3 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (m3) {
    const [, mo, d, yr, hh, mm] = m3;
    let h = parseInt(hh!, 10);
    const ap = h >= 12 ? 'PM' : 'AM';
    if (h === 0) h = 12;
    else if (h > 12) h -= 12;
    return `${d!.padStart(2, '0')}/${mo!.padStart(2, '0')}/${yr!.slice(2)} ${String(h).padStart(2, '0')}:${mm}:00 ${ap}`;
  }

  return s;
}

/** Converts an `<input type="date">` value (`yyyy-mm-dd`) to `dd/mm/yyyy`. */
export function fmtEventDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const m = String(iso).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(iso);
  return `${m[3]}/${m[2]}/${m[1]}`;
}
