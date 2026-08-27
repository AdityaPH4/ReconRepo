/**
 * The only module that talks HTTP.
 *
 * Components call these functions; nothing else in the web app knows the API's
 * URL shape. Keeps the frontend/backend seam in one reviewable place.
 */

import type { SessionDTO, SessionListItemDTO } from '@toit/contracts';

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

export async function checkHealth(): Promise<{
  ok: boolean;
  objectStore: string;
  sessionStore: string;
  authEnabled: boolean;
}> {
  const res = await fetch(`${API_BASE}/api/health`, { cache: 'no-store' });
  return unwrap(res);
}
