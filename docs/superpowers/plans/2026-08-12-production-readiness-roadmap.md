# Production Readiness Roadmap — GHG Calculator (saas-multitenant)

> **For agentic workers:** This is a multi-subsystem ROADMAP, not a single flat implementation plan. Per `superpowers:writing-plans`' own scope-check rule, each step below gets its own detailed bite-sized task plan (via `superpowers:writing-plans`) immediately before it's executed — write that step's plan once the open decisions listed under it are resolved, not before. Use `superpowers:brainstorming` first for any step with unresolved product decisions (billing model, hosting target, email provider, IPCC data source). Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to run each step's plan once written.

**Goal:** Get a fully working MVP running and verified on the local system first — GitHub push and commercial scale-up are deliberately later, separate decisions, not assumed as immediate next steps.

**Architecture:** No architectural rewrite. React + TypeScript client, Express server, Drizzle ORM, Postgres (Neon), passport-local + session auth — all already in place and working. This roadmap is about closing gaps (missing features, missing methodology completeness, missing commits), not replacing anything.

**Tech Stack:** Existing stack only — no new frameworks proposed anywhere in this roadmap unless a step explicitly calls one out as an open decision (e.g. an email provider, an error-monitoring SaaS) — and none of those are relevant until the "deferred until push/scale" section below.

## Global Constraints

These apply to every step below; they're not repeated per-step.

- Every tenant-scoped table query MUST filter on `organizationId` — no exceptions. This class of bug has already been found and fixed twice this project (six `upsertX` methods missing org-scoping in the conflict condition, fixed 2026-08-03; confirm no regressions before every commit).
- `drizzle-kit push` is retired for this project (proven unreliable, see `MIGRATIONS.md`). All schema changes go through hand-written idempotent migration scripts in `scripts/manual-migration-*.mjs`.
- GWP values must be traceable to a stated AR version, never hardcoded without a source.
- Emission factor sourcing hierarchy (local → national → regional → global agency → IPCC generic default) must never silently default to IPCC generic without flagging it.
- **Nothing merges to `main` until `saas-mvp-test-log.xlsx`'s Critical-priority rows are full green, verified by multiple people** (TeeKay's standing merge policy). Not immediately relevant while everything stays local, but don't forget it exists.
- No PR opens without TeeKay's explicit go-ahead. No push to GitHub at all until TeeKay decides the local MVP is ready.
- Technical, terse communication; no invented facts — unverified figures get flagged as unverified.

---

## Where things actually stand (verified this session, not assumed)

Confirming this before laying out the sequence, because HANDOFF-SESSION.md's claims were written without shell/exec access and several turned out to need correction:

- **Nothing is committed except old work.** HEAD (`fd1b1ad`) is DEFRA/GWP format-guide work only. The entire facility-level MRV layer (schema, routes, storage, `AppShell`/`BoundaryWorkspace`/`FacilityProfile`, migrations 002–004) plus this session's new emission-factor traceability framework (migration 005, `EmissionFactorPicker`, schema/route changes) all sit uncommitted in the working tree — roughly 1,800+ lines of diff plus several new files.
- **Facility-MRV layer + ISIC Rev.4 classification: built and browser-tested this session.** Setup flow, Facilities + ISIC picker, all 4 Boundary Workspace tabs, all 3 calculation-approach tiers — all confirmed working against the live Neon DB. Two real bugs were found and fixed in the process (a login/register redirect race in `use-auth.tsx`; a stale cache-invalidation key in `BoundaryWorkspace.tsx` that left the source-stream list showing "Not Set" after a save).
- **Emission-factor traceability framework: built and tested this session.** `POST /api/emission-factors` now requires a real source URL + authority name; the shared `EmissionFactorPicker` is wired into both the legacy calculator and the facility-MRV `CalculationApproachForm`; uploads persist instead of vanishing on refresh. `ipcc_default_factors` (the actual IPCC Tier-1 default emission-factor table) is deliberately empty — no such dataset exists in this repo, the RAG, or was sourced this session; fabricating numbers was rejected in favor of building the framework first. **This is still an open, unresolved data-sourcing question — see Step 3 below.**
- **AR6 GWP reference file: verified accurate.** Cross-checked the bundled `gwp-ar6-reference.xlsx` against the primary source (IPCC AR6 WG1 Chapter 7 Supplementary Material, Table 7.SM.7) for CO2, N2O, SF6, NF3, CF4 — exact matches. The corrected 266-row version is **uncommitted**; HEAD still has an old 42-gas version.
- **`npm run check` is clean** as of the last run this session.
- **Zero automated tests exist** beyond `scripts/verify-branch.mjs` (an end-to-end smoke test hitting a live server) and this session's manual browser QA.
- **`npm audit` reports 10 vulnerabilities** (4 moderate, 6 high) — not yet inspected, not urgent while local-only.
- **`saas-mvp-test-log.xlsx`** status unknown, not present in this folder — irrelevant until a GitHub push / `main` merge is actually on the table.

