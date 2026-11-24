/**
 * Stage A of automated MPR (Layer 2) ingestion.
 *
 * Connects over IMAP to the bank/aggregator mailbox (`config.mprMailbox`),
 * finds recent messages from an allowlisted sender, and uploads their
 * `.csv`/`.xlsx`/`.xls` attachments (and the files behind Pine Labs'
 * "Download MPR" links, which come with no attachment) to S3 for Stage B
 * (`mprIngestService.ts`) to pick up on its own schedule. One sender,
 * `payoutreport@hdfcbank.bank.in`, sends a password-protected PDF instead —
 * for a merchant ID with a configured password (`HDFC_CARD_PDF_PASSWORDS`),
 * it's decrypted and converted to the same CSV shape right here, so Stage B
 * never needs to know it was ever a PDF (see `hdfcCardPdf.ts`). Deliberately does
 * NOT run in the same Lambda/VPC as the main API or Stage B — a VPC-attached
 * Lambda has no route to an external IMAP server without a NAT Gateway
 * (a real fixed monthly cost this design avoids), so this one runs outside
 * any VPC instead (see `mailFetchLambda.ts`), the same split already used
 * for `authLambda.ts` vs the main API Lambda.
 *
 * This mailbox is not assumed to be a fresh, dedicated, low-traffic inbox —
 * in practice it can be a real, already-in-use address with thousands of
 * unrelated unread messages (confirmed against the real `tech@ph4.in`
 * account: 6,000+ total, 4,000+ unread, at the time this was built). So the
 * IMAP SEARCH itself is scoped `FROM <allowed sender>` per allowlist entry
 * — the server does the filtering; nothing not already matching a sender
 * ever gets downloaded/parsed, regardless of how much unrelated traffic
 * the mailbox otherwise carries. A normal run only looks back
 * `MAX_CATCH_UP_DAYS` (7) days, read or unread, and only searches the senders
 * whose daily files are still missing (`mailFetchLedger.ts`).
 *
 * "Already processed" tracking is the IMAP move itself, not a database
 * table: a handled message is moved out of `INBOX` into
 * `config.mprMailbox.processedFolder`, so this function's own `INBOX`-
 * scoped search can never find it again on a later run. Deliberately a
 * move, not marking `\Seen` — immune to a human opening the mailbox in
 * Gmail's own web UI (which marks a message `\Seen` on open) and silently
 * causing it to be skipped forever.
 */

import { randomUUID } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { config } from '../config.js';
import { createRawS3Client } from '../storage/s3ObjectStore.js';
import { convertHdfcCardPdf, HdfcCardPasswordError } from './hdfcCardPdf.js';
import { istToday, ledgerReport, MAIL_SOURCES, missingDaily, pruneLedger, recordFile, sendersToSearch, windowStart, type Ledger } from './mailFetchLedger.js';

const ATTACHMENT_EXT = /\.(csv|xlsx|xls)$/i;

/** The one sender whose PDF attachments are ever decrypted — see `hdfcCardPdf.ts`. */
const HDFC_CARD_SENDER = 'payoutreport@hdfcbank.bank.in';

/** Pine Labs sends no attachment, only a public "Download MPR" link. Since 17 Nov that link is wrapped in an AWS click-tracker holding the real address URL-encoded (`...%2F<id>`), so match the id after the host in either form and always fetch from the real host. */
const PINELABS_LINK = /settlement-content\.pinelabs\.com(?:\/|%2F)([0-9a-f-]{36})/gi;
const MAX_LINK_BYTES = 20 * 1024 * 1024;

interface MailFile {
  name: string;
  body: Buffer;
  type: string;
}

export function pinelabsMprLinks(messageText: string): string[] {
  return [...new Set([...messageText.matchAll(PINELABS_LINK)].map((m) => `https://settlement-content.pinelabs.com/${m[1]!.toLowerCase()}`))];
}

