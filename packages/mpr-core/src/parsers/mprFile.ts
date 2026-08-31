/**
 * MPR bank-file parsing pipeline.
 * Ported from `mpr-recon (10).html` lines 469–580 (`readXlsx`/
 * `findHeaderRowInRows`/`resolveField`), 598–810 (`normaliseRows`/
 * `parseMPRFile`).
 *
 * Legacy reads `.xlsx` through a hand-rolled JSZip+DOMParser reader because
 * the browser-bundled, minified SheetJS build failed on some real bank
 * exports' compression quirks. Parsing server-side with the actual `xlsx`
 * npm package (already used successfully in `parsers/hdfcStatement.ts`)
 * doesn't hit that quirk, so this port uses it directly for every Excel
 * format — a deliberate simplification, not a behaviour change; if a real
 * file ever fails to parse this way, a fallback reader can be added then.
 *
 * **Fix over legacy**: legacy has two divergent AMEX code paths. `.csv` and
 * `.xls` both go through the bespoke multi-table state machine
 * (`parseAmexCSV`) — correct, since AMEX's real export has a multi-section
 * structure a flat header-scan can't parse. But an `.xlsx` AMEX file only
 * discovered via content-sniffing (filename didn't match the AMEX regex)
 * falls through to the *generic* column-based batch normaliser instead,
 * whose output shape (`{settlementDate, settlementNumber, submissionAmount,
 * merchantFees, settlementAmount, dbaName}`) has no `mid`/`submissionDate`/
 * `socNumber` fields at all — exactly what `runMatch`'s AMEX matcher reads
 * to key a match. Any file that took that path would silently produce only
 * "unexpected" rows, never a real match. The port routes every AMEX file,
 * however it's detected and whatever its extension, through `parseAmexCSV`.
 */

import * as XLSX from 'xlsx';
import { ADAPTERS, detectAdapter } from '../adapters.js';
import type { AdapterDef, AdapterKey, MprRow, ParsedMprFile } from '../types.js';
import { normDate, normRRN } from '../util/normalize.js';
import { parseAmexCSV } from './amexCsv.js';

type Row = Record<string, unknown>;

/** Scans rows for the header row: `fingerprint.length` (min 3) columns present. */
function findHeaderRowInRows(rows: unknown[][], fingerprint: string[], maxScan = 25): number {
  const need = Math.min(3, fingerprint.length);
  for (let r = 0; r < Math.min(rows.length, maxScan + 1); r++) {
    const row = (rows[r] ?? []).map((v) => (v == null ? '' : String(v).trim()));
    const matches = fingerprint.filter((f) => row.some((h) => h === f || h.toLowerCase() === f.toLowerCase()));
    if (matches.length >= need) return r;
  }
  return -1;
}

/** Resolves a field's alias list to the header name actually present, or `null`. */
function resolveField(aliases: string[], headers: string[]): string | null {
  for (const alias of aliases) {
    const found = headers.find((h) => h && (h === alias || h.toLowerCase() === alias.toLowerCase()));
    if (found) return found;
  }
  return null;
}

function readSheet(buffer: Buffer, sheetName?: string): { rows: unknown[][]; sheetNames: string[] } {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheetNames = wb.SheetNames;
  const targetName =
    sheetName && sheetNames.some((n) => n.toLowerCase() === sheetName.toLowerCase())
      ? sheetNames.find((n) => n.toLowerCase() === sheetName.toLowerCase())!
      : sheetNames[0];
  if (!targetName) return { rows: [], sheetNames };
  const ws = wb.Sheets[targetName]!;
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null });
  return { rows, sheetNames };
}

/** Re-serializes a sheet's raw grid to CSV text so it can go through `parseAmexCSV`. */
function sheetToCsvText(rows: unknown[][]): string {
  return rows
    .map((row) =>
      row
        .map((v) => {
          if (v == null) return '';
          const s = String(v).trim().replace(/\.0$/, '');
          return s.includes(',') ? `"${s}"` : s;
        })
        .join(','),
    )
    .join('\n');
}

function amexResultFromText(csvText: string, filename: string): ParsedMprFile {
  const parsed = parseAmexCSV(csvText).map((r) => ({ ...r, _file: filename }));
  return { source: 'AMEX', matchStrategy: 'batch', rows: parsed, filename };
}

function amexResultFromSheet(rows: unknown[][], filename: string): ParsedMprFile {
  return amexResultFromText(sheetToCsvText(rows), filename);
}

/** Object-per-row conversion once the header row index is known. */
function toRowObjects(allRows: unknown[][], headerRowIdx: number): { headers: string[]; rows: Row[] } {
  const headers = (allRows[headerRowIdx] ?? []).map((h) => (h == null ? '' : String(h).trim()));
  const rows: Row[] = [];
  for (let i = headerRowIdx + 1; i < allRows.length; i++) {
    const raw = allRows[i] ?? [];
    const obj: Row = {};
    headers.forEach((h, ci) => {
      if (h) obj[h] = raw[ci] ?? null;
    });
    rows.push(obj);
  }
  return { headers, rows };
}