---

## Agreed execution order (decided 2026-08-14)

TeeKay's call, given the local-MVP-first goal: get the product actually complete and methodologically correct before worrying about infra, security hardening, or scale. Sequence:

**Step 1 — Housekeeping.** Commit what's already built and tested. No push, no PR.

**Step 2 — Calculator UX completion.** Finish the product's actual feature set: one-click factor loading, framework output-selector, Audit View + Excel export.

**Step 3 — Post-MVP data model roadmap.** Scope 2 dual reporting, GWP version tagging, Scope 3 structuring, real IPCC default factor data — the methodology-completeness work TeeKay wants verified before anything goes live. Written as 3–4 separate sub-plans (see below), each independently shippable.

**Step 4 — Targeted correctness pass.** Org-scoping audit and untested-surface sweep, scoped to whatever Steps 1–3 touched. Deliberately placed *after* Step 3 per TeeKay's explicit call, made with the risk flagged: Step 3 extends the exact tables the org-scoping bug class has already hit twice (`source_streams`, `calculation_approaches`, `emission_records`). Noted, not re-litigated — this is where it'll get checked.

**Everything else below is deferred until TeeKay decides to push to GitHub and/or move toward commercial scale-up.** Nothing in that section should start before that decision, regardless of how ready any individual piece looks.

---

## Step 1 — Housekeeping

**Why first:** committing now, while the working tree is in a known-good, browser-tested state, is far safer than doing it after more changes pile up on top.

