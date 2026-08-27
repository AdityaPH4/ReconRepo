'use client';

/**
 * Top-level workspace state machine.
 *
 * Mirrors the legacy tool's two states — upload, then results. The results half
 * lives in `SessionWorkspace` so a stored session can be reopened at
 * `/sessions/[id]` and render identically.
 */

import type { SessionDTO } from '@toit/contracts';
import { useState } from 'react';
import { Header } from '@/components/Header';
import { SessionWorkspace } from '@/components/SessionWorkspace';
import { UploadPanel, type SelectedFiles } from '@/components/UploadPanel';
import { ApiError, createSession } from '@/lib/api';

export function ReconciliationApp() {
  const [files, setFiles] = useState<SelectedFiles>({});
  const [session, setSession] = useState<SessionDTO | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!files.pr || !files.zip) return;
    setRunning(true);
    setError(null);
    try {
      const dto = await createSession({
        pr: files.pr,
        zip: files.zip,
        sum: files.sum,
        hdfc: files.hdfc,
      });
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
    setFiles({});
    setError(null);
  }

  const subtitle = session
    ? `Business date: ${session.meta.businessDate ?? '—'}`
    : 'Upload files to begin';

  return (
    <>
      <Header meta={session?.meta ?? null} subtitle={subtitle} />

      {session ? (
        <SessionWorkspace session={session} onNewUpload={reset} />
      ) : (
        <main className="app-main">
          <UploadPanel
            files={files}
            onFilesChange={setFiles}
            onRun={run}
            onClear={() => {
              setFiles({});
              setError(null);
            }}
            running={running}
            error={error}
          />
        </main>
      )}
    </>
  );
}
