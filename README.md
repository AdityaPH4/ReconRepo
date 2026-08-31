# Toit Payment Reconciliation

Port of two single-file operator tools — `legacy/reconciliation (68).html`
(Layer 1: per-outlet, per-business-date reconciliation) and
`legacy/mpr-recon (10).html` (Layer 2: confirms Layer 1's settlement ledger
against actual bank settlement files) — to a Next.js frontend, a Node API,
Postgres and S3 — **without changing the reconciliation workflow or the
numbers either tool produces.**

Both legacy files remain in `legacy/` as the behavioural specification. Every
ported module names the legacy line range it came from, so the port stays
auditable against the original by diffing rather than by memory.

## Layout

```
RECON/
├─ legacy/
│  ├─ reconciliation (68).html   Layer 1 spec — do not edit.
│  └─ mpr-recon (10).html        Layer 2 spec — do not edit.
├─ packages/
│  ├─ recon-core/               Layer 1 pure engine: parsers, matchers, FRS,
│  │                            justification/submit. No DOM, no DB, no clock.
│  ├─ mpr-core/                 Layer 2 pure engine: bank-file adapters,
│  │                            RRN/AMEX/UPI matcher, CSV export. Same rules.
│  └─ contracts/                HTTP wire format shared by api + web. Types only.
└─ apps/
   ├─ api/                      Express: HTTP, auth, object storage, persistence.
   └─ web/                      Next.js App Router: UI only, both modules.
```

`recon-core` has two entry points, and the split is load-bearing:

- `@toit/recon-core` — everything, including the parsers. **Server only**; it
  pulls in `xlsx` and `jszip`.
- `@toit/recon-core/display` — types, constants and formatters only. What the
  frontend imports. Importing the main entry from a component would drag both
  spreadsheet libraries into the browser bundle for no benefit.

## Styling

Tailwind v4, configured entirely in
[`apps/web/app/globals.css`](apps/web/app/globals.css) — there is no
`tailwind.config.js`. That file has two parts, and both are meant to be edited:

1. **`@theme`** — the design tokens: colours, radii, shadows, type scale, fonts.
   Every value is carried over from the legacy stylesheet. Change
   `--color-accent` here and every button, tab, tile and focus ring follows.
   Each token also generates utilities, so `--color-accent` gives you
   `bg-accent`, `text-accent`, `border-accent`.
2. **`@layer components`** — every repeated pattern as a named class: `.btn`,
   `.card`, `.kpi`, `.panel`, `.data-table`, `.tag-*`, `.alert-*`, `.net-box`,
   and so on. Components reference these by name and use raw utilities only for
   genuine one-offs, so a visual change lands in one place rather than across a
   dozen files.

Semantic names are used over literal ones — `--color-ok` rather than
`--color-green`, `.diff-excess` rather than `.text-green` — so the meaning
survives a palette change. Likewise the type scale is named (`text-body`,
`text-figure`) rather than numbered.

The dependency direction is strictly one-way:

```
web ──▶ api ──▶ recon-core
         │
         ├──▶ Postgres   (queryable reconciliation data)
         └──▶ S3         (raw uploaded files, byte-for-byte)

web ──▶ recon-core   (types and display formatters only)
```

`recon-core` never imports from `api`, `web`, Prisma or the AWS SDK. That is what
lets the engine be tested in isolation and re-run against historical inputs.

## Why the two data stores split this way

- **S3** holds every uploaded file exactly as received — the Payment Report CSV,
  the transactions ZIP, the drawer summary CSV, the optional HDFC statement
  XLSX. Raw and immutable, so any past session can be re-reconciled from source
  if a rule changes or a result is disputed.
- **Postgres** holds what needs querying: sessions, the settlement ledger,
  justifications, and the two cross-session repositories (advances, bills on
  hold).

## Running

Requires Node 20+. This project uses **npm workspaces** — no pnpm needed.

```bash
npm install
npm run dev        # API on :4000, web on :3000
```

No `.env`, no Postgres and no AWS account are needed to run it. Every backing
service is selected in [`apps/api/src/config.ts`](apps/api/src/config.ts) and
falls back to a local equivalent:

| Service  | Default when unconfigured | Switches to real when you set |
| -------- | ------------------------- | ----------------------------- |
| Raw files | local disk under `.data/raw/` | `S3_BUCKET` + credentials |
| Sessions  | in-process map (lost on restart) | `DATABASE_URL` |
| Auth      | fixed dev user, all outlets | `AUTH_SECRET` |