// shortcut: the size cap applies after the whole body is read, fine for ~20 KB reports, switch to streaming if Pine Labs ever sends big ones.
export async function downloadPinelabsMpr(url: string): Promise<MailFile> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_LINK_BYTES) throw new Error(`file over ${MAX_LINK_BYTES} bytes for ${url}`);
  const named = /filename="?([^";]+)"?/i.exec(res.headers.get('content-disposition') ?? '')?.[1];
  // The server's own name already carries "POS_AuthMerchantMpr" / "ConsolidatedMerchantMpr", which is what `detectAdapter` keys on.
  const name = named ? decodeURIComponent(named) : `pinelabs_${url.slice(url.lastIndexOf('/') + 1)}.xlsx`;
  if (!ATTACHMENT_EXT.test(name)) throw new Error(`unexpected file type "${name}" for ${url}`);
  return { name, body, type: res.headers.get('content-type') ?? 'application/octet-stream' };
}

async function resolveImapPassword(): Promise<string> {
  if (config.mprMailbox.imapAppPasswordLocal) return config.mprMailbox.imapAppPasswordLocal;
  if (!config.mprMailbox.imapAppPasswordParam) {
    throw new Error(
      'No IMAP app password configured — set IMAP_APP_PASSWORD (local/dev) or IMAP_APP_PASSWORD_PARAM (an SSM parameter name, for Lambda).',
    );
  }
  const ssm = new SSMClient({ region: config.objectStore.region });
  const res = await ssm.send(
    new GetParameterCommand({ Name: config.mprMailbox.imapAppPasswordParam, WithDecryption: true }),
  );
  if (!res.Parameter?.Value) {
    throw new Error(`SSM parameter "${config.mprMailbox.imapAppPasswordParam}" has no value.`);
  }
  return res.Parameter.Value;
}

/** `{merchantId: password}` for the HDFC-card PDF source — `{}` when none is configured (that bank's mail is then left exactly as it is today: moved, nothing extracted). */
async function resolveHdfcCardPasswords(): Promise<Record<string, string>> {
  const raw = config.mprMailbox.hdfcCardPdfPasswordsLocal
    ? config.mprMailbox.hdfcCardPdfPasswordsLocal
    : config.mprMailbox.hdfcCardPdfPasswordsParam
      ? ((
          await new SSMClient({ region: config.objectStore.region }).send(
            new GetParameterCommand({ Name: config.mprMailbox.hdfcCardPdfPasswordsParam, WithDecryption: true }),
          )
        ).Parameter?.Value ?? '')
      : '';
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch (err) {
    console.warn(`[mail-fetch] HDFC_CARD_PDF_PASSWORDS is not valid JSON, ignoring: ${(err as Error).message}`);
    return {};
  }
}

/**
 * S3 keys are byte-permissive, but keep this simple and predictable — only
 * word characters, dots and dashes survive; everything else (spaces,
 * parens, ...) becomes an underscore. Never touches the substrings
 * `detectAdapter()`'s regexes key on (kotak/pinelabs/hdfc/amex/settlement/
 * digit runs) — all plain alphanumerics already.
 */
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** `null` when there is no ledger yet (or it can't be read): the caller rebuilds it from the processed folder. */
async function loadLedger(s3: S3Client): Promise<Ledger | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: config.objectStore.bucket, Key: config.mprMailbox.s3LedgerKey }));
    return JSON.parse(await res.Body!.transformToString()) as Ledger;
  } catch (err) {
    if ((err as { name?: string }).name !== 'NoSuchKey') console.warn(`[mail-fetch] could not read the fetch ledger: ${(err as Error).message}`);
    return null;
  }
}

// shortcut: a failed save only costs the report and some extra searching, so it never stops a fetch; fix the bucket permission if the warning shows up.
async function saveLedger(s3: S3Client, ledger: Ledger, today: string): Promise<void> {
  pruneLedger(ledger, today);
  try {
    await s3.send(
      new PutObjectCommand({ Bucket: config.objectStore.bucket, Key: config.mprMailbox.s3LedgerKey, Body: JSON.stringify(ledger), ContentType: 'application/json' }),
    );
  } catch (err) {
    console.warn(`[mail-fetch] could not save the fetch ledger: ${(err as Error).message}`);
  }
}

function attachmentNames(node: { disposition?: string; parameters?: { name?: string }; dispositionParameters?: { filename?: string }; childNodes?: unknown[] } | undefined, out: string[] = []): string[] {
  if (!node) return out;
  const name = node.dispositionParameters?.filename || node.parameters?.name;
  if (name) out.push(name);
  for (const child of node.childNodes ?? []) attachmentNames(child as Parameters<typeof attachmentNames>[0], out);
  return out;
}