function normaliseTransactionRows(
  rows: Row[],
  headers: string[],
  adp: AdapterDef,
  key: AdapterKey,
  filename: string,
): ParsedMprFile {
  const f = adp.fields as Record<string, string[]>;
  const rrnCol = resolveField(f.rrn!, headers);
  const amtCol = resolveField(f.grossAmount!, headers);
  const netCol = resolveField(f.netAmount!, headers);
  const txnCol = resolveField(f.txnDate!, headers);
  const settleCol = resolveField(f.settlementDate!, headers);
  const feeCol = resolveField(f.fee!, headers);

  const missing: string[] = [];
  if (!rrnCol) missing.push('RRN');
  if (!amtCol) missing.push('Amount');
  if (missing.length) {
    return { source: key, rows: [], error: `Missing columns in ${filename}: ${missing.join(', ')}`, filename };
  }

  const out: MprRow[] = rows
    .map((r) => ({
      rrn: normRRN(r[rrnCol!]),
      grossAmount: parseFloat(String(r[amtCol!] ?? '')) || 0,
      netAmount: netCol ? parseFloat(String(r[netCol] ?? '')) || 0 : null,
      txnDate: normDate(r[txnCol!]),
      txnDateRaw: txnCol && r[txnCol] != null ? String(r[txnCol]).trim() : null,
      settlementDate: normDate(r[settleCol!]),
      fee: feeCol ? parseFloat(String(r[feeCol] ?? '')) || 0 : 0,
      _source: key,
      _file: filename,
    }))
    .filter((r) => r.rrn && r.grossAmount > 0);

  return { source: key, matchStrategy: 'rrn', rows: out, filename };
}

function applyFooterFilter(rows: Row[], headers: string[], adp: AdapterDef): Row[] {
  return rows.filter((r) => {
    if (adp.nullRRNMarker) {
      const firstVal = Object.values(r).find((v) => v != null);
      if (firstVal != null && String(firstVal).includes(adp.nullRRNMarker)) return false;
    }
    if (adp.nullRRNStrategy === 'skip_null') {
      const rrnCol = resolveField((adp.fields as Record<string, string[]>).rrn!, headers);
      return !!rrnCol && r[rrnCol] != null;
    }
    return true;
  });
}

/** Parses one uploaded MPR bank file. `detected` is the filename-based guess, if any. */
export function parseMprFile(filename: string, buffer: Buffer, detected: AdapterKey | null): ParsedMprFile {
  const looksLikeAmex = detected === 'AMEX' || /amex|settlements\d{8}/i.test(filename);

  // AMEX CSV is assumed for every `.csv` upload — there is no CSV path for the other three banks.
  if (filename.toLowerCase().endsWith('.csv')) {
    return amexResultFromText(buffer.toString('utf8'), filename);
  }

  if (looksLikeAmex) {
    try {
      const { rows } = readSheet(buffer);
      return amexResultFromSheet(rows, filename);
    } catch (err) {
      return { source: 'AMEX', rows: [], error: `Cannot parse ${filename}: ${(err as Error).message}`, filename };
    }
  }

  let adapterKey: AdapterKey | null = detected;
  let allRows: unknown[][];

  try {
    if (adapterKey && ADAPTERS[adapterKey]) {
      allRows = readSheet(buffer, ADAPTERS[adapterKey].sheet).rows;
    } else {
      // Unknown adapter: scan every sheet, try every adapter's fingerprint.
      const { sheetNames } = readSheet(buffer);
      let found: unknown[][] | null = null;
      for (const sName of sheetNames) {
        const sheetRows = readSheet(buffer, sName).rows;
        let matched = false;
        for (const [key, adp] of Object.entries(ADAPTERS) as [AdapterKey, AdapterDef][]) {
          if (adp.sheet && adp.sheet.toLowerCase() !== sName.toLowerCase()) continue;
          if (findHeaderRowInRows(sheetRows, adp.headerFingerprint) >= 0) {
            adapterKey = key;
            found = sheetRows;
            matched = true;
            break;
          }
        }
        if (matched) break;
        if (!found) found = sheetRows;
      }
      allRows = found ?? readSheet(buffer).rows;

      // Content-sniffing discovered AMEX (filename gave no hint) — route
      // through the same bespoke parser as every other AMEX file, not the
      // generic column normaliser (see file-level doc comment for why).
      if (adapterKey === 'AMEX') return amexResultFromSheet(allRows, filename);
    }
  } catch (err) {
    return { source: adapterKey ?? 'UNKNOWN', rows: [], error: `Cannot parse ${filename}: ${(err as Error).message}`, filename };
  }

  let resolvedKey: AdapterKey | null = adapterKey;
  if (!resolvedKey) {
    for (const [key, adp] of Object.entries(ADAPTERS) as [AdapterKey, AdapterDef][]) {
      if (findHeaderRowInRows(allRows, adp.headerFingerprint) >= 0) {
        resolvedKey = key;
        break;
      }
    }
    if (!resolvedKey) return { source: 'UNKNOWN', rows: [], error: `Could not detect format for ${filename}`, filename };
  }

  const adp = ADAPTERS[resolvedKey];
  const headerRowIdx = adp.headerRow !== undefined ? adp.headerRow : findHeaderRowInRows(allRows, adp.headerFingerprint);
  if (headerRowIdx < 0) return { source: resolvedKey, rows: [], error: `Header not found in ${filename}`, filename };

  const { headers, rows } = toRowObjects(allRows, headerRowIdx);
  const filtered = applyFooterFilter(rows, headers, adp);

  return normaliseTransactionRows(filtered, headers, adp, resolvedKey, filename);
}

export { detectAdapter };
