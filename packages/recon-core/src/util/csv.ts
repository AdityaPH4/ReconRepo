/**
 * CSV parsing and header-column resolution.
 * Ported from `reconciliation (68).html` lines 721–737, plus the inline
 * `col()` helpers that appeared in each reader.
 */

/**
 * Parses CSV text into a row/cell matrix.
 *
 * Handles quoted fields containing commas, newlines and escaped (`""`) quotes.
 * A hand-rolled parser is kept rather than a library because the POS exports
 * are already known to round-trip through it correctly, and swapping in
 * different quote/newline edge-case handling mid-port would be an unverifiable
 * behaviour change.
 */
export function parseCSV(txt: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQ = false;

  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    const n = txt[i + 1];
    if (c === '"') {
      if (inQ && n === '"') {
        cur += '"';
        i++; // escaped quote
      } else {
        inQ = !inQ;
      }
    } else if (c === ',' && !inQ) {
      row.push(cur);
      cur = '';
    } else if ((c === '\n' || (c === '\r' && n === '\n')) && !inQ) {
      if (c === '\r') i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

/**
 * Builds column-index lookups over a header row.
 *
 * Headers are lowercased and trimmed once. `loose` matches any header
 * *containing* the key (how the legacy readers resolved most columns);
 * `exact` requires full equality.
 */
export function headerIndex(headerRow: readonly string[]) {
  const h = headerRow.map((x) => (x || '').trim().toLowerCase());
  return {
    headers: h,
    /** First header containing `k`, or -1. */
    loose(k: string): number {
      const key = k.toLowerCase();
      return h.findIndex((x) => x.includes(key));
    },
    /** First header exactly equal to `k`, or -1. */
    exact(k: string): number {
      const key = k.toLowerCase();
      return h.findIndex((x) => x === key);
    },
    /** Exact match preferred, falling back to a containment match. */
    preferExact(k: string): number {
      const key = k.toLowerCase();
      const e = h.findIndex((x) => x === key);
      return e !== -1 ? e : h.findIndex((x) => x.includes(key));
    },
  };
}

/** Reads a cell by column index, trimmed; safe against short rows and -1. */
export function cell(row: readonly string[] | undefined, idx: number): string {
  if (!row || idx < 0) return '';
  return (row[idx] ?? '').trim();
}
