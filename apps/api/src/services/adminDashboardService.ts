/**
 * Admin dashboard — cross-outlet Bills-on-hold and Open-advances exposure,
 * submission timeliness, and a Justifications review feed. Mounted at
 * `/api/admin/dashboard`, admin-only.
 *
 * No month picker yet — always the current calendar month, matching the GM
 * dashboard's own Tips panel ("just show the current window").
 */

import { OUTLET_CODES, OUTLET_NAMES, REMARKS_ALL, advanceBalance } from '@toit/recon-core';
import type { Advance, AdvanceApplication, JustificationEntry } from '@toit/recon-core';
import type {
  AdminAdvancesSummaryDTO,
  AdminBohSummaryDTO,
  AdminCommentDTO,
  AdminDashboardDTO,
  AdminJustificationCountDTO,
  AdminOutletAdvanceSummaryDTO,
  AdminOutletBohSummaryDTO,
  OutletSubmissionsDTO,
  SessionDTO,
} from '@toit/contracts';
import { config } from '../config.js';
import { getAdvanceStore, getBohStore, getSessionStore } from '../storage/index.js';
import { buildBohAging, worstBohBucket } from './bohAging.js';
import { buildOutletSubmissionDays } from './submissionCalendar.js';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Every distinct `Remark` value — `REMARKS_ALL` itself repeats 'Other' (shared by the excess and shortage vocabularies), so this dedupes; 'Paid In'/'Paid Out'/'TDS Deducted' aren't in that array at all (see `Remark`'s own type definition). */
const ALL_REMARKS: readonly string[] = [...new Set([...REMARKS_ALL, 'Paid In', 'Paid Out', 'TDS Deducted'])];

/** Inverts the `GM_OUTLETS` allowlist (`email -> outlet`) into `outlet -> email[]` — never exposed via any API until now. */
function gmEmailsByOutlet(): Record<string, string[]> {
  const out: Record<string, string[]> = Object.fromEntries(OUTLET_CODES.map((o) => [o, [] as string[]]));
  for (const [email, outlet] of config.auth.gmOutlets) {
    out[outlet]!.push(email);
  }
  return out;
}

/**
 * `routes/sessions.ts`'s submit handler spreads the original `session` onto
 * the final submitted one (`{ ...session, meta: {...}, snapshot, ... }`) —
 * `justification.draftAdvances`/`draftApplications`/`draftBohClearances`
 * are never cleared, submitted or not. So the draft-array lookup below
 * always resolves first, for every session; the `snapshot` fallback is
 * belt-and-suspenders for a session shape this code doesn't otherwise
 * expect (e.g. a future change that does start clearing those arrays),
 * not a path exercised today.
 */
/**
 * `advanceId` may belong to this session's own draft create (`recordAdvance`
 * always creates the `Advance` and its entry together, same session), or —
 * the common case for "Advance Applied" below — to a wholly different,
 * earlier session that first recorded it. `allAdvances` (every committed
 * advance, outlet-unfiltered — already fetched once for the Advances card)
 * covers that; the session's own draft array is checked first only because
 * it can be ahead of the store by definition (not yet committed).
 */
function findAdvanceCustName(session: SessionDTO, advanceId: string | null, allAdvances: readonly Advance[]): string | null {
  if (!advanceId) return null;
  const draft = session.justification.draftAdvances.find((a) => a.id === advanceId);
  if (draft) return draft.custName;
  const committed = allAdvances.find((a) => a.id === advanceId) ?? session.snapshot?.advances.repository.find((a) => a.id === advanceId);
  return committed?.custName ?? null;
}

function findAppliedAdvanceCustName(
  session: SessionDTO,
  applicationId: string | null,
  targetKey: string | null,
  allAdvances: readonly Advance[],
): string | null {
  if (!applicationId) return null;
  const draftApp = session.justification.draftApplications.find((a) => a.id === applicationId);
  if (draftApp) return findAdvanceCustName(session, draftApp.advanceId, allAdvances);
  if (!targetKey) return null;
  return session.snapshot?.advances.applications.find((a) => a.targetKey === targetKey)?.advanceCustName ?? null;
}

function findBohClearedLabel(session: SessionDTO, clearanceId: string | null): string | null {
  if (!clearanceId) return null;
  const draft = session.justification.draftBohClearances.find((c) => c.id === clearanceId);
  if (draft) return `${draft.orderNo} — ${draft.custName}`;
  const committed = session.snapshot?.billsOnHold.cleared.find((c) => c.id === clearanceId);
  return committed?.orderNo ?? null;
}

/**
 * A remark-aware human-readable line for one justification entry — replaces
 * a flat `description || comment || notes || reason` fallback, which always
 * renders blank for "Advance Received," "Advance Applied," and "Bill on
 * Hold Cleared": none of those three ever populate any of those four fields
 * themselves (see each remark's own creating modal/service function) — their
 * real detail lives on the linked `Advance`/`AdvanceApplication`/
 * `BohClearance` record instead.
 */
