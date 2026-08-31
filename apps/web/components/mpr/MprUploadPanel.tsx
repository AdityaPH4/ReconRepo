'use client';

/**
 * MPR (Layer 2) upload screen.
 * Ported from `mpr-recon (10).html` lines 128–166 (the two dropzones) and
 * 368–399 (`loadFiles`).
 *
 * Unlike legacy, adapter detection happens server-side (parsing moved off
 * the client along with everything else in this port), so a file chip here
 * shows just its name until the run completes — there is no live per-file
 * "detected as Kotak MPR" preview before clicking Run, only after.
 */

import { useCallback, useRef, useState } from 'react';

export interface MprSelectedFiles {
  json: File[];
  mpr: File[];
}

interface Props {
  files: MprSelectedFiles;
  onFilesChange: (files: MprSelectedFiles) => void;
  onRun: () => void;
  running: boolean;
  error: string | null;
}

const HIDDEN_INPUT = 'fixed -top-[9999px] -left-[9999px] opacity-0';

export function MprUploadPanel({ files, onFilesChange, onRun, running, error }: Props) {
  const jsonInput = useRef<HTMLInputElement>(null);
  const mprInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState<'json' | 'mpr' | null>(null);

  const accept = useCallback(
    (incoming: FileList | null, kind: 'json' | 'mpr') => {
      if (!incoming || incoming.length === 0) return;
      const existing = files[kind];
      const names = new Set(existing.map((f) => f.name));
      const added = Array.from(incoming).filter((f) => !names.has(f.name));
      onFilesChange({ ...files, [kind]: [...existing, ...added] });
    },
    [files, onFilesChange],
  );

  function removeFile(kind: 'json' | 'mpr', name: string) {
    onFilesChange({ ...files, [kind]: files[kind].filter((f) => f.name !== name) });
  }

  const ready = files.json.length > 0 && files.mpr.length > 0;
  const hint = ready
    ? `${files.json.length} JSON session${files.json.length > 1 ? 's' : ''}, ${files.mpr.length} MPR file${files.mpr.length > 1 ? 's' : ''}`
    : 'Upload at least one JSON and one MPR file to begin';

  return (
    <div className="card mb-6">
      <div className="card-body">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <p className="eyebrow mb-2">Layer 1 — Recon Snapshots (JSON)</p>
            <input
              ref={jsonInput}
              type="file"
              multiple
              accept=".json"
              className={HIDDEN_INPUT}
              onChange={(e) => {
                accept(e.target.files, 'json');
                e.target.value = '';
              }}
            />
            <div
              className={`dropzone${dragging === 'json' ? ' dropzone-active' : ''}`}
              onClick={() => jsonInput.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging('json');
              }}
              onDragLeave={() => setDragging(null)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(null);
                accept(e.dataTransfer.files, 'json');
              }}
            >
              <div className="dropzone-icon">📋</div>
              <div className="dropzone-title">Drop JSON snapshots here</div>
              <div className="dropzone-sub mt-2">One per business date from the recon app</div>
            </div>
            <FileChips files={files.json} onRemove={(name) => removeFile('json', name)} icon="📋" />
          </div>

          <div>
            <p className="eyebrow mb-2">MPR Files (from banks)</p>
            <input
              ref={mprInput}
              type="file"
              multiple
              accept=".xlsx,.xls,.csv"
              className={HIDDEN_INPUT}
              onChange={(e) => {
                accept(e.target.files, 'mpr');
                e.target.value = '';
              }}
            />
            <div
              className={`dropzone${dragging === 'mpr' ? ' dropzone-active' : ''}`}
              onClick={() => mprInput.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging('mpr');
              }}
              onDragLeave={() => setDragging(null)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(null);
                accept(e.dataTransfer.files, 'mpr');
              }}
            >
              <div className="dropzone-icon">🏦</div>
              <div className="dropzone-title">Drop all MPR files here</div>
              <div className="dropzone-sub mt-2">Kotak, Pinelabs, AMEX, HDFC UPI — any count</div>
            </div>
            <FileChips files={files.mpr} onRemove={(name) => removeFile('mpr', name)} icon="🏦" />
          </div>
        </div>

        {error && (
          <div className="alert alert-err mt-2">
            <span>✕</span>
            <span>{error}</span>
          </div>
        )}

        <div className="btn-row">
          <button className="btn btn-primary" disabled={!ready || running} onClick={onRun} type="button">
            {running ? (
              <>
                <span className="spin">⟳</span> Reconciling…
              </>
            ) : (
              '▶ Run Reconciliation'
            )}
          </button>
          <span className="hint">{hint}</span>
        </div>
      </div>
    </div>
  );
}

function FileChips({ files, onRemove, icon }: { files: File[]; onRemove: (name: string) => void; icon: string }) {
  if (files.length === 0) return null;
  return (
    <div className="file-grid mt-2">
      {files.map((f) => (
        <div className="file-pill" key={f.name}>
          <span className="file-pill-icon">{icon}</span>
          <div className="flex-1 min-w-0">
            <div className="file-pill-name">{f.name}</div>
            <div className="file-pill-meta">{(f.size / 1024).toFixed(0)} KB</div>
          </div>
          <button
            className="file-pill-remove"
            title="Remove"
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove(f.name);
            }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
