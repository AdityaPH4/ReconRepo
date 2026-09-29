/**
 * Stage A of automated MPR (Layer 2) ingestion.
 *
 * Connects over IMAP to the dedicated bank/aggregator mailbox
 * (`config.mprMailbox`), finds unread messages from an allowlisted sender,
 * and uploads their `.csv`/`.xlsx`/`.xls` attachments to S3 for Stage B
 * (`mprIngestService.ts`) to pick up on its own schedule. Deliberately does
 * NOT run in the same Lambda/VPC as the main API or Stage B — a VPC-attached
 * Lambda has no route to an external IMAP server without a NAT Gateway
 * (a real fixed monthly cost this design avoids), so this one runs outside
 * any VPC instead (see `mailFetchLambda.ts`), the same split already used
 * for `authLambda.ts` vs the main API Lambda.
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

function isAllowedSender(fromAddress: string | undefined): boolean {
  if (!fromAddress) return false;
  const lower = fromAddress.toLowerCase();
  return config.mprMailbox.senderAllowlist.some((s) => lower.includes(s));
}

export interface MailFetchResult {
  messagesScanned: number;
  messagesFromAllowedSenders: number;
  attachmentsUploaded: number;
}

export async function runMailFetch(): Promise<MailFetchResult> {
  if (!config.mprMailbox.imapUser) {
    console.log('[mail-fetch] IMAP_USER not configured — skipping.');
    return { messagesScanned: 0, messagesFromAllowedSenders: 0, attachmentsUploaded: 0 };
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

  let messagesScanned = 0;
  let messagesFromAllowedSenders = 0;
  let attachmentsUploaded = 0;

  await client.connect();
  try {
    await client.mailboxOpen('INBOX');
    try {
      await client.mailboxCreate(config.mprMailbox.processedFolder);
    } catch {
      // mailboxCreate throws when the folder already exists — fine, that's
      // the common case on every run after the first.
    }

    const uids = (await client.search({ seen: false }, { uid: true })) || [];
    messagesScanned = uids.length;

    for (const uid of uids) {
      const dl = await client.download(String(uid), undefined, { uid: true });
      if (!dl.content) continue; // message vanished mid-run (deleted elsewhere) — nothing to do

      const parsed = await simpleParser(dl.content);
      const fromAddress = parsed.from?.value[0]?.address;
      if (!isAllowedSender(fromAddress)) continue; // not a bank/aggregator sender — leave it in INBOX untouched

      messagesFromAllowedSenders++;
      const attachments = parsed.attachments.filter((a) => ATTACHMENT_EXT.test(a.filename ?? ''));
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
      // none has still been looked at and handled).
      await client.messageMove(String(uid), config.mprMailbox.processedFolder, { uid: true });
    }
  } finally {
    await client.logout();
  }

  console.log(
    `[mail-fetch] scanned ${messagesScanned} unseen message(s), ${messagesFromAllowedSenders} from allowed senders, uploaded ${attachmentsUploaded} attachment(s)`,
  );
  return { messagesScanned, messagesFromAllowedSenders, attachmentsUploaded };
}