The API prints which drivers are live at boot, so a stubbed service can never be
mistaken for a real one.

Generate sample uploads to try the flow with:

```bash
npm run fixtures --workspace @toit/api    # writes to .data/fixtures/
```

Verify the engine on its own:

```bash
npm run test --workspace @toit/recon-core
```

## What is built

| Area | State |
| ---- | ----- |
| Reconciliation engine (parsers, RRN matching, AMEX, FRS) | Done, 33 tests |
| Upload → run → results flow | Done, end-to-end |
| Raw file storage (write + read back byte-identical) | Done (local driver) |
| Pinelabs panel, aggregate panels, KPI tiles, FRS table | Done, read-only |
| Tailwind design system in `globals.css` | Done |
| Reopen a stored session at `/sessions/[id]` | Done |
| Justification layer (remarks, square-off, advances, BOH, EPR, short collections) | Done, 27 tests |
| Submit, snapshot, printable report | Done |
| MPR (Layer 2) engine — bank adapters, RRN/AMEX/UPI matcher, CSV export | Done, 31 tests |
| MPR upload → run → results flow, persisted runs at `/mpr` and `/mpr/[id]` | Done, end-to-end |
| Postgres + S3 drivers, real auth | Not started |

The justification and submit layers are the operator-input half of the legacy
tool (legacy lines ~1930–5777). They are ported behind the same architecture as
the engine — pure logic in `recon-core`, wire types in `contracts`, storage
drivers in `apps/api` — with three deliberate corrections over legacy, each
recorded where it's implemented:

- **Advances are outlet-scoped** (`packages/recon-core/src/justification/advances.ts`).
  Legacy had no outlet field on an advance at all — harmless only because a
  browser session held one outlet at a time.
- **A cleared Bills-on-Hold entry is durably marked `cleared`**
  (`apps/api/src/storage/memoryBohStore.ts`). Legacy never wrote clearance
  back to the repository row, so a cleared bill would resurface as clearable
  forever once the repo is a real, persistent table.
- **One canonical completeness/residual calculation**
  (`packages/recon-core/src/justification/{completeness,residual,submitGate}.ts`)
  serves both the live "can I submit" display and the actual submit gate.
  Legacy has two independently-drifting versions of this that could disagree.

Advance/BOH mutations a draft session makes stay inside that session's own
state until submit succeeds — an abandoned draft simply never wrote to the
cross-session repositories, replacing legacy's clone-based baseline/rollback
with plain non-persistence. `sessionStore`/`advanceStore`/`bohStore` are all
still the in-memory dev drivers (see the table above); a Postgres driver for
each is the next step towards a real deployment.

## Layer 2 — MPR reconciliation (`packages/mpr-core`, `/mpr`)

