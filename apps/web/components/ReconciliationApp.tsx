'use client';

/**
 * Top-level workspace state machine.
 *
 * Mirrors the legacy tool's two states — upload, then results. The results half
 * lives in `SessionWorkspace` so a stored session can be reopened at
 * `/sessions/[id]` and render identically.
 */

import type { OutletCode } from '@toit/recon-core/display';
import type { DashboardDTO, SessionDTO } from '@toit/contracts';
import { useState } from 'react';
import { Dashboard } from '@/components/Dashboard';
import { Header } from '@/components/Header';
import { PastSessionsList } from '@/components/PastSessionsList';
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
  const [dashboard, setDashboard] = useState<DashboardDTO | null>(null);

  async function run() {
    if (!files.pr || !files.zip) return;
    // An unsubmitted draft already exists for today — offer to return to it
    // instead of silently piling up a second one. Proceeding here is safe:
    // the backend discards the old draft as soon as the new one is created.
    if (dashboard?.todayStatus.status === 'draft' && dashboard.todayStatus.sessionId) {
      const proceed = window.confirm(
        `You already have an unsubmitted draft for ${dashboard.outlet} on ${dashboard.today}.\n\n` +
          `Click OK to discard it and continue with these new files, or Cancel to go back to your existing draft instead.`,
      );
      if (!proceed) {
        window.location.href = `/recon/sessions/${dashboard.todayStatus.sessionId}`;
        return;
      }
    }
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
          <Dashboard onLoad={setDashboard} />
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
          <PastSessionsList />
        </main>
      )}
    </>
  );
}
