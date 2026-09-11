# CLAUDE.md -- ghgcalculator

This file is read automatically by Claude Code at the start of every session in this repo. Treat
it as authoritative project context. Refreshed 2026-09-10 to match reality after several weeks of
drift -- if anything here conflicts with what you observe in the actual code/git history, trust
the code and flag the conflict rather than assuming this file is right.

**Scope note (avoid confusing this with other files also named CLAUDE.md):** there is a global
`~/.claude/CLAUDE.md` that applies to every Claude Code session across every project on this
machine -- unrelated to this repo, no authority here. There is also a separate
`C:\Users\LENOVO\Documents\ClaudeCowork\ABOUT ME\CLAUDE.md`, a workspace map for browser-based
Claude Cowork sessions -- not read by Claude Code, no authority here either. Three files, three
scopes, intentionally not merged or reconciled.

## Ownership

This is TeeKay's personal project, going commercial independently. It is **not** a Sustainacert
deliverable. Do not attribute it to Sustainacert regardless of what any other context source
implies. Ownership is personal for all of TeeKay's projects unless he explicitly says
"Sustainacert" for that specific project.

## Repo

- GitHub: https://github.com/teekaysharma/ghgcalculator, branch `main` (the `saas-multitenant`
  branch this file used to reference was merged and retired)
- This is the local clone -- `git`/`npm` work directly, no setup needed
- Production: deployed on Vercel (`https://ghgcalculator.vercel.app`, project
  `prj_jb7KsczBioMHBmpGeF42oYhvL901`, team "Tapas' projects"). Local dev and production share the
  **same** Neon Postgres database -- confirmed empirically, not assumed. A local migration run
  affects what production serves the moment new code deploys. Treat any DB-touching local work
  with that in mind.
- Database: Neon (Postgres) via `drizzle-orm/neon-http`. `DATABASE_URL` lives in the local `.env`
  (gitignored, present on this filesystem as of 2026-09-03) -- not something to ask TeeKay for
  unless it's missing.
- `drizzle-orm/neon-http` throws at runtime on `.transaction()` -- `db.batch()` is the only atomic
  multi-statement primitive available. This has bitten prior work; don't reach for `.transaction()`.

## Development process -- AI-native SDLC playbook (adopted 2026-09-10)