- Commit the corrected `gwp-ar6-reference.xlsx` (266 rows) — resolves the HEAD-vs-working-tree mismatch.
- Commit the facility-MRV layer and the emission-factor traceability framework, in logical, reviewable chunks (schema+migration commits separate from UI commits, matching this repo's existing commit-message conventions).
- Wire `dataQualityRecords.usedIpccDefaultFactor` to auto-sync with the new `calculationApproaches.isIpccDefault` flag — flagged as a nice-to-have last session, worth closing now while the relevant code is fresh.
- Clean up stray untracked files sitting in the repo root that aren't part of any plan (`log1.txt`, `npm.txt`, `npm1.txt`, `new 8.txt`) and resolve the `ghg-inventory-disclosure-journal.html` question (already de-branded from SustainaCert this session — confirm whether it belongs in this repo at all, or should live elsewhere).

**No PR, no push.** Local commits to the `saas-multitenant` branch only.

## Step 2 — Calculator UX completion

- One-click DEFRA/AR6 factor loading: the bundled files are currently download-then-reupload only; this session's `EmissionFactorPicker` framework makes a proper "load bundled dataset" button straightforward now — needs a server-side route that parses and serves the bundled files as picker options instead of raw file downloads.
- Framework output-selector: ISO 14064-1 six-category / GHG Protocol scope-subcategory / EAD-shape view toggle over the same underlying scope-tagged data (deliberately scoped out of the 2026-08-04 UI build round).
- Audit View + Excel export: generic export of the on-screen audit view, and the official EAD-template-fill export — the latter must never touch the template's own formulas, only data cells.

**Sequencing note:** the Audit View / export shape will likely need revisiting once Step 3 adds Scope 2 dual-reporting and structured Scope 3 categories — not a blocker, just don't be surprised when it needs a second pass.

## Step 3 — Post-MVP data model roadmap (methodology completeness)

Four separately shippable pieces — write each as its own `superpowers:writing-plans` pass, verify each before starting the next, per the writing-plans scope-check rule:

1. **Scope 2 dual reporting** (location-based + market-based), automatic on every electricity activity, per GHG Protocol Scope 2 Guidance. Smallest, most self-contained of the four — natural starting point.
2. **GWP version tagging** as a schema-level, queryable concept (not just the static reference file) — every stored GWP-derived value traceable to a stated AR version and horizon.
3. **Structured Scope 3 categories 1–15** as explicit schema fields, with a spend-based fallback methodology for when granular activity data isn't available.
4. **Populate the real IPCC default emission-factor dataset** (`ipcc_default_factors`) — the actual 2006 IPCC Guidelines / 2019 Refinement Tier-1 activity-based factors, sourced properly, not fabricated.

**Open decision for TeeKay, blocking item 4 specifically:** where does the real IPCC data come from? Options on the table from earlier this session: (a) TeeKay provides a real source (EFDB export, the Guidelines/Refinement tables directly), or (b) Claude fetches it live via WebFetch against IPCC's public sources and TeeKay reviews what comes back before it's seeded. Items 1–3 don't depend on this and can proceed regardless.

## Step 4 — Targeted correctness pass

Not the full production-grade security/test-coverage buildout (that's in the deferred section) — narrowly scoped to whatever Steps 1–3 actually touched:

- Org-scoping check on every table/route Step 3 extended (`source_streams`, `calculation_approaches`, `emission_records`, plus whatever new tables Step 3 adds for Scope 2/3 structuring).
- Sweep of the surfaces that stayed untested this session: Methane Report edge cases, waste-factor xlsx sheets, product intensity/yearly comparison views.
- Re-verify the calculation math end to end now that Scope 2 dual reporting and structured Scope 3 exist.

---

## Deferred until TeeKay decides to push to GitHub / move toward commercial scale-up

Do not start any of this before that decision, regardless of how ready an individual piece looks in isolation.

### Automated test coverage + CI

Unit tests for calculation logic, integration tests targeting org-scoping specifically, a real e2e suite (Playwright or similar), CI wired to run on every push. No value until there's a remote to push to and run CI against. **Open decision:** test framework choice (Vitest/Jest + Playwright are the standard fits — a recommendation, not a decision made on TeeKay's behalf).

### Close the smaller documented SaaS gaps

Password reset flow, real email-based invite flow (current invite only attaches an already-registered account), rate limiting on remaining write endpoints (`/api/team/invite` etc.). Only matters once other people are self-service onboarding. **Open decision:** transactional email provider (SendGrid/Postmark/SES/Resend).

### Security review

Systematic org-scoping audit across the whole app (broader than Step 4's targeted pass), the 10 outstanding `npm audit` vulnerabilities, auth flow review (session fixation, CSRF, the dormant `X-Organization-Id` multi-org header path), input validation audit for siblings of the `POST /api/emission-factors` bug class found this session, secrets handling / rotation story for production.

### Hosting and infrastructure

**Open decision, blocking:** hosting target. Current code assumes a persistent Node host (Railway/Render/Fly/VPS) and needs zero auth rewrite. A serverless target (Vercel) requires replacing session-based auth with token-based auth first — a real rewrite, not a config change. Plus: error monitoring/observability (currently `console.error` only), Neon backup/DR story, production secrets management.

### Billing and admin surface

Plan tiers, usage limits, payment provider integration (Stripe assumed, not decided), admin/ops surface for cross-tenant support visibility and audit logging.

### Launch readiness polish

Legal (privacy policy / terms — footer already has placeholder-or-real "Privacy Policy" / "Help & Support" links, unconfirmed which), end-user documentation, onboarding UX pass, load/performance testing at realistic multi-tenant scale.

---

## Self-review against known gaps

Cross-checked against every open item named in `CLAUDE.md`, `HANDOFF-SESSION.md`, and this session's own findings:

- Uncommitted work (GWP xlsx, facility-MRV, traceability framework) → Step 1. ✓
- DEFRA/AR6 one-click buttons, framework output-selector, Audit View + Excel export → Step 2. ✓
- Scope 2 dual reporting, GWP version tagging, Scope 3 structuring, IPCC default factor dataset → Step 3. ✓
- Org-scoping bug class (already hit twice) → Step 4 (targeted) + Global Constraints (standing rule) + Deferred security review (systematic). ✓
- `saas-mvp-test-log.xlsx` merge gate → Global Constraints, deferred in relevance until push. ✓
- Password reset, real invites, no billing/admin surface, hosting decision, `npm audit` vulnerabilities, zero test coverage/CI → Deferred section, each tagged with why it waits. ✓

No gaps found between this document and the project's own documented open items.

---

## What happens next

Step 1 has no open decisions blocking it — ready for a real `superpowers:writing-plans` execution pass now. Step 2 is similarly unblocked. Step 3 needs the IPCC-data-source decision before item 4 specifically can be planned (items 1–3 don't need it). Step 4 and everything in the deferred section wait on their own triggers as noted above.

**Ready to turn Step 1 into an executable plan?**
