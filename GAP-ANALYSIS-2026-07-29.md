# GHG Calculator SaaS — Gap Analysis and Session Findings

Session date: 2026-07-29. Repo: github.com/teekaysharma/ghgcalculator, branch `saas-multitenant`. Local clone: `C:\Users\LENOVO\Documents\ClaudeCowork\OUTPUTS\ghgcalculator`.

This document replaces the prior Claude Project's default framing (Electron desktop app, Batch 5). That framing does not match this branch. Per HANDOFF-SESSION.md, the SaaS branch above is authoritative for this thread.

## Session constraints (read this first)

Two facts govern everything below:

1. **No execution access.** This session has file read/write access to the repo via the Filesystem MCP, and no shell/exec access to the Windows machine. I cannot run `npm install`, `tsc`, `npm run verify`, or `git` commands against this repo. Every code change in this session is written blind and needs to be run and tested by you (or a future session with exec access) before it's trusted. This matches the existing merge policy — nothing merges to `main` without your local testing — but it also means I can't self-verify a change compiles before handing it to you.
2. **No database credentials.** `DATABASE_URL` lives in `.env`, not readable by me. I cannot query the live Neon database, so I cannot confirm current row counts, whether migrations have actually been applied, or whether the GWP fix described below is committed vs. only present in the working tree.

## Brand/ownership contradiction — flagging per context-drift protocol

The Claude Project's stored memory describes this as "a commercial GHG emissions reporting SaaS platform under the SustainaCert International brand." Your message this session states the opposite: this is your personal project, unrelated to SustainaCert, that you now want to take commercial independently.

These two statements conflict. I'm proceeding on your direct instruction (personal project, not SustainaCert) since it's the more recent and more specific statement. Nothing in the current codebase hardcodes "SustainaCert" as a brand (checked: no matches in the files read this session), so there's no cleanup needed on that front. Flagging this so it's explicit rather than silently resolved.

## Verified current state (checked directly this session, not recalled)

**Stack:** Vite/React 18/TypeScript frontend, Express backend, Neon Postgres via `@neondatabase/serverless` (HTTP driver) + Drizzle ORM, `passport-local` + `express-session` + `connect-pg-simple` for auth/sessions, bcrypt (12 salt rounds) for password hashing, `express-rate-limit` on register/login.

**Multi-tenancy:** Real. `organizations`, `users`, `memberships` (role: owner/admin/member) tables. Every tenant-scoped table (`emission_factors`, `emission_records`, `reporting_entities`, `facilities`, `reporting_boundaries`) carries `organization_id`. Every read/write in `server/storage.ts` filters on it — confirmed by reading the full file, not sampling. `requireAuth` + `requireOrg` middleware gate every route except register/login.

**ISO 14064-1 boundary layer:** `reporting_entities` -> `facilities` -> `reporting_boundaries` (reporting year + consolidation approach: operational control / financial control / equity share), with a `readyForCalculation` gate on `/api/calculate` requiring at least one of each. `SetupPanel.tsx` walks a user through creating these before the calculator renders.

**Reference data bundled:** DEFRA/DESNZ 2026 UK conversion factors (3,425 rows) and an IPCC AR6 GWP-100 reference file, both downloadable from the UI. The three "268 gases" references flagged as wrong in the prior session's HANDOFF note are now "266 gases" in `WasteFactorGuide.tsx` as of this session's read — the text fix is present in the working tree. I did not independently re-verify the bundled `gwp-ar6-reference.xlsx` binary's row count against the GHG Protocol source PDF this session (no live web fetch of that PDF was done here), and I have no way to confirm this fix is committed vs. sitting as an uncommitted working-tree change. Check `git status` / `git log` on those two files before assuming this is closed.

**Auth/session security:** Passwords bcrypt-hashed, never logged in plaintext. Sessions stored in Postgres via `connect-pg-simple`, `httpOnly` + `sameSite: lax` cookies, `secure` flag tied to `NODE_ENV`. Rate limits: 5/hour on register, 10/15min on login, both IP-based. CSV export has injection/escaping handling per README.

