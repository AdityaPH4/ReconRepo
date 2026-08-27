'use client';

/**
 * Upload screen.
 * Ported from `reconciliation (68).html` lines 294–337, with the drag/drop and
 * role-detection behaviour of lines 556–654.
 *
 * The workflow is unchanged: drop or browse for files, they are auto-assigned to
 * roles by filename, the run button unlocks once the Payment Report and the ZIP
 * are both present, and the HDFC statement stays a separate optional slot.
 */

import type { UploadRole } from '@toit/contracts';
import { useCallback, useRef, useState } from 'react';
import { ROLE_ICONS, ROLE_LABELS, detectRole } from '@/lib/detectRole';

export type SelectedFiles = Partial<Record<UploadRole, File>>;

interface Props {
  files: SelectedFiles;
  onFilesChange: (files: SelectedFiles) => void;
  onRun: () => void;
  onClear: () => void;
  running: boolean;
  error: string | null;
}

/** Kept off-screen rather than `display:none` so labels and keyboard focus work. */
const HIDDEN_INPUT = 'fixed -top-[9999px] -left-[9999px] opacity-0';

export function UploadPanel({
  files,
  onFilesChange,
  onRun,
  onClear,
  running,
  error,
}: Props) {
  const mainInput = useRef<HTMLInputElement>(null);
  const hdfcInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [unrecognised, setUnrecognised] = useState<string[]>([]);

  const accept = useCallback(
    (incoming: FileList | null) => {
      if (!incoming || incoming.length === 0) return;
      const next: SelectedFiles = { ...files };
      const rejected: string[] = [];

      for (const f of Array.from(incoming)) {
        const role = detectRole(f.name);
        if (role) next[role] = f;
        else rejected.push(f.name);
      }

      setUnrecognised(rejected);
      onFilesChange(next);
    },
    [files, onFilesChange],
  );

  function removeFile(role: UploadRole) {
    const next = { ...files };
    delete next[role];
    onFilesChange(next);
    // Clear the input so re-selecting the same file still fires a change event.
    if (role === 'hdfc' && hdfcInput.current) hdfcInput.current.value = '';
    else if (mainInput.current) mainInput.current.value = '';
  }

  const ready = Boolean(files.pr && files.zip);
  const missing: string[] = [];
  if (!files.pr) missing.push('Payment Report');
  if (!files.zip) missing.push('All Transactions ZIP');

  const hint = ready
    ? files.sum
      ? 'All files ready.'
      : 'Payment Summary optional — proceed without it.'
    : 'Still needed: ' + missing.join(', ');

  const requiredPills = (['pr', 'zip', 'sum'] as const).filter((r) => files[r]);

  return (
    <div className="card mb-6">
      <div className="card-body">
        <p className="eyebrow mb-2">Required</p>

        <input
          ref={mainInput}
          type="file"
          multiple
          accept=".csv,.zip"
          className={HIDDEN_INPUT}
          onChange={(e) => {
            accept(e.target.files);
            e.target.value = '';
          }}
        />

        <div
          className={`dropzone${dragging ? ' dropzone-active' : ''}`}
          onClick={() => mainInput.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            accept(e.dataTransfer.files);
          }}
        >
          <div className="dropzone-icon">📂</div>
          <div className="dropzone-title">Drop files here or click anywhere in this box</div>
          <div className="dropzone-sub mt-2">
            <span className="faux-btn">📁 Browse files</span>
            <span className="ml-2">
              Payment Report (CSV) · All Transactions (ZIP) · Payment Summary (CSV)
            </span>
          </div>
        </div>

        {requiredPills.length > 0 && (
          <div className="file-grid">
            {requiredPills.map((role) => (
              <FilePill
                key={role}
                role={role}
                file={files[role]!}
                onRemove={() => removeFile(role)}
              />
            ))}
          </div>
        )}

        {!ready && (
          <div className="alert alert-warn mt-2 text-tiny">
            <span>⚠</span>
            <span>Still needed: {missing.join(', ')}</span>
          </div>
        )}

        {unrecognised.length > 0 && (
          <div className="alert alert-info mt-2 text-tiny">
            <span>ℹ</span>
            <span>Not recognised (check filename): {unrecognised.join(', ')}</span>
          </div>
        )}

        <p className="eyebrow mt-5 mb-2">Optional</p>

        <input
          ref={hdfcInput}
          type="file"
          accept=".xlsx"
          className={HIDDEN_INPUT}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFilesChange({ ...files, hdfc: f });
          }}
        />

        <div
          className="dropzone dropzone-slim"
          onClick={() => hdfcInput.current?.click()}
        >
          <div className="flex items-center gap-3">
            <span className="text-figure">📶</span>
            <div className="flex-1 text-left">
              <div className="dropzone-title text-body mb-0">
                HDFC UPI Statement (.xlsx)
              </div>
              <div className="dropzone-sub mt-0.5 text-tiny">
                If provided, Static UPI is reconciled transaction-by-transaction like
                Pinelabs. If skipped, today&apos;s aggregate-total flow is used as-is.
              </div>
            </div>
            <span className="faux-btn-quiet">📁 Browse</span>
          </div>
        </div>

        {files.hdfc && (
          <div className="mt-2">
            <FilePill role="hdfc" file={files.hdfc} onRemove={() => removeFile('hdfc')} />
          </div>
        )}

        {error && (
          <div className="alert alert-err mt-4">
            <span>✕</span>
            <span>{error}</span>
          </div>
        )}

        <div className="btn-row">
          <button
            className="btn btn-primary"
            disabled={!ready || running}
            onClick={onRun}
            type="button"
          >
            {running ? (
              <>
                <span className="spin">⟳</span> Processing…
              </>
            ) : (
              '▶ Run reconciliation'
            )}
          </button>
          <button className="btn" onClick={onClear} type="button" disabled={running}>
            ✕ Clear
          </button>
          <span className="hint">{hint}</span>
        </div>
      </div>
    </div>
  );
}

function FilePill({
  role,
  file,
  onRemove,
}: {
  role: UploadRole;
  file: File;
  onRemove: () => void;
}) {
  return (
    <div className="file-pill">
      <span className="file-pill-icon">{ROLE_ICONS[role]}</span>
      <div className="flex-1 min-w-0">
        <div className="file-pill-name">{file.name}</div>
        <div className="file-pill-meta">
          {ROLE_LABELS[role]} · {(file.size / 1024).toFixed(0)} KB
        </div>
      </div>
      <button
        className="file-pill-remove"
        title="Remove"
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
      >
        ✕
      </button>
    </div>
  );
}
