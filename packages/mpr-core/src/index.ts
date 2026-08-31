/**
 * @toit/mpr-core — the Layer-2 (MPR) reconciliation engine.
 *
 * Pure domain logic: bank-file adapters, the RRN/AMEX/UPI matcher, CSV
 * export. No DOM, no database, no network, no clock. Consumed by @toit/api.
 *
 * Ported from `legacy/mpr-recon (10).html`. Each module names the legacy
 * line range it came from so the port stays auditable against the original.
 */

export type {
  AdapterDef,
  AdapterKey,
  AmbiguousMprRow,
  AmexMatchStatus,
  AmexMprRow,
  AmexResult,
  BatchFields,
  MatchInput,
  MatchResult,
  MprRow,
  ParsedMprFile,
  PendingRow,
  SettledRow,
  TaggedLedgerRow,
  TaggedUpiJustification,
  TaggedUpiTransaction,
  TransactionFields,
  UnexpectedMprRow,
  UpiMatchBy,
  UpiMatchStatus,
  UpiResult,
} from './types.js';

export { ADAPTERS, detectAdapter } from './adapters.js';

export {
  adjustPRDate,
  amexNormDate,
  fmt,
  normDate,
  normRRN,
  parseTxnTimestamp,
  splitRRNs,
} from './util/normalize.js';

export { parseMprFile } from './parsers/mprFile.js';
export { parseAmexCSV } from './parsers/amexCsv.js';

export { runMatch } from './engine/match.js';
export { buildExportRows, rowsToCsv } from './engine/csvExport.js';
