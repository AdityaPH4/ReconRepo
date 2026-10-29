/**
 * Stage A of automated MPR (Layer 2) ingestion.
 *
 * Connects over IMAP to the bank/aggregator mailbox (`config.mprMailbox`),
 * finds unread messages from an allowlisted sender, and uploads their
 * `.csv`/`.xlsx`/`.xls` attachments to S3 for Stage B
 * (`mprIngestService.ts`) to pick up on its own schedule. Deliberately does
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
 * the mailbox otherwise carries. `MPR_SEARCH_WINDOW_DAYS` bounds each
 * search to recent messages only, as a further defensive cap.
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
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { config } from '../config.js';
import { createRawS3Client } from '../storage/s3ObjectStore.js';

const ATTACHMENT_EXT = /\.(csv|xlsx|xls)$/i;

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
}

export async function runMailFetch(backfill?: MailBackfillOptions): Promise<MailFetchResult> {
  if (!config.mprMailbox.imapUser) {
    console.log('[mail-fetch] IMAP_USER not configured — skipping.');
    return { messagesScanned: 0, messagesFromAllowedSenders: 0, attachmentsUploaded: 0 };
  }
  const senders = [...config.mprMailbox.senderAllowlist, ...(backfill?.extraSenders ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean)];
  if (!senders.length) {
    // No allowlist configured — searching with no `from` filter at all
    // would mean pulling every unseen message in the mailbox, which is
    // exactly the expensive, unbounded scan this design avoids. Refuse
    // rather than silently doing that.
    console.log('[mail-fetch] MPR_SENDER_ALLOWLIST is empty — refusing to scan the whole mailbox, skipping.');
    return { messagesScanned: 0, messagesFromAllowedSenders: 0, attachmentsUploaded: 0 };
  }

  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  if (backfill && (!isoDate.test(backfill.since) || (backfill.before && !isoDate.test(backfill.before)))) {
    throw new Error('backfill.since / backfill.before must be yyyy-mm-dd.');
  }

  const password = await resolveImapPassword();
  const client = new ImapFlow({
    host: config.mprMailbox.imapHost,
    port: config.mprMailbox.imapPort,
    secure: true,
    auth: { user: config.mprMailbox.imapUser, pass: password },
    logger: false,
  });
  const s3 = createRawS3Client(config.objectStore);

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

    const since = backfill ? new Date(`${backfill.since}T00:00:00+05:30`) : new Date(Date.now() - config.mprMailbox.searchWindowDays * 24 * 60 * 60 * 1000);
    const before = backfill?.before ? new Date(`${backfill.before}T00:00:00+05:30`) : undefined;
    // A normal run only looks at unread INBOX mail; a backfill also reads the processed folder, and ignores the read flag.
    const folders = backfill ? ['INBOX', config.mprMailbox.processedFolder] : ['INBOX'];

    for (const folder of folders) {
      await client.mailboxOpen(folder);
      const candidateUids = new Set<number>();

      // One IMAP SEARCH per allowlisted sender — the server filters by FROM
      // and SINCE itself, so a busy shared mailbox's unrelated unread traffic
      // is never downloaded or parsed at all, regardless of its volume.
      for (const sender of senders) {
        const criteria = { ...(backfill ? {} : { seen: false }), from: sender, since, ...(before ? { before } : {}) };
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

        if (backfill?.dryRun) {
          preview.push({
            folder,
            from: fromAddress ?? '',
            date: parsed.date?.toISOString().slice(0, 10) ?? '',
            subject: parsed.subject ?? '',
            attachments: attachments.map((a) => a.filename!),
          });
          continue;
        }

        const dateKey = new Date().toISOString().slice(0, 10);
        for (const att of attachments) {
          const key = `${config.mprMailbox.s3PendingPrefix}${dateKey}/${randomUUID()}_${sanitizeFilename(att.filename!)}`;
          await s3.send(
            new PutObjectCommand({
              Bucket: config.objectStore.bucket,
              Key: key,
              Body: att.content,
              ContentType: att.contentType,
            }),
          );
          attachmentsUploaded++;
        }

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

  console.log(
    `[mail-fetch] ${messagesScanned} candidate message(s) from allowlisted senders, ${messagesFromAllowedSenders} confirmed, uploaded ${attachmentsUploaded} attachment(s)`,
  );
  return { messagesScanned, messagesFromAllowedSenders, attachmentsUploaded, ...(backfill?.dryRun ? { preview: preview.slice(0, 500) } : {}) };
}
