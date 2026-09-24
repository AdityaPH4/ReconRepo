/**
 * Outbound email — currently just the submitted-session report, sent to the
 * accounts team (`config.email.bgkEmails`). Plain SMTP via `nodemailer`
 * (`config.email.smtpHost`/`smtpPort`, defaulting to Brevo's relay) rather
 * than a specific provider's API — free at this volume (a handful of emails
 * a day) and, unlike Gmail/Workspace, doesn't depend on an app-password
 * setting a Workspace admin might have disabled, and unlike SES, doesn't
 * need a sandbox/production-access approval step.
 */

import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.email.smtpHost,
      port: config.email.smtpPort,
      // 465 is implicit TLS; every other port (587 — Brevo's documented
      // default, 25, ...) starts plaintext and upgrades via STARTTLS.
      secure: config.email.smtpPort === 465,
      auth: { user: config.email.smtpUser, pass: config.email.smtpPassword },
    });
  }
  return transporter;
}

export interface EmailMessage {
  to: readonly string[];
  subject: string;
  html: string;
}

/**
 * Sends one email. Never throws — email is a best-effort notification
 * layered on top of whatever triggered it (e.g. a submit), never something
 * that should roll back or block the action itself. A failure is logged,
 * not surfaced to the caller.
 */
export async function sendEmail(message: EmailMessage): Promise<void> {
  if (!config.email.enabled) {
    console.log(`[email] SMTP not configured — skipping "${message.subject}"`);
    return;
  }
  if (message.to.length === 0) {
    console.log(`[email] No recipients configured — skipping "${message.subject}"`);
    return;
  }
  try {
    await getTransporter().sendMail({
      from: `"${config.email.fromName}" <${config.email.fromEmail}>`,
      to: message.to.join(', '),
      subject: message.subject,
      html: message.html,
    });
    console.log(`[email] Sent "${message.subject}" to ${message.to.join(', ')}`);
  } catch (err) {
    console.error(`[email] Failed to send "${message.subject}" to ${message.to.join(', ')}:`, err);
  }
}
