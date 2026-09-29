/**
 * MPR (Layer 2) reconciliation orchestration — the server-side equivalent of
 * legacy `runReconciliation` (`mpr-recon (10).html` lines 815–860).
 *
 * Merges every uploaded Layer-1 JSON snapshot's settlement ledger (tagged
 * with which business date it came from), parses every uploaded bank MPR
 * file, and runs the matcher. Legacy's sole validation for a JSON upload is
 * "does it have a `settlementLedger` key at all" — preserved as-is.
 */

import { randomUUID } from 'node:crypto';
import { detectAdapter, parseMprFile, runMatch } from '@toit/mpr-core';
import type {
  MatchInput,
  MatchResult,
  TaggedLedgerRow,
  TaggedUpiJustification,
  TaggedUpiTransaction,
} from '@toit/mpr-core';
import type { JsonSnapshotFileMetaDTO, MprMatchResultDTO, MprRowClosureDTO, ParsedMprFileMetaDTO } from '@toit/contracts';

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

/**
 * The automated-ingestion equivalent of `MprInputFile` for the JSON side —
 * a Layer-1 `Snapshot` already in hand as an object (straight from
 * `SessionDTO.snapshot`), not bytes that need `JSON.parse`ing back. Used
 * only by the automated MPR ingest path; a manual file upload always goes
 * through `MprInputFile` (it has no session id, only bytes).
 */
export interface MprSnapshotInput {
  snapshot: unknown;
  sourceSessionId: string;
  /** Shows up as `filename` in `jsonFileMeta` — the same error-list/audit display a manual upload's filename already renders into. */
  label: string;
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

export function runMprReconciliation(
  jsonFiles: Array<MprInputFile | MprSnapshotInput>,
  mprFiles: MprInputFile[],
): MprRunOutcome {
  const sessions: TaggedLedgerRow[] = [];
  const upiPRRows: TaggedUpiTransaction[] = [];
  const upiJustifications: TaggedUpiJustification[] = [];
  const jsonFileMeta: JsonSnapshotFileMetaDTO[] = [];
  const businessDates = new Set<string>();
  const outlets = new Set<string>();

  for (const f of jsonFiles) {
    const isSnapshotInput = 'snapshot' in f;
    const filename = isSnapshotInput ? f.label : f.originalName;
    const sourceSessionId = isSnapshotInput ? f.sourceSessionId : null;

    let data: UploadedSnapshot;
    if (isSnapshotInput) {
      data = f.snapshot as UploadedSnapshot;
    } else {
      try {
        data = JSON.parse(f.buffer.toString('utf8'));
      } catch (e) {
        // Legacy: alert() + `continue` — skip just this file, keep going.
        jsonFileMeta.push({
          filename,
          businessDate: null,
          outlet: null,
          error: `${filename}: failed to parse — ${(e as Error).message}`,
          sourceSessionId,
        });
        continue;
      }
    }
    if (!data.settlementLedger) {
      jsonFileMeta.push({
        filename,
        businessDate: data.meta?.businessDate ?? null,
        outlet: data.meta?.outlet ?? null,
        error: `${filename}: not a valid recon snapshot (missing settlementLedger)`,
        sourceSessionId,
      });
      continue;
    }

    const biz = data.meta?.businessDate || 'unknown';
    const outlet = data.meta?.outlet ?? null;
    businessDates.add(biz);
    if (outlet) outlets.add(outlet);
    jsonFileMeta.push({ filename, businessDate: data.meta?.businessDate ?? null, outlet, sourceSessionId });

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

/**
 * Assigns every row its (session-scoped) identity and initial open/closed
 * status — a pure `MatchResult` has neither; identity is a storage-time
 * concept, assigned once here, right before persisting. `settled` rows are
 * already correctly reconciled, so they start closed with nothing to do;
 * `amountMismatch`/`pending`/`ambiguous`/`unexpected` always start open.
 * AMEX/UPI rows carry their own `_match` status (`'settled' | 'mismatch' |
 * 'pending' | 'unexpected' | 'partial' | 'ambiguous'`, the last AMEX-only) —
 * only `'settled'` starts closed.
 */
export function enrichMprMatchResult(result: MatchResult): MprMatchResultDTO {
  const closed = (): MprRowClosureDTO => ({
    id: randomUUID(),
    status: 'closed',
    closedAt: null,
    closedBy: null,
    closedNote: null,
  });
  const open = (): MprRowClosureDTO => ({
    id: randomUUID(),
    status: 'open',
    closedAt: null,
    closedBy: null,
    closedNote: null,
  });

  return {
    settled: result.settled.map((r) => ({ ...r, ...closed() })),
    amountMismatch: result.amountMismatch.map((r) => ({ ...r, ...open() })),
    pending: result.pending.map((r) => ({ ...r, ...open() })),
    ambiguous: result.ambiguous.map((r) => ({ ...r, ...open() })),
    unexpected: result.unexpected.map((r) => ({ ...r, ...open() })),
    amexResults: result.amexResults.map((r) => ({ ...r, ...(r._match === 'settled' ? closed() : open()) })),
    upiResults: result.upiResults.map((r) => ({ ...r, ...(r._match === 'settled' ? closed() : open()) })),
  };
}