Deliberately aligned to Anthropic's playbook
(https://claude.com/blog/the-ai-native-sdlc-playbook) on TeeKay's explicit instruction. Every
feature's artifact chain, in order:

1. **`docs/superpowers/intents/YYYY-MM-DD-<topic>-intent.md`** -- the raw ask, in TeeKay's own
   words, timestamped, authored to his email. Written *before* the spec. Captures Stage 1 (Plan).
2. **`docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`** -- via `superpowers:brainstorming`.
   Questions asked one at a time, 2-3 approaches proposed with a recommendation, design presented
   in sections with approval after each, written up, self-reviewed, then TeeKay reviews the actual
   file before anything proceeds. Links back to its intent.
3. **`docs/superpowers/plans/YYYY-MM-DD-<topic>.md`** -- via `superpowers:writing-plans`.
   Task-by-task, verbatim code, no placeholders. Large plans split into dependency-ordered
   sub-plans (e.g. the verification-ready-inventory plan is 01-schema through 04-jurisdiction).
4. **Execution** -- via `superpowers:subagent-driven-development` when time allows: fresh
   implementer + task reviewer per task, a final whole-branch review, fix wave, scoped re-review
   before merge. Under real deadline pressure (e.g. the 2026-09-09 production-push weekend) work
   has sometimes been done directly in the main session instead -- a real, acknowledged deviation,
   not the default.
5. **`superpowers:finishing-a-development-branch`** -- merge/PR/keep decision.

Plan-mandated findings (a defect traceable to the plan's own text, not implementer deviation)
always go to TeeKay via `AskUserQuestion` -- never silently fixed or dismissed, even when the
"right" answer looks obvious.

**Known gaps against the playbook's later stages** (correlated 2026-09-10, confirmed by direct
inspection, not yet closed):
- A first Vitest suite now exists (`server/calculations/emission-calculation.test.ts`, 6 tests,
  added 2026-09-11) covering the emission-calculation arithmetic -- no longer "zero" test files,
  but still a narrow first slice: most of the codebase (tenant isolation, hooks, auth flows, etc.)
  still has zero coverage. `npm run verify` (`scripts/verify-branch.mjs`) plus several standalone
  `verify-*.mjs` scripts do real end-to-end smoke checks against a running server, but it's
  happy-path coverage, not a regression suite -- and it does not exercise the route the new Vitest
  suite covers (see `docs/superpowers/INDEX.md`'s Test suite row for that specific gap).
- No `.github/` directory -- zero CI/CD, not even lint/typecheck on push.
- No PR-based workflow, no `REVIEW.md` gate -- see "Merge policy" below for what actually happens
  instead.
- Vercel MCP deployment tooling gets used manually/interactively in chat, not wired as an
  automated pipeline step.
- No monitoring, control-band alerting, or autonomous-maintenance loop (Stage 6) exists.

## Stack and architecture rules (non-negotiable)

- React + TypeScript client (Vite), Express server, Drizzle ORM, Postgres (Neon),
  passport-local + session auth.
- Every tenant-scoped table query must filter on `organizationId`. No exceptions. See the
  `database-conventions` skill for the incident history and the exact upsert patterns to use.
- `drizzle-kit push` is retired for this project -- use hand-written idempotent migration scripts
  instead. See `database-conventions` for the exact shape and why.
- GWP values are versioned and sourced from the `gwp_values` table, never hardcoded. See
  `ghg-domain-conventions`.
- Emission factor sourcing hierarchy is enforced in order, with IPCC generic defaults last and
  always flagged when used. See `ghg-domain-conventions`.
- Any destructive database operation runs as two genuinely separate steps, never chained together.
  See `database-conventions` for the incident this rule comes from.

## Current state (as of 2026-09-10 -- verify anything load-bearing before trusting)

- **Base layer**: multi-tenancy (organizations/users/memberships), registration with email
  verification (Resend) and password complexity rules, ISO 14064-1 boundary setup (reporting
  entities/facilities/reporting boundaries with base year + rationale, three consolidation
  approaches), scope 1/2/3 calculator.
- **Facility-level MRV layer**: source streams, calculation/measurement/fallback approaches
  (per-gas, ISO/TS 14064-4-aligned), methane reports, data quality records (tier + uncertainty %),
  verification findings, management QA records, a finalize/recalculate snapshot mechanic
  (`reportingBoundaries.status` draft/finalized, logged recalculation reasons).
- **Consolidated reporting**: org-level rollup across facilities, biogenic CO2 as a memo item,
  GRI 305-4/IFRS S2 intensity ratios, Scope 2 dual reporting (location + market-based), Scope 3
  categories 1-15 as a required field on source streams (not free-text).
- **Emission factor sources**: IPCC defaults (incremental), EPA NAICS Supply Chain factors
  (1,016 rows), EXIOBASE region x sector multipliers via a genuine Leontief-inverse pipeline
  (`scripts/exiobase/`, offline/local-only, non-commercial license -- see its own README before
  this product is ever sold with EXIOBASE-derived factors live). No upload UI for any of these yet
  -- all seeded via one-off migration scripts. A generic upload facility (native file upload +
  format recognizers + mandatory validation preview + saved column-mapping templates,
  superadmin-only) has been designed but **not approved for building** -- do not start it without
  explicit go-ahead.
- **Membership/account lifecycle**: soft deactivate/reactivate for both org memberships and whole
  accounts, two-tier permission model (super-admin platform-wide vs. org-admin strictly scoped to
  their own tenant via a sole-organization boundary rule), unified token-based password reset.
- **Super-admin control panel**: cross-tenant account directory, verify/delete/promote/demote,
  read-only cross-tenant GHG-data drill-down (reporting entities/facilities/boundaries/consolidated
  report per org), audit log (`admin_action_log`).
- **Activity-data document extraction**: intent + design spec written
  (`docs/superpowers/intents/2026-09-10-document-extraction-intent.md` and its linked spec) --
  extracts kWh/fuel-volume/period from uploaded bills via Gemini's free-tier vision API, prefills
  the calculation-approach form, mandatory human review before save. Plan not yet written.

**Durable architecture decisions still binding, not yet built:**
- Tenant lifecycle (archive/unarchive, governed multi-step deletion) is deliberately NOT built --
  a tenant must never be deactivated as a side effect of any user/membership action.
- Identity/profile decoupling (machine-allocated usernames, admin-assigned email as login
  identity, separate personalizable display name) -- approved concept, needs its own
  brainstorming/design pass before building. Touches `email`-as-identity everywhere.

## Merge policy

Actual practice, confirmed against `git log`: no PR workflow exists. Feature work lands as direct
commits to `main` after explicit approval in chat, per instance -- not a standing blanket
authorization. This is a change from what this file previously stated (a PR-gated policy that was
never actually followed even before this refresh) -- flagged here rather than silently rewritten
to match practice without saying so. If TeeKay wants a stricter gate (PR review, multi-person
verification, a `REVIEW.md` policy per the playbook's Deploy stage) that needs to be decided and
built, not assumed from what's happened so far.

## Communication style

Technical and directive. Terse. No em dashes. No filler ("certainly," "I'd be happy to,"
compulsive summaries, closing offers to elaborate). No invented facts -- recalled-but-unverified
figures (clause numbers, thresholds, version numbers, commit status) get flagged as unverified,
not stated with confidence. Flag assumptions before proceeding rather than silently picking one
when more than one interpretation is plausible.

## Working principles (carried over from Tapas's standing behavioral guidelines)

Adapted 2026-09-10 from `C:\Users\LENOVO\Documents\ClaudeCowork\ABOUT ME\CLAUDE-TKS.md` -- Tapas's
cross-project behavioral contract for browser-based Cowork sessions. That file stays authoritative
and unchanged for its own scope; this is the ghgcalculator-relevant subset, adapted where the two
environments differ (see the Filesystem note above -- the sandbox-vs-Windows-write risk that file
warns about doesn't apply to Claude Code).

**Investigate before claiming.** Never state what a file, script, schema, or standard says without
actually opening or querying it in this session -- not from the filename, not from a remembered
prior version, not from a skill file's summary table. A loaded skill's own clause-number summary
was found wrong against the primary ISO 14064-1 text in this session (2026-09-10 gap-check) --
that's exactly the failure mode this rule exists to catch. Never retype or reconstruct file content
from memory when a task needs to reference or edit it; read it fresh even if it was read earlier in
the same session. If checking isn't possible right now, say so explicitly and label the claim
unverified -- don't let it read the same as a verified one.

**Scope is explicit, not inferred.** When an instruction could apply to one instance or to every
instance of a pattern, state which, or ask. Do not silently narrow or widen scope.

**Surgical edits.** Touch only what was asked. Don't reformat or "improve" adjacent code that
wasn't part of the request. Match the existing file's style and conventions. If a pre-existing
issue turns up elsewhere while editing, flag it -- don't fix it silently as a drive-by.

**Goal-driven execution.** Before starting a multi-step task, state what "done" looks like as a
checkable condition, not a vague direction. For autonomous multi-step work, state an iteration cap
before starting; if stuck at the cap, stop and report the blocker rather than looping. Judgment-
heavy calls (architecture tradeoffs, scope decisions, anything commercially or legally sensitive)
are TeeKay's to make, not something to resolve by continuing to iterate alone.

**Regulatory and standards citations** (this app's own domain content, not just meta-process):
verify the specific clause/decree/resolution number, threshold, and jurisdictional scope before
citing -- never generalize a UAE regulation across all emirates/sectors, and never state an ISO
clause's requirement without reading the actual text (RAG query or the standard itself), even when
a skill file already names the clause.

**Parallel independent reads/calls, no exceptions.** When a task needs several known, independent
pieces of information, fetch them in the same turn. Sequential calls for independent lookups are a
process failure, not a style choice.

**Context continuity -- adapted, not copied verbatim.** Tapas's Cowork guidelines set a hard
75%-context stop with a mandatory handoff-file write, because that environment doesn't auto-manage
context. Claude Code auto-compacts long sessions instead, so the literal mechanism doesn't transfer
-- but the underlying principle does: don't silently push a long session past the point where
quality degrades, and proactively checkpoint (a ledger entry, a memory update, a clear status
report) at natural stopping points rather than waiting to be asked.

When in doubt: ask one focused question. Do not fill gaps with assumptions.

## Session start checklist

1. `git status`, `git log --oneline -20`, `git branch --show-current` -- confirm what's actually
   committed vs. working-tree-only.
2. Read `docs/superpowers/INDEX.md` first -- one row per feature/initiative, current stage and
   status, links to the relevant intent/spec/plan files. This answers "where does everything
   stand" without reading every spec/plan or re-deriving it from the codebase; only open a
   specific intent/spec/plan file once you know which feature you're actually working on.
   `HANDOFF-SESSION.md` (last touched 2026-08-18) predates this convention and is historical only
   -- do not treat it as current.
3. `npm install` if needed, `npm run check` and `npm run test` -- report actual output, don't
   assume clean.
4. Report current verified state before starting new work.
