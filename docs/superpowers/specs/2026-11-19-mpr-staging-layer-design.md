# MPR staging layer — design

Date: 2026-11-19 · Status: draft, awaiting owner approval · Base branch: `experimental/mpr-slim-and-incremental`

## Problem
`mpr-ingest` reads every bank file in `pending/`, matches the batch, and moves **all** the files to `processed/` — whether or not the POS day they belong to has been submitted. A POS day submitted later never sees those rows.
Example: BLRT 16 Nov. Files consumed 17 Nov 07:23 UTC, day submitted 13:51 UTC → 142 Kotak + 20 HDFC rows stuck open.

## The idea (owner's)
A Postgres middle layer between S3 and matching. Each file's rows are read, filed by their own transaction date, matched, and **removed once reconciled**; the rest wait. Staging only ever holds unreconciled rows, and they come only from the MPR mails.

## Decisions
1. One staging table per bank format. **Phase 1:** Kotak, HDFC UPI. **Phase 2:** Pine Labs. **Phase 3:** Amex. A bank not yet converted keeps today's path (parsed in memory, moved after the run).
2. A row's day is its own transaction date, read inside the file. The file name / mail date is ignored.
3. Matching key is unchanged: RRN, across all days and outlets. The day never gates matching.
4. A matched row (settled or amount-mismatch) is deleted from staging.
5. **Unexpected rule:** a staged row that is still unmatched becomes Unexpected only when its outlet's POS day *D* (the row's date) **and** day *D-1* are both submitted. A day before `MPR_START_DATE` counts as submitted. Then it goes to the existing Unexpected list (now with outlet and date) and leaves staging. Duplicate-RRN rows follow the same rule.
6. Resends never come back: rows whose RRN is already in the 30-day settled keys (existing `loadRecentSettledKeys`) are dropped at load, and swept from staging at the start of each run.
7. Go-live uses no new job: requeue the needed `processed/` files with the existing `requeue-processed-files.mjs`; the normal load picks them up.

## Why D and D-1 (what the data showed — read-only look at live DB + S3)
- No file holds its own day: a Kotak file dated D holds D-1 and D-2; HDFC D holds D-1; Pine Labs / Amex span several days.
- HDFC and Amex rows have date + time; Kotak and Pine Labs rows have the date only. The restaurant day runs 08:00 → 07:00, so a row dated X is on POS day X or X-1 (a 1 AM sale). Requiring both days avoids calling a row Unexpected early.
- Volume: ~1,300 bank rows/day; backlog ~3,000 rows (2,243 belong to days never submitted — mostly PUNT 31 Oct, BLRT 4 Nov).

## Flow of one `mpr-ingest` run
1. Take a run lock (`pg_try_advisory_lock`); if another run holds it, return a no-op.
2. **Load.** For each `pending/` file whose `detectAdapter` is KOTAK or HDFC_UPI: parse → insert rows dated on/after `MPR_START_DATE` (`ON CONFLICT DO NOTHING`, one transaction per file) → *after commit* move the file to `processed/`. A file that fails to parse goes to `mpr-inbound/failed/` and is logged — never silently "processed". Other files follow today's path.
3. **Sweep** staged rows already in the settled keys.
4. **Match.** Staged rows (in `seq` order, grouped back into per-file inputs) + old-path files + all open POS days → `runMatch` as today. The match engine is not changed. Read `submittedDays` **before** listing the pending sessions, so a day submitted mid-run can never count as submitted without having been matched (else a row could be called Unexpected too early).
5. **Partition** each staged row into exactly one fate: *consumed* (appears as `mpr` in settled / amountMismatch / upiResults) · *emitted* (Unexpected or Duplicate-RRN and the rule in decision 5 holds) · *waiting* (everything else — and removed from the stored result).
6. Persist in the existing order: run record → counters → BOH auto-clear → accumulators → **delete consumed and emitted staged rows** → flag sessions. A crash before the delete is safe: those RRNs are already in the accumulator, so step 3 sweeps them next run.
7. Release the lock. The run result gains `staging: { loaded, consumed, emitted, waiting by bank/outlet, oldestWaiting, unmappedTerminals, failedFiles }`.

