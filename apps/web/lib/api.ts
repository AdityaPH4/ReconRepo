/**
 * The only module that talks HTTP.
 *
 * Components call these functions; nothing else in the web app knows the API's
 * URL shape. Keeps the frontend/backend seam in one reviewable place.
 */

import type {
  AddBohStagingRequest,
  AddJustificationEntryRequest,
  ApiErrorDTO,
  ApplyAdvanceRequest,
  ApprovalRequestDTO,
  ClearBohRequest,
  CurrentUserDTO,
  DashboardDTO,
  EligibleAdvanceDTO,
  EligibleBohEntryDTO,
  RecordAdvanceRequest,
  RequestApprovalRequest,
  SessionDTO,
  SessionListItemDTO,
  ToggleSquareOffRequest,
} from '@toit/contracts';
import type { OutletCode } from '@toit/recon-core/display';
import { authHeaders, getToken } from './auth';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * An API error carrying the server's message, so the UI can show it
 * verbatim. `code`/`outlet`/`businessDate` are set only for the
 * "already reconciled today" block — see `ApiErrorDTO`.
 */
export class ApiError extends Error {
  readonly code?: ApiErrorDTO['code'];
  readonly outlet?: OutletCode;
  readonly businessDate?: string;

  constructor(
    message: string,
    readonly status: number,
    extra?: Pick<ApiErrorDTO, 'code' | 'outlet' | 'businessDate'>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = extra?.code;
    this.outlet = extra?.outlet;
    this.businessDate = extra?.businessDate;
  }
}

async function unwrap<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;

  // Prefer the server's own message; fall back to the status line.
  let message = `${res.status} ${res.statusText}`;
  let body: ApiErrorDTO | undefined;
  try {
    body = (await res.json()) as ApiErrorDTO;
    if (body.error) message = body.error;
  } catch {
    /* response had no JSON body */
  }
  throw new ApiError(message, res.status, body);
}

export interface RunFiles {
  pr: File;
  zip: File;
  sum?: File | undefined;
  hdfc?: File | undefined;
}

/** Uploads the source files and runs a reconciliation. */
export async function createSession(files: RunFiles): Promise<SessionDTO> {
  const fd = new FormData();
  fd.append('pr', files.pr);
  fd.append('zip', files.zip);
  if (files.sum) fd.append('sum', files.sum);
  if (files.hdfc) fd.append('hdfc', files.hdfc);

  const res = await fetch(`${API_BASE}/api/sessions`, { method: 'POST', body: fd, headers: authHeaders() });
  return unwrap<SessionDTO>(res);
}

export async function getSession(id: string): Promise<SessionDTO> {
  const res = await fetch(`${API_BASE}/api/sessions/${id}`, { cache: 'no-store', headers: authHeaders() });
  return unwrap<SessionDTO>(res);
}

export async function listSessions(): Promise<SessionListItemDTO[]> {
  const res = await fetch(`${API_BASE}/api/sessions`, { cache: 'no-store', headers: authHeaders() });
  return unwrap<SessionListItemDTO[]>(res);
}

// ── Justification & submit layer ──────────────────────────────────────────

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  return unwrap<T>(res);
}

async function deleteJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'DELETE',
    headers: body ? { 'Content-Type': 'application/json', ...authHeaders() } : authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  return unwrap<T>(res);
}

function justificationUrl(sessionId: string, path: string): string {
  return `${API_BASE}/api/sessions/${sessionId}/justification${path}`;
}

export function addJustificationEntry(
  sessionId: string,
  body: AddJustificationEntryRequest,
): Promise<SessionDTO> {
  return postJson(justificationUrl(sessionId, '/entries'), body);
}

export function removeJustificationEntry(sessionId: string, entryId: string): Promise<SessionDTO> {
  return deleteJson(justificationUrl(sessionId, `/entries/${entryId}`));
}

export function setSquareOff(
  sessionId: string,
  body: ToggleSquareOffRequest,
  on: boolean,
): Promise<SessionDTO> {
  return on
    ? postJson(justificationUrl(sessionId, '/square-off'), body)
    : deleteJson(justificationUrl(sessionId, '/square-off'), body);
}

export function recordAdvance(sessionId: string, body: RecordAdvanceRequest): Promise<SessionDTO> {
  return postJson(justificationUrl(sessionId, '/advances'), body);
}

