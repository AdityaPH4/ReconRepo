/**
 * Date/RRN normalisation shared across every adapter.
 * Ported from `mpr-recon (10).html` lines 316–357, 1045–1055, 1259–1309.
 *
 * `parseTxnTimestamp`/`adjustPRDate`/`amexNormDate` build plain (host-local)
 * `Date` objects rather than going through `recon-core`'s `istDate()`. That's
 * deliberate, not an oversight: unlike the first module's business-window
 * check (which compares against an absolute boundary that must agree with
 * other `istDate()`-anchored values), everything here either (a) compares
 * two independently-parsed timestamps' *difference* against each other, or
 * (b) reads back the same local hour/day components it just wrote — both
 * are self-consistent under any host timezone as long as construction and
 * reading stay in the same "naive local" space, which they do here. No
 * value in this module is ever compared against a real UTC-anchored Date.
 */

/** Canonical `YYYY-MM-DD`, or `null` if the raw string matches none of the four bank formats. */
export function normDate(raw: unknown): string | null {
  if (!raw) return null;
  const s = String(raw).trim();

  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  const dm1 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dm1) return `${dm1[3]}-${dm1[2]!.padStart(2, '0')}-${dm1[1]!.padStart(2, '0')}`;

  const dm4 = s.match(/^(\d{1,2})-(\d{2})-(\d{2,4})$/);
  if (dm4) {
    const yr = dm4[3]!.length === 2 ? '20' + dm4[3] : dm4[3]!;
    return `${yr}-${dm4[2]!.padStart(2, '0')}-${dm4[1]!.padStart(2, '0')}`;
  }

  const MONTHS: Record<string, string> = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  };
  const dm2 = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[-\s](\d{2,4})/);
  if (dm2) {
    const yr = dm2[3]!.length === 2 ? '20' + dm2[3] : dm2[3]!;
    return `${yr}-${MONTHS[dm2[2]!.toLowerCase()] ?? '??'}-${dm2[1]!.padStart(2, '0')}`;
  }
  return null;
}

/** Coerces to a left-padded 12-digit RRN string, or `null` for blank/`nan`/`null`-ish input. */
export function normRRN(raw: unknown): string | null {
  if (raw == null || raw === '' || raw === 'nan') return null;
  let s = typeof raw === 'number' ? raw.toFixed(0) : String(raw);
  s = s.replace(/\.0+$/, '').trim();
  if (!s || s === 'nan' || s === 'null') return null;
  return s.padStart(12, '0');
}

/** Splits a (possibly multi-RRN, slash/comma/pipe/space-delimited) MPR RRN cell. Each chunk must be exactly 12 digits to count as valid. */
export function splitRRNs(raw: unknown): { valid: string[]; invalid: string[] } {
  if (!raw) return { valid: [], invalid: [] };
  const parts = String(raw)
    .split(/[/\\|,\s]+/)
    .map((s) => s.replace(/\D/g, ''));
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const p of parts) {
    if (!p) continue;
    if (p.length === 12) valid.push(p);
    else invalid.push(p);
  }
  return { valid, invalid };
}

/** `₹` + unsigned amount, en-IN grouped — display only; callers add sign/arrow where it matters. */
export function fmt(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return '₹' + Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

const MONTH_IDX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Parses `DD-Mon-YYYY HH:MM:SS` (bank/PR transaction timestamps) into a `Date`, or `null`. */
export function parseTxnTimestamp(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/);
  if (m) {
    const mon = MONTH_IDX[m[2]!.toLowerCase()];
    if (mon === undefined) return null;
    return new Date(+m[3]!, mon, +m[1]!, +m[4]!, +m[5]!, +m[6]!);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A transaction between midnight and 2am is treated as belonging to the next calendar day for UPI Pass-2 matching. */
export function adjustPRDate(dt: Date | null): Date | null {
  if (!dt) return null;
  const h = dt.getHours();
  if (h >= 0 && h < 2) {
    const adjusted = new Date(dt);
    adjusted.setDate(adjusted.getDate() + 1);
    return adjusted;
  }
  return dt;
}

/**
 * Like `normDate`, but for AMEX batch matching: a Pinelabs terminal
 * timestamp (`DD/MM/YYYY HH:MM:SS AM/PM`) in the last ten minutes of the day
 * rolls to the next calendar day, since AMEX records that batch's submission
 * date as the following day.
 */
export function amexNormDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)/i);
  if (m) {
    let h = parseInt(m[4]!, 10);
    const ap = m[6]!.toUpperCase();
    if (ap === 'PM' && h !== 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
    const mn = parseInt(m[5]!, 10);

    const d = new Date(+m[3]!, +m[2]! - 1, +m[1]!);
    if (h === 23 && mn >= 50) d.setDate(d.getDate() + 1);

    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return normDate(s);
}