function justificationText(e: JustificationEntry, session: SessionDTO, allAdvances: readonly Advance[]): string {
  switch (e.remark) {
    case 'Advance Received': {
      const name = findAdvanceCustName(session, e.createdAdvanceId, allAdvances);
      return name ? `Advance — ${name}` : '';
    }
    case 'Advance Applied': {
      const name = findAppliedAdvanceCustName(session, e.appliedApplicationId, e.targetKey, allAdvances);
      return name ? `Applied to ${name}'s advance` : '';
    }
    case 'Bill on Hold Cleared': {
      const label = findBohClearedLabel(session, e.bohClearanceId);
      return label ? `Bill ${label}` : '';
    }
    case 'Extra Payment Received':
      return [e.clientName, e.billNo ? `Bill ${e.billNo}` : null, e.notes].filter(Boolean).join(' — ');
    case 'Short Collection':
      return [e.staffName, e.empId ? `ID ${e.empId}` : null, e.notes].filter(Boolean).join(' — ');
    case 'Paid In':
    case 'Paid Out':
      return [e.billNo ? `Bill ${e.billNo}` : null, e.reason].filter(Boolean).join(' — ');
    case 'TDS Deducted':
      return [e.clientName, e.notes].filter(Boolean).join(' — ');
    default:
      // Tips, Other — unchanged: these are the only remarks that were ever
      // reliably self-contained on the entry itself.
      return e.description || e.comment || e.notes || e.reason || '';
  }
}

function openAdvancesByOutlet(advances: readonly Advance[], applications: readonly AdvanceApplication[]): AdminAdvancesSummaryDTO {
  const open = advances.filter((a) => a.status === 'open').map((a) => ({ advance: a, balance: advanceBalance(a, applications) }));
  const byOutlet: AdminOutletAdvanceSummaryDTO[] = OUTLET_CODES.map((outlet) => {
    const forOutlet = open.filter((a) => a.advance.outlet === outlet);
    return {
      outlet,
      outletName: OUTLET_NAMES[outlet],
      count: forOutlet.length,
      balance: forOutlet.reduce((sum, a) => sum + a.balance, 0),
    };
  });
  return {
    count: open.length,
    balance: open.reduce((sum, a) => sum + a.balance, 0),
    byOutlet,
  };
}

export async function buildAdminDashboard(): Promise<AdminDashboardDTO> {
  const store = getSessionStore();
  const today = todayIso();
  const month = today.slice(0, 7);
  const gmEmails = gmEmailsByOutlet();

  // Fetched once, up front — every outlet's Justifications walk needs this
  // for "Advance Applied" text (the advance it references is usually from
  // a different, earlier session), and the Advances card needs it anyway.
  const [allAdvances, allApplications] = await Promise.all([
    getAdvanceStore().list(null),
    getAdvanceStore().listApplications(null),
  ]);

  const submissions: OutletSubmissionsDTO[] = [];
  const allComments: AdminCommentDTO[] = [];
  const remarkCounts = new Map<string, { count: number; amount: number }>(ALL_REMARKS.map((r) => [r, { count: 0, amount: 0 }]));

  const bohByOutlet: AdminOutletBohSummaryDTO[] = [];
  let bohCountTotal = 0;
  let bohAmountTotal = 0;

  for (const outlet of OUTLET_CODES) {
    // One fetch, reused for both the submissions calendar and the comment
    // feed below — an internal tool with modest session volume, same
    // "walk N recent session blobs" cost already accepted by the MPR
    // open-rows aggregation and the GM dashboard's own Tips loop.
    const sessions = await store.list({ outlet, limit: 200 });

    // ── Submissions ──────────────────────────────────────────────────
    submissions.push(buildOutletSubmissionDays(sessions, outlet, OUTLET_NAMES[outlet], month, today, gmEmails[outlet]));

    // ── Bills on hold ───────────────────────────────────────────────
    const bohEntries = await getBohStore().list(outlet);
    const { bohAging, bohTotal } = buildBohAging(bohEntries, today);
    bohByOutlet.push({
      outlet,
      outletName: OUTLET_NAMES[outlet],
      count: bohTotal.count,
      amount: bohTotal.amount,
      worstBucket: worstBohBucket(bohAging),
    });
    bohCountTotal += bohTotal.count;
    bohAmountTotal += bohTotal.amount;

    // ── Justifications — bounded to the 60 most recent sessions per ──
    // outlet, "recent" not exhaustive.
    for (const item of sessions.slice(0, 60)) {
      const full = await store.get(item.id);
      if (!full) continue;
      for (const e of full.justification.entries) {
        const counts = remarkCounts.get(e.remark);
        if (counts) {
          counts.count += 1;
          counts.amount += e.amount;
        }
        const text = justificationText(e, full, allAdvances);
        if (!text.trim()) continue; // nothing to review
        allComments.push({
          id: e.id,
          sessionId: full.meta.id,
          outlet,
          businessDate: full.meta.businessDate,
          remark: e.remark,
          direction: e.direction,
          amount: e.amount,
          text,
          createdAt: e.createdAt,
          createdBy: full.meta.createdBy,
        });
      }
    }
  }

  allComments.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const boh: AdminBohSummaryDTO = { count: bohCountTotal, amount: bohAmountTotal, byOutlet: bohByOutlet };
  const advances = openAdvancesByOutlet(allAdvances, allApplications);

  const justificationCounts: AdminJustificationCountDTO[] = ALL_REMARKS.map((remark) => ({
    remark,
    ...remarkCounts.get(remark)!,
  }));

  return { month, submissions, boh, advances, justificationCounts, recentComments: allComments.slice(0, 50) };
}