/** First run with no ledger: what the processed folder already holds was fetched earlier, so mark it from the attachment names alone (no downloads). */
export async function seedLedger(client: ImapFlow, ledger: Ledger, since: Date): Promise<void> {
  await client.mailboxOpen(config.mprMailbox.processedFolder);
  for (const sender of MAIL_SOURCES.flatMap((s) => s.senders)) {
    const uids = (await client.search({ from: sender, since }, { uid: true })) || [];
    if (!uids.length) continue;
    for await (const msg of client.fetch(uids, { bodyStructure: true }, { uid: true })) {
      for (const name of attachmentNames(msg.bodyStructure as Parameters<typeof attachmentNames>[0])) recordFile(ledger, name, 'seeded');
    }
  }
}

function isAllowedSender(fromAddress: string | undefined, senders: string[]): boolean {
  if (!fromAddress) return false;
  const lower = fromAddress.toLowerCase();
  return senders.some((s) => lower.includes(s));
}

/**
 * One-off catch-up over a past period (`mpr-mail-fetch` test event
 * `{"backfill":{"since":"2026-10-01","before":"2026-10-08","dryRun":true}}`).
 * Looks in INBOX *and* the processed folder, read or unread, and fetches the
 * attachments again — safe, because Stage B already recognises rows a bank
 * file resent as reconciled (`loadRecentSettledKeys`). Messages already in the
 * processed folder are left where they are. A dry run uploads and moves
 * nothing and lists what it found. Run it in short windows (a week at a
 * time): each window becomes one big Stage B run.
 */
export interface MailBackfillOptions {
  /** `yyyy-mm-dd`, inclusive. */
  since: string;
  /** `yyyy-mm-dd`, exclusive. Omit for "up to now". */
  before?: string;
  dryRun?: boolean;
  /** Extra sender substrings for this run only, to try a sender that isn't in `MPR_SENDER_ALLOWLIST` yet. */
  extraSenders?: string[];
  /** Search only these senders (of the allowlist plus `extraSenders`), e.g. to re-fetch one bank's mail without re-uploading the others. */
  onlySenders?: string[];
}

export interface MailPreviewItem {
  folder: string;
  from: string;
  date: string;
  subject: string;
  attachments: string[];
}

export interface MailFetchResult {
  /** Distinct candidate UIDs found across all per-sender IMAP searches — NOT the mailbox's total unseen count, which the sender-scoped search never even queries. */
  messagesScanned: number;
  messagesFromAllowedSenders: number;
  attachmentsUploaded: number;
  /** Dry-run backfill only: what would be fetched. */
  preview?: MailPreviewItem[];
  /** Newest file date fetched per bank, and daily files still absent for days that have ended. */
  ledger: { lastFetched: Record<string, string>; missing: string[] };
  /** HDFC-card PDF(s) seen this run whose merchant ID has no configured password, or whose configured one was rejected — `${merchantId} ${filename}`. Check before assuming a quiet merchant ID has simply sent nothing. */
  hdfcCardBadPasswords: string[];
}