export function applyAdvance(sessionId: string, body: ApplyAdvanceRequest): Promise<SessionDTO> {
  return postJson(justificationUrl(sessionId, '/advances/apply'), body);
}

export function addBohStaging(sessionId: string, body: AddBohStagingRequest): Promise<SessionDTO> {
  return postJson(justificationUrl(sessionId, '/boh-staging'), body);
}

export function removeBohStaging(sessionId: string, stagingId: string): Promise<SessionDTO> {
  return deleteJson(justificationUrl(sessionId, `/boh-staging/${stagingId}`));
}

export function clearBoh(sessionId: string, body: ClearBohRequest): Promise<SessionDTO> {
  return postJson(justificationUrl(sessionId, '/boh/clear'), body);
}

export async function listEligibleAdvances(
  sessionId: string,
  amount?: number,
): Promise<EligibleAdvanceDTO[]> {
  const params = new URLSearchParams({ sessionId });
  if (amount !== undefined) params.set('amount', String(amount));
  const res = await fetch(`${API_BASE}/api/advances/eligible?${params}`, { cache: 'no-store', headers: authHeaders() });
  return unwrap(res);
}

export async function listEligibleBoh(
  sessionId: string,
  opts: { includeToday?: boolean; amount?: number } = {},
): Promise<EligibleBohEntryDTO[]> {
  const params = new URLSearchParams({ sessionId });
  if (opts.includeToday) params.set('includeToday', 'true');
  if (opts.amount !== undefined) params.set('amount', String(opts.amount));
  const res = await fetch(`${API_BASE}/api/boh/eligible?${params}`, { cache: 'no-store', headers: authHeaders() });
  return unwrap(res);
}

export function submitSession(sessionId: string): Promise<SessionDTO> {
  return postJson(`${API_BASE}/api/sessions/${sessionId}/submit`, undefined);
}

/**
 * URL for the printable report — used directly as an `<a href>`, not fetched
 * here, so it can't carry an `Authorization` header; the token rides along
 * as `?token=` instead (`attachUser` accepts either).
 */
export function reportUrl(sessionId: string): string {
  const token = getToken();
  return `${API_BASE}/api/sessions/${sessionId}/report${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}

/** URL for the raw settlement snapshot JSON — the MPR (Layer 2) module's "Recon Snapshots" input. Same `?token=` reasoning as `reportUrl`. */
export function snapshotUrl(sessionId: string): string {
  const token = getToken();
  return `${API_BASE}/api/sessions/${sessionId}/snapshot.json${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}

// ── Approval workflow ─────────────────────────────────────────────────────

export function requestApproval(body: RequestApprovalRequest): Promise<ApprovalRequestDTO> {
  return postJson(`${API_BASE}/api/approval-requests`, body);
}

export async function listApprovalRequests(opts: { status?: string; outlet?: OutletCode } = {}): Promise<
  ApprovalRequestDTO[]
> {
  const params = new URLSearchParams();
  if (opts.status) params.set('status', opts.status);
  if (opts.outlet) params.set('outlet', opts.outlet);
  const qs = params.toString();
  const res = await fetch(`${API_BASE}/api/approval-requests${qs ? `?${qs}` : ''}`, {
    cache: 'no-store',
    headers: authHeaders(),
  });
  return unwrap(res);
}

export function approveRequest(id: string): Promise<ApprovalRequestDTO> {
  return postJson(`${API_BASE}/api/approval-requests/${id}/approve`, undefined);
}

export function denyRequest(id: string): Promise<ApprovalRequestDTO> {
  return postJson(`${API_BASE}/api/approval-requests/${id}/deny`, undefined);
}

export async function getDashboard(outlet?: OutletCode): Promise<DashboardDTO> {
  const params = outlet ? `?outlet=${outlet}` : '';
  const res = await fetch(`${API_BASE}/api/dashboard${params}`, { cache: 'no-store', headers: authHeaders() });
  return unwrap(res);
}

export async function getMe(): Promise<CurrentUserDTO> {
  const res = await fetch(`${API_BASE}/api/me`, { cache: 'no-store', headers: authHeaders() });
  return unwrap<CurrentUserDTO>(res);
}

export async function checkHealth(): Promise<{
  ok: boolean;
  objectStore: string;
  sessionStore: string;
  authEnabled: boolean;
}> {
  const res = await fetch(`${API_BASE}/api/health`, { cache: 'no-store' });
  return unwrap(res);
}
