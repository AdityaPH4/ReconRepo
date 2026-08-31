/**
 * The only module that talks HTTP.
 *
 * Components call these functions; nothing else in the web app knows the API's
 * URL shape. Keeps the frontend/backend seam in one reviewable place.
 */

import type {
  AddBohStagingRequest,
  AddJustificationEntryRequest,
  ApplyAdvanceRequest,
  ClearBohRequest,
  EligibleAdvanceDTO,
  EligibleBohEntryDTO,
  RecordAdvanceRequest,
  SessionDTO,
  SessionListItemDTO,
  ToggleSquareOffRequest,
} from '@toit/contracts';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/** An API error carrying the server's message, so the UI can show it verbatim. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function unwrap<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;

  // Prefer the server's own message; fall back to the status line.
  let message = `${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) message = body.error;
  } catch {
    /* response had no JSON body */
  }
  throw new ApiError(message, res.status);
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

  const res = await fetch(`${API_BASE}/api/sessions`, { method: 'POST', body: fd });
  return unwrap<SessionDTO>(res);
}

export async function getSession(id: string): Promise<SessionDTO> {
  const res = await fetch(`${API_BASE}/api/sessions/${id}`, { cache: 'no-store' });
  return unwrap<SessionDTO>(res);
}

export async function listSessions(): Promise<SessionListItemDTO[]> {
  const res = await fetch(`${API_BASE}/api/sessions`, { cache: 'no-store' });
  return unwrap<SessionListItemDTO[]>(res);
}

// ── Justification & submit layer ──────────────────────────────────────────

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return unwrap<T>(res);
}

async function deleteJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'DELETE',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
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
  const res = await fetch(`${API_BASE}/api/advances/eligible?${params}`, { cache: 'no-store' });
  return unwrap(res);
}

export async function listEligibleBoh(
  sessionId: string,
  opts: { includeToday?: boolean; amount?: number } = {},
): Promise<EligibleBohEntryDTO[]> {
  const params = new URLSearchParams({ sessionId });
  if (opts.includeToday) params.set('includeToday', 'true');
  if (opts.amount !== undefined) params.set('amount', String(opts.amount));
  const res = await fetch(`${API_BASE}/api/boh/eligible?${params}`, { cache: 'no-store' });
  return unwrap(res);
}

export function submitSession(sessionId: string): Promise<SessionDTO> {
  return postJson(`${API_BASE}/api/sessions/${sessionId}/submit`, undefined);
}

/** URL for the printable report — used directly as an `<a href>`, not fetched here. */
export function reportUrl(sessionId: string): string {
  return `${API_BASE}/api/sessions/${sessionId}/report`;
}

/** URL for the raw settlement snapshot JSON — the MPR (Layer 2) module's "Recon Snapshots" input. */
export function snapshotUrl(sessionId: string): string {
  return `${API_BASE}/api/sessions/${sessionId}/snapshot.json`;
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
