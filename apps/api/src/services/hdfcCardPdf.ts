/**
 * The HDFC "card" source (`payoutreport@hdfcbank.bank.in`) sends one
 * password-protected PDF per merchant ID — the password is that merchant's
 * HDFC merchant ID (the bank states this in its own mail body). Each page's
 * transaction section is free text, not a table: `CR P2M <vpa> <txn date>
 * <settlement date> <amount> <RRN> <bank ref>`, one line per transaction.
 *
 * This runs in Stage A (`mailFetchService.ts`, no VPC) — it decrypts and
 * converts straight to the CSV shape `HDFC_CARD` in `@toit/mpr-core`'s
 * `ADAPTERS` expects, so Stage B never needs to know these files were ever
 * PDFs, or hold any password. See
 * docs/superpowers/specs/2026-11-19-mpr-staging-layer-design.md.
 *
 * Verified against 19 real files (1–23 Nov, merchant 43156170, 480
 * transaction lines): every line matched this regex, every disposition was
 * `CR` (no `DR` seen yet), and the first date was never later than the
 * second. Still, a file that doesn't fit this shape fails loudly (below)
 * rather than silently dropping rows — same "poison pill" protection as
 * every other bank adapter.
 */

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Thrown when the given password is wrong for this PDF — distinct from a parse error, so the caller can report it separately (e.g. "check HDFC_CARD_PDF_PASSWORDS") instead of silently filing it as a bad file. */
export class HdfcCardPasswordError extends Error {}

const LINE_RE = /^\s*(CR|DR)\s+P2M\s+(\S+)\s+(\d{2}-\d{2}-\d{2})\s+(\d{2}-\d{2}-\d{2})\s+([\d.]+)\s+(\d+)\s+(\S+)/;
const TXN_SHAPED = /^\s*(?:CR|DR)\s+P2M\b/;

export interface HdfcCardRow {
  rrn: string;
  grossAmount: number;
  /** PDF's own `dd-mm-yy` text — `normDate()`'s `dm4` branch already reads this format. */
  txnDate: string;
  settlementDate: string;
}

/**
 * `getTextContent()` returns a flat list of text fragments with no line
 * breaks of its own — reconstructed here from each fragment's y position
 * (its `transform[5]`): a new line starts whenever y moves by more than a
 * couple of PDF units from the line in progress. Verified against a real
 * file: 251 lines, matching a line-by-line reader (`pypdf`) exactly.
 */
function reconstructLines(items: Array<{ str?: string; transform?: number[] }>): string {
  const lines: string[] = [];
  let curY: number | null = null;
  let cur: string[] = [];
  for (const it of items) {
    if (it.str == null || !it.transform) continue;
    const y = Math.round(it.transform[5]!);
    if (curY === null || Math.abs(y - curY) > 2) {
      if (cur.length) lines.push(cur.join(''));
      cur = [];
      curY = y;
    }
    cur.push(it.str);
  }
  if (cur.length) lines.push(cur.join(''));
  return lines.join('\n');
}

/** Decrypts the PDF with pdfjs-dist and concatenates every page's reconstructed text. */
async function extractText(pdfBytes: Buffer, password: string): Promise<string> {
  try {
    const doc = await getDocument({ data: new Uint8Array(pdfBytes), password, verbosity: 0 }).promise;
    let text = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      text += reconstructLines(content.items as Array<{ str?: string; transform?: number[] }>) + '\n';
    }
    return text;
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === 'PasswordException') throw new HdfcCardPasswordError(`wrong password for this PDF`);
    throw err;
  }
}

/**
 * Pure line-parsing: every line that *looks* like a transaction (starts
 * `CR`/`DR P2M`) must fully match the strict regex, or the whole file is
 * rejected — a page-break split or a layout change is never silently
 * dropped. A day with zero transactions (a real, observed case) is fine:
 * zero txn-shaped lines is not a mismatch.
 */
export function parseHdfcCardText(text: string, filename: string): HdfcCardRow[] {
  const lines = text.split('\n');
  const rows: HdfcCardRow[] = [];
  let shaped = 0;
  for (const line of lines) {
    if (!TXN_SHAPED.test(line)) continue;
    shaped++;
    const m = LINE_RE.exec(line);
    if (!m) continue;
    rows.push({ rrn: m[6]!, grossAmount: Number(m[5]), txnDate: m[3]!, settlementDate: m[4]! });
  }
  if (rows.length !== shaped) {
    throw new Error(`${filename}: ${shaped - rows.length} of ${shaped} transaction-shaped line(s) didn't match the expected layout — refusing to guess.`);
  }
  return rows;
}

/** CSV text in the shape `ADAPTERS.HDFC_CARD` expects (see `packages/mpr-core/src/adapters.ts`). */
export function toHdfcCardCsv(rows: HdfcCardRow[]): string {
  const lines = ['RRN,Txn Amt,Txn Date,Settlement Date'];
  for (const r of rows) lines.push(`${r.rrn},${r.grossAmount},${r.txnDate},${r.settlementDate}`);
  return lines.join('\n');
}

/** Decrypts + parses one HDFC-card PDF attachment, returning CSV bytes ready to upload to S3 pending. Throws `HdfcCardPasswordError` on a wrong password, or a plain `Error` on an unexpected layout — both are per-file, never fatal to the run. */
export async function convertHdfcCardPdf(pdfBytes: Buffer, password: string, filename: string): Promise<Buffer> {
  const text = await extractText(pdfBytes, password);
  const rows = parseHdfcCardText(text, filename);
  return Buffer.from(toHdfcCardCsv(rows), 'utf8');
}
