/**
 * The only module that talks to the MPR (Layer 2) API.
 * Kept separate from `lib/api.ts` for module clarity — this is a genuinely
 * separate tool from Payment Reconciliation, sharing only the API origin.
 */

import type { MprSessionDTO, MprSessionListItemDTO } from '@toit/contracts';
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

export interface MprRunFiles {
  json: File[];
  mpr: File[];
}

/** Uploads Layer-1 JSON snapshots + bank MPR files and runs the Layer-2 match. */
export async function runMprReconciliation(files: MprRunFiles): Promise<MprSessionDTO> {
  const fd = new FormData();
  for (const f of files.json) fd.append('json', f);
  for (const f of files.mpr) fd.append('mpr', f);

  const res = await fetch(`${API_BASE}/api/mpr-sessions`, { method: 'POST', body: fd, headers: authHeaders() });
  return unwrap<MprSessionDTO>(res);
}

export async function getMprSession(id: string): Promise<MprSessionDTO> {
  const res = await fetch(`${API_BASE}/api/mpr-sessions/${id}`, { cache: 'no-store', headers: authHeaders() });
  return unwrap<MprSessionDTO>(res);
}

export async function listMprSessions(): Promise<MprSessionListItemDTO[]> {
  const res = await fetch(`${API_BASE}/api/mpr-sessions`, { cache: 'no-store', headers: authHeaders() });
  return unwrap<MprSessionListItemDTO[]>(res);
}

/** URL for the CSV export — used directly as an `<a href>`, not fetched here; the token rides along as `?token=` since a plain link can't carry a header. */
export function mprExportCsvUrl(id: string): string {
  const token = getToken();
  return `${API_BASE}/api/mpr-sessions/${id}/export.csv${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}
