# Toit Payment Reconciliation

Port of the single-file `legacy/reconciliation (68).html` operator tool to a
Next.js frontend, a Node API, Postgres and S3 — **without changing the
reconciliation workflow or the numbers it produces.**

The legacy file remains in `legacy/` as the behavioural specification. Every
ported module names the legacy line range it came from, so the port stays
auditable against the original by diffing rather than by memory.

## Layout

```
RECON/
├─ legacy/
│  └─ reconciliation (68).html   Original app — the behavioural spec. Do not edit.
├─ packages/
│  ├─ recon-core/               Pure engine: parsers, matchers, FRS arithmetic.
│  │                            No DOM, no DB, no network, no clock.
│  └─ contracts/                HTTP wire format shared by api + web. Types only.
└─ apps/
   ├─ api/                      Express: HTTP, auth, object storage, persistence.
   └─ web/                      Next.js App Router: UI only.
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
| Justification layer (remarks, square-off, advances, BOH, EPR, short collections) | Not started |
| Submit, snapshot, printable report | Not started |
| Postgres + S3 drivers, real auth | Not started |

The justification and submit layers are the operator-input half of the legacy
tool (roughly legacy lines 1930–5360). Everything currently on screen is derived
from the uploaded files alone, which is why it can be verified against the
legacy numbers directly.

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
