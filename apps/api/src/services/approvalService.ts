/**
 * Two gates on re-running an already-submitted day, stacked — both must
 * pass, in this order:
 *
 * 1. `assertNotLockedByNextDay` — a hard, absolute lock: once the very next
 *    calendar day has itself been submitted, this day can never be
 *    resubmitted by anyone, admin included. There is no approval path
 *    around it (unlike gate 2 below) — once time has moved past a day, its
 *    books are sealed. A day that was never submitted, or whose next day
 *    hasn't been submitted (yet, or ever — days can now be done out of
 *    order, see the removed sequential date gate), has nothing to lock.
 *
 * 2. `assertReconAllowed` — the softer, approvable gate: re-running
 *    reconciliation for the same outlet+business-date is always allowed
 *    while nothing has been submitted yet. The gate only fires once a
 *    session for that exact pair has already been *submitted*: a GM (never
 *    an admin — admins are the approvers) is then blocked from submitting
 *    again without sign-off, which guards against uploading the wrong
 *    files, not noticing, submitting, and only then wanting a redo. Once an
 *    admin approves a request for that exact pair, it stays unlocked — not
 *    single-use — so a GM fixing a genuine mistake isn't gated again on the
 *    very next attempt.
 */

import { randomUUID } from 'node:crypto';
import type { ApprovalRequestDTO } from '@toit/contracts';
import type { OutletCode } from '@toit/recon-core';
import { getApprovalStore, getSessionStore } from '../storage/index.js';

export class ApprovalRequiredError extends Error {
  readonly status = 409;
  constructor(
    message: string,
    readonly outlet: OutletCode,
    readonly businessDate: string,
  ) {
    super(message);
    this.name = 'ApprovalRequiredError';
  }
}

export class ResubmissionLockedError extends Error {
  readonly status = 409;
  constructor(
    message: string,
    readonly outlet: OutletCode,
    readonly businessDate: string,
  ) {
    super(message);
    this.name = 'ResubmissionLockedError';
  }
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Throws `ResubmissionLockedError` if `businessDate` has already been
 * submitted AND the day right after it has also already been submitted.
 * Checked for every role, including admin — this is the one gate in this
 * file with no approval path around it.
 */
export async function assertNotLockedByNextDay(outlet: OutletCode, businessDate: string | null): Promise<void> {
  if (!businessDate) return;

  const submitted = await getSessionStore().list({ outlet, status: 'submitted' });
  const alreadySubmitted = submitted.some((s) => s.businessDate === businessDate);
  if (!alreadySubmitted) return; // first-time submission, not a resubmission — nothing to lock.

  const nextDay = addDays(businessDate, 1);
  const nextDaySubmitted = submitted.some((s) => s.businessDate === nextDay);
  if (!nextDaySubmitted) return;

  throw new ResubmissionLockedError(
    `Submission for ${businessDate} is locked — ${nextDay} has already been submitted. No approval can unlock this.`,
    outlet,
    businessDate,
  );
}

/** Throws `ApprovalRequiredError` if this outlet+date already has a session and no approval covers it. Callers only need to check this for `role === 'gm'` — admins are exempt. */
export async function assertReconAllowed(outlet: OutletCode, businessDate: string | null): Promise<void> {
  if (!businessDate) return; // nothing to key the gate on — let it through, matching legacy's own tolerance for an unparseable date.

  const existing = await getSessionStore().list({ outlet, status: 'submitted' });
  const alreadySubmitted = existing.some((s) => s.businessDate === businessDate);
  if (!alreadySubmitted) return;

  const approvals = await getApprovalStore().list({ outlet, status: 'approved' });
  const covered = approvals.some((a) => a.businessDate === businessDate);
  if (covered) return;

  throw new ApprovalRequiredError(
    `${outlet} has already been submitted for ${businessDate} today. Ask an admin to approve a re-run.`,
    outlet,
    businessDate,
  );
}

export async function createApprovalRequest(
  outlet: OutletCode,
  businessDate: string,
  reason: string | null,
  requestedBy: string,
): Promise<ApprovalRequestDTO> {
  const request: ApprovalRequestDTO = {
    id: randomUUID(),
    outlet,
    businessDate,
    requestedBy,
    requestedAt: new Date().toISOString(),
    reason,
    status: 'pending',
    decidedBy: null,
    decidedAt: null,
  };
  return getApprovalStore().create(request);
}
