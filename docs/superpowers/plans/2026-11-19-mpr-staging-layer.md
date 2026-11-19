# MPR staging layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (native) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Bank rows from Kotak and HDFC UPI files are loaded into Postgres staging tables, filed by their own transaction date, matched against all open POS days, and deleted once reconciled; unmatched rows wait until their outlet's POS days are submitted.

**Architecture:** `mpr-ingest` gains a load step (file → staging rows → file moved to `processed/`), feeds staged rows to the unchanged `runMatch` as per-file inputs, then partitions each staged row into consumed / emitted / waiting. Banks not yet converted keep today's in-memory path.

**Tech Stack:** TypeScript (tsx + node:test), Postgres via `pg`, S3 via `@aws-sdk/client-s3`.

**Spec:** `docs/superpowers/specs/2026-11-19-mpr-staging-layer-design.md`

## Global Constraints
- Staged banks: `kotak`, `hdfc_upi` only (detected by `detectAdapter` → `KOTAK`, `HDFC_UPI`). Tables `recon.mpr_stage_kotak`, `recon.mpr_stage_hdfc_upi`, created `IF NOT EXISTS`.
- `packages/mpr-core/src/engine/match.ts` and `reconcileRetry.ts` are not changed.
- A row's day = its own transaction date (`yyyy-mm-dd`); file name / mail date is ignored.
- Unexpected / Duplicate-RRN rule: emit only when the row's outlet has a submitted POS day for **D and D-1**; a day before `MPR_START_DATE` counts as submitted; a terminal with no known outlet needs **every** outlet submitted; an unreadable date never emits.
- A file moves to `processed/` only after its rows are committed; a file that fails to parse moves to `MPR_S3_FAILED_PREFIX` (default `mpr-inbound/failed/`).
- Read `submittedDays` **before** `listPendingMpr`.
- Staged rows whose RRN is in `loadRecentSettledKeys` are dropped at load and swept every run.
- Delete consumed/emitted staged rows only after the accumulators are saved.
- No commit of scratch files (`apps/api/*.mjs` untracked, `sample_data/`, `backup-*.json`).

## Review Focus
1. Same file (or byte-identical copy) loaded twice → rows stored once (Task 1 store test; Task 3 scenario).
2. Twin rows inside one file → both kept, still surface as Duplicate RRN (Task 1, Task 2).
3. Unreadable transaction date → waits, never Unexpected (Task 2).
4. Terminal with no outlet → waits until every outlet has D and D-1 submitted (Task 2).
5. Database error mid-load → file stays in `pending/`, nothing lost (Task 3).

## File Structure
- `apps/api/src/storage/types.ts` — `StagedBank`, `StagedRowInput`, `StagedRow`, `MprStagingStore`; `SessionStore.submittedDays`.
- `apps/api/src/storage/memoryMprStagingStore.ts`, `postgres/postgresMprStagingStore.ts` — the two stores; wired in `storage/index.ts` as `getMprStagingStore()`.
- `apps/api/src/storage/postgres/schema.sql`, `apps/api/scripts/createMprStagingTables.mjs` — DDL.
- `apps/api/src/storage/ingestLock.ts` — `tryIngestLock()`.
- `apps/api/src/services/mailFetchLedger.ts` — `TERMINAL_OUTLETS`, `outletOfTerminal`.
- `apps/api/src/services/mprStaging.ts` — pure staging logic.
- `apps/api/src/services/mprService.ts`, `mprIngestService.ts`, `config.ts` — integration.
- `packages/mpr-core/src/types.ts` — `UnexpectedMprRow` gains optional `outlet`, `txnDate`.

### Task 1: Storage foundation
**Files:** Create the two stores, `ingestLock.ts`, `scripts/createMprStagingTables.mjs`, `test/mprStagingStore.test.ts`; modify `storage/types.ts`, `storage/index.ts`, both session stores, `schema.sql`, `config.ts`.

**Interfaces — Produces:**
```ts
export type StagedBank = 'kotak' | 'hdfc_upi';
export interface StagedRowInput { bank: StagedBank; identity: string; occurrence: number; rrn: string | null; txnDate: string | null; terminal: string; outlet: string | null; fileName: string; row: MprRow }
export interface StagedRow extends StagedRowInput { seq: number }
export interface MprStagingStore {
  readonly driver: 'memory' | 'postgres';
  insertRows(rows: StagedRowInput[]): Promise<number>;           // rows actually new; (bank, identity, occurrence) already staged is skipped
  listAll(): Promise<StagedRow[]>;                               // every bank, load order (seq) within each bank
  deleteByIdentity(bank: StagedBank, identities: string[]): Promise<number>; // every occurrence
  reset(): Promise<void>;
}
SessionStore.submittedDays(since: string): Promise<Set<string>>  // `${outlet}|${businessDate}`, status 'submitted', businessDate >= since
getMprStagingStore(): MprStagingStore;  tryIngestLock(): Promise<(() => Promise<void>) | null>;
config.mprMailbox.s3FailedPrefix  // MPR_S3_FAILED_PREFIX, default 'mpr-inbound/failed/'
```
- [ ] Write `test/mprStagingStore.test.ts` (memory + Postgres via `STAGING_TEST_DATABASE_URL`, pattern of `mprCounterStore.test.ts`): `inserts once` (insert the same input twice → returns 1 then 0, `listAll` length 1); `keeps twins` (occurrence 1 and 2 of one identity both stored); `lists in load order`; `deletes every occurrence of an identity and only that bank`; `reset empties`. Run: expect FAIL (modules missing).
- [ ] Implement the stores (Postgres: `INSERT … SELECT … FROM unnest(text[],int[],…, text[] data) ON CONFLICT (identity, occurrence) DO NOTHING`, data cast `::jsonb`; table by bank), DDL, script (undo comment `DROP TABLE recon.mpr_stage_kotak, recon.mpr_stage_hdfc_upi;`), `submittedDays` in both session stores, `tryIngestLock` (`pg_try_advisory_lock(hashtext('mpr-ingest'))` on a held pool client, released in the returned function; memory driver → no-op function), config key, wiring.
- [ ] Run `npm test --workspace @toit/api`: staging-store spec passes (memory). Commit.

