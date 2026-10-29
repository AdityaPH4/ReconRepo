/**
 * The only module that talks to the MPR (Layer 2) API.
 * Kept separate from `lib/api.ts` for module clarity — this is a genuinely
 * separate tool from Payment Reconciliation, sharing only the API origin.
 */

import type {
  AddMprRowCommentRequest,
  CloseMprRowRequest,
  GmMprStatusDTO,
  MprOpenRowDTO,
  MprSessionDTO,
} from '@toit/contracts';
import { authHeaders, getToken } from './auth';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

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
  let message = `${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) message = body.error;
  } catch {
    /* no JSON body */
  }
  throw new ApiError(message, res.status);
}

export async function getMprSession(id: string): Promise<MprSessionDTO> {
  const res = await fetch(`${API_BASE}/api/mpr-sessions/${id}`, { cache: 'no-store', headers: authHeaders() });
  return unwrap<MprSessionDTO>(res);
}

/** URL for the CSV export — used directly as an `<a href>`, not fetched here; the token rides along as `?token=` since a plain link can't carry a header. */
export function mprExportCsvUrl(id: string): string {
  const token = getToken();
  return `${API_BASE}/api/mpr-sessions/${id}/export.csv${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}

/** Every still-open row across all runs — admin-only, backs the open-items queue and its home-page badge count. */
export async function listOpenMprRows(): Promise<MprOpenRowDTO[]> {
  const res = await fetch(`${API_BASE}/api/mpr-sessions/open-rows`, { cache: 'no-store', headers: authHeaders() });
  return unwrap<MprOpenRowDTO[]>(res);
}

/** A GM's own outlet-scoped MPR status — replaces the upload/run screen for them, since MPR is now fully automated. */
export async function getGmMprStatus(): Promise<GmMprStatusDTO> {
  const res = await fetch(`${API_BASE}/api/mpr-sessions/gm-status`, { cache: 'no-store', headers: authHeaders() });
  return unwrap<GmMprStatusDTO>(res);
}

/** A GM's own outlet, pooled across every stored run, for one business date — the day-wise drill-down from their dashboard's date picker. */
export async function getGmMprDaySession(date: string): Promise<MprSessionDTO> {
  const res = await fetch(`${API_BASE}/api/mpr-sessions/gm-day?date=${encodeURIComponent(date)}`, {
    cache: 'no-store',
    headers: authHeaders(),
  });
  return unwrap<MprSessionDTO>(res);
}

/** One outlet (or every outlet, for `outlet: 'ALL'`), pooled across every stored run, for one business date — admin-only, backs the main dashboard's outlet + date pickers. */
export async function getAdminMprDaySession(date: string, outlet: string): Promise<MprSessionDTO> {
  const res = await fetch(
    `${API_BASE}/api/mpr-sessions/day?date=${encodeURIComponent(date)}&outlet=${encodeURIComponent(outlet)}`,
    { cache: 'no-store', headers: authHeaders() },
  );
  return unwrap<MprSessionDTO>(res);
}

/** URL for the admin day session's CSV export — same `?token=` pattern as `mprExportCsvUrl`. */
export function mprDayExportCsvUrl(date: string, outlet: string): string {
  const token = getToken();
  return `${API_BASE}/api/mpr-sessions/day/export.csv?date=${encodeURIComponent(date)}&outlet=${encodeURIComponent(outlet)}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
}

/** Resolves one open row with a required note. Admin-only. */
export async function closeMprRow(sessionId: string, rowId: string, note: string): Promise<MprSessionDTO> {
  const body: CloseMprRowRequest = { note };
  const res = await fetch(`${API_BASE}/api/mpr-sessions/${sessionId}/rows/${rowId}/close`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  return unwrap<MprSessionDTO>(res);
}

/** Adds a comment to an open row. Open to anyone who can view the MPR module — not admin-only. */
export async function addMprRowComment(sessionId: string, rowId: string, text: string): Promise<MprSessionDTO> {
  const body: AddMprRowCommentRequest = { text };
  const res = await fetch(`${API_BASE}/api/mpr-sessions/${sessionId}/rows/${rowId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  return unwrap<MprSessionDTO>(res);
}
