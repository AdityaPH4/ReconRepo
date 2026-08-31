/**
 * MPR (Layer 2) reconciliation orchestration — the server-side equivalent of
 * legacy `runReconciliation` (`mpr-recon (10).html` lines 815–860).
 *
 * Merges every uploaded Layer-1 JSON snapshot's settlement ledger (tagged
 * with which business date it came from), parses every uploaded bank MPR
 * file, and runs the matcher. Legacy's sole validation for a JSON upload is
 * "does it have a `settlementLedger` key at all" — preserved as-is.
 */

import { detectAdapter, parseMprFile, runMatch } from '@toit/mpr-core';
import type {
  MatchInput,
  MatchResult,
  TaggedLedgerRow,
  TaggedUpiJustification,
  TaggedUpiTransaction,
} from '@toit/mpr-core';
import type { JsonSnapshotFileMetaDTO, ParsedMprFileMetaDTO } from '@toit/contracts';

export class BadMprRequestError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'BadMprRequestError';
  }
}

export interface MprInputFile {
  buffer: Buffer;
  originalName: string;
}

export interface MprRunOutcome {
  result: MatchResult;
  jsonFiles: JsonSnapshotFileMetaDTO[];
  mprFiles: ParsedMprFileMetaDTO[];
  businessDates: string[];
  outlets: string[];
}

/** Shape trusted from an uploaded Layer-1 snapshot — deliberately loose, matching legacy's own single truthy-key check. */
interface UploadedSnapshot {
  meta?: { businessDate?: string | null; outlet?: string | null };
  settlementLedger?: unknown[];
  upi?: { transactions?: unknown[]; justifications?: unknown[] };
}

export function runMprReconciliation(jsonFiles: MprInputFile[], mprFiles: MprInputFile[]): MprRunOutcome {
  const sessions: TaggedLedgerRow[] = [];
  const upiPRRows: TaggedUpiTransaction[] = [];
  const upiJustifications: TaggedUpiJustification[] = [];
  const jsonFileMeta: JsonSnapshotFileMetaDTO[] = [];
  const businessDates = new Set<string>();
  const outlets = new Set<string>();

  for (const f of jsonFiles) {
    let data: UploadedSnapshot;
    try {
      data = JSON.parse(f.buffer.toString('utf8'));
    } catch (e) {
      // Legacy: alert() + `continue` — skip just this file, keep going.
      jsonFileMeta.push({
        filename: f.originalName,
        businessDate: null,
        outlet: null,
        error: `${f.originalName}: failed to parse — ${(e as Error).message}`,
      });
      continue;
    }
    if (!data.settlementLedger) {
      jsonFileMeta.push({
        filename: f.originalName,
        businessDate: data.meta?.businessDate ?? null,
        outlet: data.meta?.outlet ?? null,
        error: `${f.originalName}: not a valid recon snapshot (missing settlementLedger)`,
      });
      continue;
    }

    const biz = data.meta?.businessDate || 'unknown';
    const outlet = data.meta?.outlet ?? null;
    businessDates.add(biz);
    if (outlet) outlets.add(outlet);
    jsonFileMeta.push({ filename: f.originalName, businessDate: data.meta?.businessDate ?? null, outlet });

    for (const row of data.settlementLedger as Record<string, unknown>[]) {
      sessions.push({ ...row, _businessDate: biz } as TaggedLedgerRow);
    }

    const txns = data.upi?.transactions ?? [];
    const justs = data.upi?.justifications ?? [];
    for (const t of txns as Array<Record<string, unknown>>) {
      // Kotak Static UPI has no per-transaction MPR format — only HDFC is matched transaction-by-transaction.
      if (t.source === 'HDFC') upiPRRows.push({ ...t, _businessDate: biz } as TaggedUpiTransaction);
    }
    for (const j of justs as Array<Record<string, unknown>>) {
      upiJustifications.push({ ...j, _businessDate: biz } as TaggedUpiJustification);
    }
  }

  const mprParsed = mprFiles.map((f) => parseMprFile(f.originalName, f.buffer, detectAdapter(f.originalName)));
  const mprFileMeta: ParsedMprFileMetaDTO[] = mprParsed.map((p) => ({
    filename: p.filename,
    detected: p.source,
    rowCount: p.rows.length,
    error: p.error ?? null,
  }));

  const input: MatchInput = { sessions, mprParsed, upiPRRows, upiJustifications };
  const result = runMatch(input);

  return {
    result,
    jsonFiles: jsonFileMeta,
    mprFiles: mprFileMeta,
    businessDates: [...businessDates].sort(),
    outlets: [...outlets].sort(),
  };
}