### Task 2: Pure staging logic
**Files:** Create `services/mprStaging.ts`, `test/mprStaging.test.ts`; modify `mailFetchLedger.ts`, `packages/mpr-core/src/types.ts`.

**Interfaces — Produces:**
```ts
// mailFetchLedger.ts
export const TERMINAL_OUTLETS: Record<string, string>; // `${bank}|${terminal}` → outlet (spec's map)
export function outletOfTerminal(bank: 'kotak' | 'hdfc_upi', terminal: string): string | null;
// mprStaging.ts
export const STAGED_ADAPTERS: Partial<Record<AdapterKey, StagedBank>>;
export function rowIdentity(r: Pick<MprRow, '_source' | 'rrn' | 'grossAmount' | 'txnDateRaw' | 'txnDate' | 'settlementDate'>): string; // = match.ts identity
export function toStagedRows(parsed: ParsedMprFile, bank: StagedBank, originalName: string, startDate: string): StagedRowInput[];
export function rowsToParsedFiles(staged: StagedRow[]): ParsedMprFile[];
export interface PartitionContext { submitted: ReadonlySet<string>; outlets: readonly string[]; startDate: string }
export function readyToReport(row: Pick<StagedRow, 'txnDate' | 'outlet'>, ctx: PartitionContext): boolean;
export function partitionStaged(staged: StagedRow[], result: MatchResult, ctx: PartitionContext): { consumed: StagedRow[]; emitted: StagedRow[]; waiting: StagedRow[]; result: MatchResult };
```
- [ ] Tests (`test/mprStaging.test.ts`): `rowIdentity equals the engine identity for a settled and an unexpected row`; `toStagedRows numbers twins, skips rows before the start date, nulls an unreadable date, takes outlet from the file's terminal`; `readyToReport` table — D and D-1 submitted → true; only D → false; D-1 before start date → true; unknown terminal needs all outlets; null date → false; `partitionStaged` using real `runMatch`: matched row consumed; unmatched row with days submitted emitted into `result.unexpected` with `outlet`/`txnDate`; unmatched row without → waiting and absent from `result.unexpected`; two staged rows sharing an RRN → Duplicate-RRN follows the same rule; every staged row has exactly one fate. Expect FAIL, then implement, expect PASS. Commit.

### Task 3: Ingest integration
**Files:** Modify `mprService.ts` (`runMprReconciliation(jsonFiles, mprFiles, preParsed: ParsedMprFile[] = [])`, pre-parsed files appended after parsed ones and listed in `mprFiles` meta), `mprIngestService.ts`; Create `test/mprIngestStaging.test.ts`.

**Interfaces:** `runMprIngest(deps?: { s3?: S3Client }): Promise<MprIngestResult>`; `MprIngestResult` gains `staging?: { loaded: number; consumed: number; emitted: number; waiting: Record<string, number>; oldestWaiting: string | null; unmappedTerminals: string[]; failedFiles: string[] }` and `skipped?: string`.
- [ ] Scenario tests with a fake S3 (Map-backed `send` for List/Get/Put/Copy/Delete; missing key throws `{name:'NoSuchKey'}`) and the memory stores, unique outlet/date/RRN per test: `a file that arrives before its POS day waits, then settles when the day is submitted` (BLRT 16 Nov regression; staging empty afterwards, file in `processed/`); `an unmatched row is Unexpected only once D and D-1 are submitted, and carries its outlet`; `a resent file of a settled row adds nothing`; `a file that fails to parse goes to failed/`; `a store error during load leaves the file in pending/`. Expect FAIL.
- [ ] Implement flow per spec: lock → list pending → split staged / old-path by `detectAdapter` → load staged files (parse, `toStagedRows`, `insertRows`, then move; parse error → failed prefix) → settled keys → sweep → `submittedDays` then `listPendingMpr` → match → `partitionStaged` → `applyReconciledAccumulator` → persist in the existing order, deleting consumed/emitted staged rows after accumulators and before flagging → move old-path files → report. No-op only when nothing pending, no sessions and no staged rows.
- [ ] Run the full API suite and `npm run typecheck --workspace @toit/api`; commit.

### Task 4: Verification and hand-off
- [ ] mpr-core suite unchanged (`npm test --workspace @toit/mpr-core`).
- [ ] Rehearsal: throwaway Postgres + `schema.sql`, `STAGING_TEST_DATABASE_URL` spec against Postgres, then replay real bank files (copied from `processed/`) under scratch S3 prefixes with SMTP/IMAP blanked; compare counts with the live pre-state.
- [ ] Clean-worktree image per the established recipe (tag `main-<sha>`), push to ECR; give the user: DDL command first, deploy to `mpr-ingest`, requeue batches, what to check in the run output.