**Known gaps — already honestly documented in this branch's own README, not new findings:**
- No real invite-by-email flow (invite only attaches an already-registered account)
- No password reset / forgot-password flow
- No rate limiting on `/api/team/invite` or other authenticated write endpoints
- `X-Organization-Id` multi-org header path has no UI (fine while it's one-org-per-user in practice)
- No automated UI test coverage (`npm run verify` covers the API end-to-end, not the browser)
- Vercel serverless deployment is incompatible with the current session architecture as-is (see below)

## New gaps identified this session

**1. Hosting/deployment target is undecided, and it's architecturally load-bearing.** `server/db.ts` uses Neon's HTTP driver (serverless-friendly), but `server/index.ts` uses `pg.Pool` + `connect-pg-simple` for sessions -- a persistent TCP connection pool, which does not survive on Vercel-style serverless functions (each invocation is a cold, stateless process; pooled connections leak or fail). You called this "SaaS multi-tenant deployment" -- that phrase doesn't by itself say where it's deployed. This is the single most consequential open decision: it determines whether auth stays session-based (works today, needs a persistent-process host -- Railway, Render, Fly.io, a plain VPS) or gets rewritten to token-based (JWT or similar, needed for true serverless). I have not picked one silently. See question asked alongside this document.

**2. No tenant plan/billing layer exists.** "Commercial SaaS" implies at minimum: subscription tiers or seat limits, a billing provider integration (Stripe is the standard choice), usage metering if pricing is usage-based, and an upgrade/downgrade path. None of this exists in the schema or routes today. Normal for this stage, but named as a gap rather than assumed out of scope.

**3. No admin/ops surface.** No way to see cross-tenant health (how many orgs, how many active users, error rates) without querying the database directly. For a commercial product with paying customers, this is normally needed before or shortly after first customer, not deferred indefinitely.

**4. Granularity gap against the EAD benchmark you attached.** This is the largest and most material finding, so it gets its own section below.

## The EAD benchmark, and what it implies

I read all 14 sheets of `20260227 - Deliverable C Template_v8 1.xlsx` (Abu Dhabi Environment Agency facility-level MRV template). It operates at a materially finer grain than this platform's current data model:

- **Source-stream and emission-source level**, not just scope/activity/quantity. Each source stream gets its own ID, estimated annual emissions, and a major/minor materiality classification.
- **Calculation-approach tiers**: calculation-based (activity data x emission factor x oxidation factor, per source stream, with named data sources like "maintenance records"), measurement-based (continuous emissions monitoring), and a fallback approach as a distinct, justified category -- not a single flat "quantity x factor" model.
- **Methane-specific reporting** as its own sheet, separate from the general calculation approach.
- **Verification and data-gap tracking** as structured fields, not free text.
- **Management & QA, and mitigation measures**, as their own sheets with defined fields.
- **Product/activity benchmarking** against a reference list (EU-style product benchmarks: clinker, hot metal, EAF steel, float glass, etc.) for facilities in emissions-intensive sectors.

The current schema (`emission_records`: scope, activity, unit, quantity, factor, emission, one row per calculation) is a corporate-level GHG Protocol/ISO 14064-1 boundary-and-total model. It does not have a concept of a source stream, a calculation-approach tier, per-source uncertainty, or a data-gap/verification record. Matching or exceeding EAD's rigor is not a UI feature -- it's a new layer of the data model (new tables: source streams, calculation approaches per stream, measurement-based approach records, data quality/uncertainty per source, verification findings, mitigation measures) sitting alongside, not replacing, what exists today. This is genuinely large -- comparable in size to the multi-tenancy rebuild already done, not a bolt-on. Not silently scoping this into "the MVP" without confirmation that's what gets built first.

## Recommendations

Two decisions are needed before more code gets written, because both change what gets built:

1. **Hosting target** -- persistent Node host (keeps current session auth, ships fastest) vs. serverless (needs an auth rewrite first).
2. **This session's scope** -- close the already-documented, smaller SaaS gaps (password reset, real invite emails, hosting config, tightening remaining rate limits) to get a testable multi-tenant MVP on the current data model, versus starting the EAD-equivalent source-stream/calculation-tier schema now, versus both in parallel at reduced depth on each.

Independent of those two answers, three things are worth doing regardless and don't require a decision:
- Close the small, already-scoped gaps that are pure additions (password reset flow, rate-limiting the invite endpoint) -- low risk, no architectural fork.
- Write the billing/plan schema as a stub (tables + types, not a live Stripe integration) so it doesn't have to be retrofitted through every tenant-scoped query later.
- Verify the GWP fix's actual git status next time this repo is open locally (`git status client/public/gwp-ar6-reference.xlsx client/src/components/WasteFactorGuide.tsx`) -- one command, closes a real open question from last session.