Ported from `legacy/mpr-recon (10).html` (lines 223–1753 — the markup and two
vendored parsing libraries before that don't need porting). This is a
downstream, second-pass check: it ingests the Layer-1 settlement snapshot
(one JSON per business date — the same `Snapshot` `buildSnapshot()` produces)
alongside the actual bank settlement files (Kotak, Pinelabs, AMEX, HDFC UPI)
and confirms money Layer 1 expected to settle actually did, matching by RRN
(AMEX matches by daily batch submission instead — it doesn't settle per-RRN).

Two prerequisite/architectural notes:

- **`Snapshot.upi` gained `transactions[]` and `justifications[]`**
  (`packages/recon-core/src/justification/snapshot.ts`) — Layer 2's entire
  HDFC Static UPI matching feature depends on these, and the initial Layer-1
  port hadn't needed them yet. Purely additive; every existing consumer of
  `Snapshot` is unaffected.
- **Unlike legacy (stateless — upload, view, reset, nothing saved), MPR runs
  are persisted** as their own session type (`MprSessionStore`, mirroring the
  Layer-1 `SessionStore`), reachable again later at `/mpr/[id]`.

Three deliberate corrections over legacy, each recorded where it's
implemented:

- **A duplicate RRN across MPR rows is flagged as `ambiguous`**, not silently
  resolved last-write-wins (`packages/mpr-core/src/engine/match.ts`). Legacy's
  primary matcher is a plain object keyed by RRN; a collision quietly drops
  the earlier row with no warning, unlike the AMEX/HDFC-UPI matchers in the
  same file, which both explicitly avoid double-matching.
- **An unmatched Kotak/Pinelabs MPR credit is surfaced as `unexpected`**
  (same file). Legacy's results screen is fully built to group and display
  this for every source — but the matcher only ever populates it from the
  HDFC-UPI path; a Kotak or Pinelabs credit with no ledger counterpart was
  simply dropped. Money the bank settled with no record in Layer 1 at all is
  the case most worth surfacing, not the easiest to skip.
- **AMEX is included in the CSV export, and "No RRN" pending rows are shown
  consistently** between the UI and the export
  (`packages/mpr-core/src/engine/csvExport.ts`). Legacy's export omits AMEX
  entirely despite it having a full results tab, and shows "No RRN" rows in
  the CSV while hiding them from the on-screen Pending tab/tile.

Every bank adapter's column-name aliases and detection fingerprints, every
matching tolerance (₹0.5 primary / ₹1 AMEX / ₹0.5 + 1hr window UPI), the AMEX
batch/SOC-number logic and its midnight-rollover date rule, and the UPI
two-pass-plus-justification matching are a faithful port. `.xlsx`/`.xls`
parsing uses the real `xlsx` npm package rather than legacy's hand-rolled
JSZip+DOMParser reader — that reader existed only to route around a
compression quirk in the browser-bundled, minified SheetJS build, which
doesn't apply server-side.

## Domain notes worth knowing before changing anything

These are behaviours the legacy tool relies on. They look like bugs and are not.

- **`money()` returns `NaN`, not `0`, for a blank cell.** The UI renders `NaN`
  as an em dash, which is how an operator tells "no value reported" apart from
  "reported as zero". Coercing to `0` would silently fabricate reconciled rows.
- **The business window is 08:00 → 07:00 the next morning**, not midnight and
  not 02:00. Outlets can trade until ~06:00 on event nights, and those sales
  belong to the previous business date.
- **PR rows are grouped by RRN before comparison.** One card tap can settle
  several POS orders (split bills), so the comparison is *group total vs
  terminal amount*, never row against row.
- **`diff` is always `terminal − POS`.** Positive means the terminal collected
  more than the POS recorded.
- **Pinelabs reconciles against the terminal report, not the drawer summary.**
  The drawer figure is hand-entered and can itself be wrong, so reconciling
  against it would compare one error to another.
- **An ambiguous key is never matched.** A duplicated RRN, auth code or
  fallback amount goes to a "needs a human" bucket rather than being paired
  arbitrarily.
- **Swiggy and Zomato never block submission.** They are POS-integrated and
  assumed reconciled.
- **AMEX has no usable RRN**, so it matches on auth code ↔ approval code, with
  a unique-amount fallback.

## Deliberate changes from the legacy file

Everything else is a faithful port. These four are not, and each is deliberate:

1. **Timezone.** The legacy code ran in a browser on an IST machine, so
   `new Date(y, m, d, 8, 0, 0)` was implicitly Asia/Kolkata. The same
   expression on a UTC server shifts the business window by 5h30m, silently
   including or excluding transactions at the window edges. All wall-clock
   construction now goes through `istDate()` and all formatting pins
   `timeZone: 'Asia/Kolkata'`, so behaviour matches the legacy app as it
   actually ran and no longer depends on server timezone.

2. **Advance and BOH repositories now persist.** The legacy comments describe
   these as surviving "across SUBMITTED runs", but they lived in a plain JS
   object in browser memory — a page refresh destroyed both. They are Postgres
   tables now. This is the one place the port had to change behaviour to match
   the stated intent.

3. **Month parsing is case-insensitive.** `parsePRDate` used a case-sensitive
   lookup with an `?? 0` fallback, so a cell reading `01-AUG-2026` resolved to
   *January*. It now returns `null` on an unrecognised month instead of
   defaulting. Identical for the documented `01-Aug-2026` casing.

4. **Session state is server-side.** Justifications, advances and BOH clears
   PATCH a draft session row instead of accumulating in memory, so a refresh
   mid-session no longer loses the operator's work. The user-visible workflow —
   upload, run, justify, submit — is unchanged.

One legacy quirk is **preserved on purpose**: `zipRow` declared `invoice` twice
in the same object literal, so the apostrophe-stripping `cleanRRN` never applied
to it. The port reproduces the plain `.trim()` that actually won, and says so at
the call site.
