'use client';

/**
 * MPR (Layer 2) top-level workspace state machine — mirrors
 * `ReconciliationApp.tsx`'s upload/results split, plus a list of past runs
 * since (unlike legacy) these are persisted.
 */

import type { MprSessionDTO, MprSessionListItemDTO } from '@toit/contracts';
import { useEffect, useState } from 'react';
import { MprHeader } from '@/components/mpr/MprHeader';
import { MprUploadPanel, type MprSelectedFiles } from '@/components/mpr/MprUploadPanel';
import { MprWorkspace } from '@/components/mpr/MprWorkspace';
import { ApiError, listMprSessions, runMprReconciliation } from '@/lib/mprApi';

export function MprApp() {
  const [files, setFiles] = useState<MprSelectedFiles>({ json: [], mpr: [] });
  const [session, setSession] = useState<MprSessionDTO | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [past, setPast] = useState<MprSessionListItemDTO[] | null>(null);

  useEffect(() => {
    if (session) return;
    listMprSessions()
      .then(setPast)
      .catch(() => setPast([]));
  }, [session]);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const dto = await runMprReconciliation(files);
      setSession(dto);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? `Could not reach the API — is it running on port 4000? (${err.message})`
            : 'Unknown error',
      );
    } finally {
      setRunning(false);
    }
  }

  function reset() {
    setSession(null);
    setFiles({ json: [], mpr: [] });
    setError(null);
  }

  return (
    <>
      <MprHeader subtitle={session ? `${session.meta.businessDates.length} business date(s)` : 'Upload files to begin'} />

      {session ? (
        <main className="app-main">
          <div className="btn-row mb-4">
            <button className="btn" type="button" onClick={reset}>
              ↑ New upload
            </button>
          </div>
          <MprWorkspace session={session} />
        </main>
      ) : (
        <main className="app-main">
          <MprUploadPanel files={files} onFilesChange={setFiles} onRun={run} running={running} error={error} />

          {past && past.length > 0 && (
            <div className="panel">
              <div className="panel-section-title px-5 pt-5">Past runs</div>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Run date</th>
                    <th>Business dates</th>
                    <th>Outlets</th>
                    <th className="num">Settled</th>
                    <th className="num">Mismatch</th>
                    <th className="num">Pending</th>
                    <th className="num">Unexpected</th>
                  </tr>
                </thead>
                <tbody>
                  {past.map((s) => (
                    <tr key={s.id} className="cursor-pointer" onClick={() => (window.location.href = `/mpr/${s.id}`)}>
                      <td className="mono">{new Date(s.createdAt).toLocaleString('en-IN')}</td>
                      <td>{s.businessDates.join(', ') || '—'}</td>
                      <td>{s.outlets.join(', ') || '—'}</td>
                      <td className="num">{s.settledCount}</td>
                      <td className="num">{s.mismatchCount}</td>
                      <td className="num">{s.pendingCount}</td>
                      <td className="num">{s.unexpectedCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </main>
      )}
    </>
  );
}
