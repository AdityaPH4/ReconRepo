'use client';

/**
 * Top-level workspace state machine.
 *
 * Mirrors the legacy tool's two states — upload, then results. The results half
 * lives in `SessionWorkspace` so a stored session can be reopened at
 * `/sessions/[id]` and render identically.
 */

import type { OutletCode } from '@toit/recon-core/display';
import type { SessionDTO } from '@toit/contracts';
import { useState } from 'react';
import { Dashboard } from '@/components/Dashboard';
import { Header } from '@/components/Header';
import { SessionWorkspace } from '@/components/SessionWorkspace';
import { UploadPanel, type SelectedFiles } from '@/components/UploadPanel';
import { ApiError, createSession, requestApproval } from '@/lib/api';

interface ApprovalBlock {
  outlet: OutletCode;
  businessDate: string;
  requested: boolean;
}

export function ReconciliationApp() {
  const [files, setFiles] = useState<SelectedFiles>({});
  const [session, setSession] = useState<SessionDTO | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approvalBlock, setApprovalBlock] = useState<ApprovalBlock | null>(null);

  async function run() {
    if (!files.pr || !files.zip) return;
    setRunning(true);
    setError(null);
    setApprovalBlock(null);
    try {
      const dto = await createSession({
        pr: files.pr,
        zip: files.zip,
        sum: files.sum,
        hdfc: files.hdfc,
      });
      setSession(dto);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'APPROVAL_REQUIRED' && err.outlet && err.businessDate) {
        setApprovalBlock({ outlet: err.outlet, businessDate: err.businessDate, requested: false });
        setError(err.message);
      } else {
        setError(
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? `Could not reach the API — is it running on port 4000? (${err.message})`
              : 'Unknown error',
        );
      }
    } finally {
      setRunning(false);
    }
  }

  async function askForApproval() {
    if (!approvalBlock) return;
    try {
      await requestApproval({ outlet: approvalBlock.outlet, businessDate: approvalBlock.businessDate, reason: null });
      setApprovalBlock({ ...approvalBlock, requested: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to request approval.');
    }
  }

  function reset() {
    setSession(null);
    setFiles({});
    setError(null);
    setApprovalBlock(null);
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
          <Dashboard />
          <UploadPanel
            files={files}
            onFilesChange={setFiles}
            onRun={run}
            onClear={() => {
              setFiles({});
              setError(null);
              setApprovalBlock(null);
            }}
            running={running}
            error={error}
            approvalBlock={approvalBlock}
            onRequestApproval={askForApproval}
          />
        </main>
      )}
    </>
  );
}