## Tables (schema `recon`, `IF NOT EXISTS`, created by a tracked script run **before** the new image)
`recon.mpr_stage_kotak`, `recon.mpr_stage_hdfc_upi` (later `_pinelabs`, `_amex`).
Columns: `seq BIGSERIAL`, `identity TEXT` (the engine's row identity: `source|rrn|amount|txnDate|settlementDate`), `occurrence INT` (twins inside one file), `rrn TEXT`, `txn_date TEXT` (yyyy-mm-dd, null if unreadable), `terminal TEXT`, `outlet TEXT`, `file_name TEXT`, `loaded_at TIMESTAMPTZ DEFAULT now()`, `data JSONB` (the normalised row, lossless for the engine). PK `(identity, occurrence)`; indexes on `rrn` and `(outlet, txn_date)`.
Identical rows across files collapse to one (first load wins) — dedupe no longer depends on file order. Twins inside one file are both kept, so they still surface as Duplicate RRN.
Rows with an unreadable date never become Unexpected; they wait and are listed in the run result. A row from a terminal with no known outlet counts as belonging to **every** outlet: it becomes Unexpected once D and D-1 are submitted at all of them (so no mapping is ever required); such terminals are listed in the run result.

## Terminal → outlet (constants beside `MAIL_SOURCES`; terminal comes from the file name via `classifyFile`)
Kotak: 0064746, 0215583 → BLRT · 0172757, 0176988 → BAGT · 0215585 → PUNT.
HDFC UPI: DPL922, HNB400, HNB402, HNB393 → PUNT · P15309 → BLRT · JLM595 → BAGT.
No outlet known (use the every-outlet fallback above): HDFC KOL294 (2 files, 9 and 29 Oct), Kotak 0181370 (silent since 13 Oct).
This map was derived from matched POS rows, not from the files: Kotak names only the merchant code and a masked company; HDFC names generic counters ("TOIT BREWPUB 13"; only Pune says so) or just the company.
Pine Labs (phase 2): store name via existing `storeToOutlet`. Amex (phase 3): SE number.

## New code, by area
- `schema.sql` + `scripts/createMprStagingTables.mjs` (with an undo comment).
- A staging store (interface in `storage/types.ts`, memory twin, Postgres version) — `insertRows`, `listAll`, `deleteByIdentity`, `sweepSettled`; one shared spec runs against both (pattern of `mprCounterStore.test.ts`).
- `SessionStore.submittedDays(dates)` (memory + Postgres): which (outlet, date) have a `submitted` session.
- Pure functions: build per-file inputs from staged rows; partition a match result into consumed / emitted / waiting; the Unexpected rule.
- `mprIngestService.ts`: load step, lock, partition, delete; `UnexpectedMprRow` gains optional `outlet` and `txnDate`.
- Config: `MPR_S3_FAILED_PREFIX`.

## Tests and rollout
- Unit: the rule (D / D-1 / start date / unmapped / undated); partition invariant (every staged row has exactly one fate); identity round-trip across settled, mismatch, UPI Pass 1 and 2, Duplicate, Unexpected.
- Scenario (S3 stubbed): file before its POS day waits then settles (the BLRT 16 Nov regression); resent settled file adds nothing; twin rows → Duplicate RRN; failed parse → `failed/`; crash before delete → swept next run.
- Rehearsal: a throwaway Postgres loaded with a dump of `recon` (`DATABASE_URL` pointed at it), copies of the real bank files under scratch S3 prefixes (pending / processed / reconciled / failed overridden by env — never the live ones, because ingest moves files and writes accumulators), SMTP and IMAP blanked.
- Rollout: run the DDL script → push the image to ECR (clean worktree, current recipe) → deploy to `mpr-ingest` → requeue stuck files in 2–3 date batches → check the run output. Rollback: redeploy the previous image and requeue `processed/` files; staging tables are additive and harmless.

## Out of scope / known limits
- No screen for waiting rows yet (counts in the run output only).
- Manual upload API (`POST /api/mpr-sessions`, no screen uses it) stays outside staging.
- Re-submitting an already-matched day cannot re-match rows already deleted (never happened since 1 Oct; same as today).
- Separate existing bug, not fixed here: ingest writes back whole session DTOs and can revive a discarded session as `submitted`.
- Password-protected `payoutreport@` HDFC files and the "HDFC card" source are unchanged.

## To verify during the build
Kotak rows carry no time (sampled files only); real Pine Labs consolidated layout (phase 2); ingest Lambda timeout/memory (affects requeue batch size); which branch is currently deployed (this branch is ahead of `main`).