export async function runMailFetch(backfill?: MailBackfillOptions): Promise<MailFetchResult> {
  if (!config.mprMailbox.imapUser) {
    console.log('[mail-fetch] IMAP_USER not configured — skipping.');
    return { messagesScanned: 0, messagesFromAllowedSenders: 0, attachmentsUploaded: 0, ledger: { lastFetched: {}, missing: [] }, hdfcCardBadPasswords: [] };
  }
  const lower = (xs: string[] = []) => xs.map((x) => x.trim().toLowerCase()).filter(Boolean);
  const only = lower(backfill?.onlySenders);
  const senders = [...config.mprMailbox.senderAllowlist, ...lower(backfill?.extraSenders)].filter((s) => !only.length || only.includes(s));
  if (!senders.length) {
    // No allowlist configured — searching with no `from` filter at all
    // would mean pulling every unseen message in the mailbox, which is
    // exactly the expensive, unbounded scan this design avoids. Refuse
    // rather than silently doing that.
    console.log('[mail-fetch] MPR_SENDER_ALLOWLIST is empty — refusing to scan the whole mailbox, skipping.');
    return { messagesScanned: 0, messagesFromAllowedSenders: 0, attachmentsUploaded: 0, ledger: { lastFetched: {}, missing: [] }, hdfcCardBadPasswords: [] };
  }

  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  if (backfill && (!isoDate.test(backfill.since) || (backfill.before && !isoDate.test(backfill.before)))) {
    throw new Error('backfill.since / backfill.before must be yyyy-mm-dd.');
  }

  const password = await resolveImapPassword();
  const hdfcCardPasswords = await resolveHdfcCardPasswords();
  const hdfcCardBadPasswords: string[] = [];
  const client = new ImapFlow({
    host: config.mprMailbox.imapHost,
    port: config.mprMailbox.imapPort,
    secure: true,
    auth: { user: config.mprMailbox.imapUser, pass: password },
    logger: false,
  });
  const s3 = createRawS3Client(config.objectStore);
  const today = istToday();
  const loaded = await loadLedger(s3);
  const ledger: Ledger = loaded ?? {};

  let messagesFromAllowedSenders = 0;
  let attachmentsUploaded = 0;

  const preview: MailPreviewItem[] = [];
  let messagesScanned = 0;

  await client.connect();
  try {
    try {
      await client.mailboxCreate(config.mprMailbox.processedFolder);
    } catch {
      // mailboxCreate throws when the folder already exists — fine, that's
      // the common case on every run after the first.
    }

    const windowSince = new Date(`${windowStart(today)}T00:00:00+05:30`);
    const since = backfill ? new Date(`${backfill.since}T00:00:00+05:30`) : windowSince;
    const before = backfill?.before ? new Date(`${backfill.before}T00:00:00+05:30`) : undefined;
    if (!loaded) {
      await seedLedger(client, ledger, windowSince);
      if (!backfill?.dryRun) await saveLedger(s3, ledger, today);
    }
    // A normal run reads INBOX, read or unread (handled mail was already moved out), and only searches the senders whose daily files are still missing.
    // A backfill reads every sender, in INBOX and the processed folder.
    const searchSenders = backfill ? senders : sendersToSearch(missingDaily(ledger, today), senders);
    const folders = backfill ? ['INBOX', config.mprMailbox.processedFolder] : searchSenders.length ? ['INBOX'] : [];
    if (!folders.length) console.log('[mail-fetch] every expected daily file is already fetched, nothing to search.');

    for (const folder of folders) {
      await client.mailboxOpen(folder);
      const candidateUids = new Set<number>();

      // One IMAP SEARCH per allowlisted sender — the server filters by FROM
      // and SINCE itself, so a busy shared mailbox's unrelated unread traffic
      // is never downloaded or parsed at all, regardless of its volume.
      for (const sender of searchSenders) {
        const criteria = { from: sender, since, ...(before ? { before } : {}) };
        const uids = (await client.search(criteria, { uid: true })) || [];
        for (const uid of uids) candidateUids.add(uid);
      }
      messagesScanned += candidateUids.size;

      for (const uid of candidateUids) {
        const dl = await client.download(String(uid), undefined, { uid: true });
        if (!dl.content) continue; // message vanished mid-run (deleted elsewhere) — nothing to do

        const parsed = await simpleParser(dl.content);
        const fromAddress = parsed.from?.value[0]?.address;
        // Belt-and-suspenders re-check against the same allowlist, in case
        // IMAP's own FROM substring match ever disagrees with this one —
        // cheap, and the download already happened either way.
        if (!isAllowedSender(fromAddress, senders)) continue;

        messagesFromAllowedSenders++;
        const attachments = parsed.attachments.filter((a) => ATTACHMENT_EXT.test(a.filename ?? ''));
        const links = pinelabsMprLinks(`${parsed.html || ''} ${parsed.text ?? ''}`);
        const isHdfcCard = isAllowedSender(fromAddress, [HDFC_CARD_SENDER]);
        const hdfcCardPdfs = isHdfcCard ? parsed.attachments.filter((a) => /\.pdf$/i.test(a.filename ?? '')) : [];

        if (backfill?.dryRun) {
          preview.push({
            folder,
            from: fromAddress ?? '',
            date: parsed.date?.toISOString().slice(0, 10) ?? '',
            subject: parsed.subject ?? '',
            attachments: [...attachments.map((a) => a.filename!), ...links.map((l) => `link:${l}`), ...hdfcCardPdfs.map((a) => a.filename!)],
          });
          continue;
        }

        // Download every link before uploading anything, so a failed link leaves the message unread in INBOX for the next run to retry whole.
        const files: MailFile[] = attachments.map((a) => ({ name: a.filename!, body: a.content, type: a.contentType }));
        try {
          for (const url of links) files.push(await downloadPinelabsMpr(url));
        } catch (err) {
          console.warn(`[mail-fetch] Pinelabs link download failed for "${parsed.subject}", leaving it in ${folder}: ${(err as Error).message}`);
          continue;
        }

        // HDFC card: one password-protected PDF per merchant ID, named `<merchantId>-ddmmyyyy[...].pdf`.
        // Only a merchant ID with a configured password is ever decrypted — an
        // unconfigured one is left exactly as it is today (the message is still
        // handled/moved; nothing is extracted from it). See `hdfcCardPdf.ts`.
        for (const pdf of hdfcCardPdfs) {
          const name = pdf.filename ?? '';
          const m = /^(\w+)-(\d\d)(\d\d)(\d{4})/.exec(name);
          const merchantId = m?.[1];
          const reportDate = m ? `${m[4]}-${m[3]}-${m[2]}` : null;
          if (!merchantId || !reportDate) {
            console.warn(`[mail-fetch] HDFC card attachment "${name}" doesn't match the expected filename shape, skipping.`);
            continue;
          }
          const pw = hdfcCardPasswords[merchantId];
          if (!pw) continue; // not yet onboarded — silent, same as before this source was decrypted
          try {
            const csv = await convertHdfcCardPdf(pdf.content, pw, name);
            files.push({ name: `hdfccard_${merchantId}_${reportDate}.csv`, body: csv, type: 'text/csv' });
          } catch (err) {
            if (err instanceof HdfcCardPasswordError) {
              hdfcCardBadPasswords.push(`${merchantId} ${name}`);
              console.warn(`[mail-fetch] HDFC card merchant ${merchantId}: configured password rejected for "${name}" — check HDFC_CARD_PDF_PASSWORDS.`);
            } else {
              console.warn(`[mail-fetch] HDFC card "${name}" could not be parsed, skipping: ${(err as Error).message}`);
            }
          }
        }

        const dateKey = new Date().toISOString().slice(0, 10);
        for (const file of files) {
          const key = `${config.mprMailbox.s3PendingPrefix}${dateKey}/${randomUUID()}_${sanitizeFilename(file.name)}`;
          await s3.send(
            new PutObjectCommand({
              Bucket: config.objectStore.bucket,
              Key: key,
              Body: file.body,
              ContentType: file.type,
            }),
          );
          attachmentsUploaded++;
        }

        // Saved before the move below: a crash in between re-fetches the message (Stage B reads identical files once), where the other order would leave a false gap.
        const fetchedAt = new Date().toISOString();
        if (files.map((f) => recordFile(ledger, f.name, fetchedAt)).some(Boolean)) await saveLedger(s3, ledger, today);

        // Only after every attachment of this message is durably uploaded —
        // move it out of INBOX so a future run can never re-process it,
        // whether or not it actually had a usable attachment (a message with
        // none has still been looked at and handled). Already-processed mail
        // (a backfill reading the processed folder) stays where it is.
        if (folder === 'INBOX') await client.messageMove(String(uid), config.mprMailbox.processedFolder, { uid: true });
      }
    }
  } finally {
    await client.logout();
  }

  const report = ledgerReport(ledger, today);
  console.log(
    `[mail-fetch] ${messagesScanned} candidate message(s) from allowlisted senders, ${messagesFromAllowedSenders} confirmed, uploaded ${attachmentsUploaded} attachment(s); last fetched ${JSON.stringify(report.lastFetched)}; missing ${report.missing.length ? report.missing.join(', ') : 'none'}`,
  );
  return { messagesScanned, messagesFromAllowedSenders, attachmentsUploaded, ledger: report, hdfcCardBadPasswords, ...(backfill?.dryRun ? { preview: preview.slice(0, 500) } : {}) };
}
