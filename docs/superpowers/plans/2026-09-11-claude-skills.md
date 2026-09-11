# Project-Specific `.claude/skills/` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create three project-specific policy skills (`database-conventions`, `ghg-domain-conventions`, `api-conventions`) under `.claude/skills/`, then trim `CLAUDE.md`'s overlapping bullets to one-liners with pointers to them.

**Architecture:** Each skill is a single `.claude/skills/<name>/SKILL.md` file — YAML frontmatter (`name`, `description`) plus a markdown body of numbered rules, each stated with its rationale (the real bug/incident behind it, where one exists). No code changes, no new dependencies. Auto-discovered by Claude Code the same way every other project/plugin skill is.

**Tech Stack:** Markdown + YAML frontmatter only.

## Global Constraints

- Each skill lives at `.claude/skills/<name>/SKILL.md` — directory name and frontmatter `name` field must match exactly, letters/digits/hyphens only.
- Frontmatter has exactly two fields: `name` and `description`. `description` starts with "Use when...", is third-person, states only triggering conditions (never a summary of the skill's own content/workflow), and stays under ~500 characters.
- Body style: state the rule, then *why* — citing the real bug/incident behind it where the spec identifies one. A rule with no stated reason invites being "corrected away" by someone who doesn't know the incident it prevents. This is a content requirement from the approved spec, not a formatting nicety.
- Target under ~500 words of body content per skill (excludes frontmatter) — these are conditionally-loaded project skills, not always-loaded context, but still worth keeping lean per this environment's `writing-skills` skill.
- `.claude/` in this repo is currently entirely untracked in git (confirmed via `git status` and `git check-ignore` — no `.gitignore` rule covers it; nothing under it has ever been committed). Every commit in this plan stages **only** the exact file(s) it just created or edited (e.g. `git add .claude/skills/database-conventions/SKILL.md`) — never `git add .claude/` or `git add -A`/`git add .`, which would sweep in unrelated untracked content (`.claude/launch.json`, `.claude/worktrees/`) that is not part of this work.
- Every rule's supporting fact (file path, line reference, code pattern) must be verified against the live codebase before being written into a skill file — this project's standing "investigate before claiming" rule applies to skill content exactly as it does to code.
- No code, schema, or route behavior changes anywhere in this plan. Skills are documentation/instruction artifacts only (per the approved spec's own "Testing" section) — if writing a skill surfaces what looks like a real bug or gap in the underlying code, flag it, don't fix it here.

---

### Task 1: `database-conventions` skill

**Files:**
- Create: `.claude/skills/database-conventions/SKILL.md`

**Interfaces:**
- Produces: a discoverable project skill named `database-conventions`, triggered when touching `shared/schema.ts`, a `scripts/manual-migration-NNN.mjs` script, or `server/storage.ts`. No later task in this plan depends on this skill's content, only on the fact that it exists (Task 4 references it by name in `CLAUDE.md`).

- [ ] **Step 1: Create the skill file**

Create `.claude/skills/database-conventions/SKILL.md` with exactly this content:

````markdown
---
name: database-conventions
description: Use when touching shared/schema.ts, writing or modifying a scripts/manual-migration-NNN.mjs script, or adding/editing a method in server/storage.ts
---

# Database Conventions

## Overview

This project's data layer (Drizzle ORM + Neon Postgres, multi-tenant) has five non-negotiable rules, each traced to a real bug or incident. Follow them exactly; don't "improve" around them.

## Rules

### 1. Every tenant-scoped query filters on `organizationId` — no exceptions

Six `upsertX` methods in `server/storage.ts` shipped without this in their conflict condition and had to be fixed after the fact. Two real patterns are in use — pick the one that matches your conflict target:

- **Composite unique target** (target already includes `organizationId`):
  ```ts
  .onConflictDoUpdate({
    target: [emissionFactorsTable.organizationId, emissionFactorsTable.name],
    set: { /* ... */ },
  })
  ```
  (`server/storage.ts:740-741`)

- **Single-column target** (the target is a bare id/foreign key; `organizationId` isn't part of it): add a `setWhere` guard and check the result exists, since a matching row from a *different* org would otherwise silently update:
  ```ts
  .onConflictDoUpdate({
    target: emissionRecordsTable.calculationApproachId,
    set: data,
    setWhere: eq(emissionRecordsTable.organizationId, data.organizationId),
  })
  .returning();
  if (!row) {
    throw new Error("...: conflicting row belongs to a different organization");
  }
  ```
  (`server/storage.ts:813-820`)

Every new `upsertX`/conflict-handling method: check which pattern applies before writing it — don't assume the composite-target case is the only one.

### 2. Idempotent hand-written migrations only — `drizzle-kit push` is retired

Confirmed broken across three early attempts against this schema/environment. Every migration is `scripts/manual-migration-NNN.mjs` (find the highest existing `NNN` on disk and use the next integer), following the same shape: `information_schema` check before any DDL change, `applied`/`skipped` tracking per step, wrapped in one transaction, safe to re-run against a database that's already partway through.

### 3. `db.batch()`, never `.transaction()`

`drizzle-orm/neon-http` throws at runtime on `.transaction()` — this has bitten prior work. `db.batch([...])` is the only atomic multi-statement primitive this driver supports.

### 4. `undefined` omits, `null` clears — know which one you're sending

`onConflictDoUpdate`'s `set` filters `undefined` keys out of the `SET` clause entirely but writes an explicit `null` as-is. Getting this backwards on a field like `gasBreakdown` silently wipes a persisted per-gas audit trail on an unrelated partial re-save (see the rationale comment at `server/storage.ts:306-310`). When building a partial update object, be deliberate about which fields are `undefined` (leave untouched) vs. `null` (clear).

### 5. Destructive operations are two genuinely separate steps

Dry-run that prints exactly what will be affected → hard stop to actually read that output → separate execution step, only after confirming nothing unexpected showed up. Never chain check-then-delete in one script run. Established after a real incident (2026-09-09): a chained dry-run+delete script removed an organization without pausing to react to its own diagnostic output.
````

- [ ] **Step 2: Verify frontmatter is well-formed**

Run:

```bash
node -e "
const fs = require('fs');
const content = fs.readFileSync('.claude/skills/database-conventions/SKILL.md', 'utf8');
const match = content.match(/^---\n([\s\S]*?)\n---/);
if (!match) { console.error('FAIL: no frontmatter block found'); process.exit(1); }
const fm = match[1];
if (!/^name:\s*database-conventions\s*$/m.test(fm)) { console.error('FAIL: name field missing or does not equal database-conventions'); process.exit(1); }
if (!/^description:\s*Use when.+$/m.test(fm)) { console.error('FAIL: description field missing or does not start with Use when'); process.exit(1); }
console.log('PASS: frontmatter valid');
"
```

Expected: `PASS: frontmatter valid`

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/database-conventions/SKILL.md
git commit -m "docs: add database-conventions project skill"
```

---

### Task 2: `ghg-domain-conventions` skill

**Files:**
- Create: `.claude/skills/ghg-domain-conventions/SKILL.md`

**Interfaces:**
- Produces: a discoverable project skill named `ghg-domain-conventions`, triggered when touching emission-factor selection, GWP values, calculation-approach logic, biogenic CO2 handling, unit conversion, or a reporting boundary's finalized state. Independent of Task 1 — no shared interface.

- [ ] **Step 1: Create the skill file**

Create `.claude/skills/ghg-domain-conventions/SKILL.md` with exactly this content:

````markdown
---
name: ghg-domain-conventions
description: Use when touching emission-factor selection, GWP values, calculation-approach logic, biogenic CO2 handling, unit conversion, or a reporting boundary's finalized state
---

# GHG Domain Conventions

## Overview

This product's core purpose is producing GHG numbers meant to survive third-party verification. A wrong rule here doesn't just break code — it produces a wrong number in a statement someone else is going to audit. These rules are stricter than typical application logic for that reason.

## Rules

### 1. GWP values are versioned and sourced, never hardcoded

Every gas's GWP-100 comes from the live `gwp_values` table (`shared/schema.ts:1401`), AR6 by default, `gwpVersion` tagged at the schema level (`shared/schema.ts:1406`) — not typed into a script or component twice. If a calculation needs a GWP, query the table; don't inline a remembered value.

### 2. Emission factor sourcing hierarchy, enforced in order

local/site-specific → national → regional → named global agencies (IEA, IPCC EFDB, UNFCCC, GHG Protocol, DEFRA) → IPCC generic defaults. Any IPCC-default substitution must be flagged via `usedIpccDefaultFactor` + `ipccDefaultSubstitutionReason` (`shared/schema.ts:1145-1146`) — never a silent fallback to IPCC generic.

### 3. Every selected emission factor carries a traceable source

`emissionFactorSourceUrl` + `emissionFactorAuthorityName` (`shared/schema.ts:983-984`) ride alongside the factor value itself. A factor with a number but no source is incomplete.

### 4. Biogenic CO2 is a memo item, never counted in gross totals

Pulled out of Scope 1/2/3 gross figures and reported separately, per GHG Protocol/ISO convention.

### 5. The server recomputes emissions itself, never trusts a client-submitted total

Whenever both a quantity and a factor are present, `calculatedEmissionsTco2e` is derived server-side — see `server/calculations/emission-calculation.ts`'s `calculateEmission` for the canonical, unit-tested implementation. A client-submitted total is never persisted as-is.

### 6. Only the sanctioned unit-conversion path is allowed

Weight-basis (kg/tonnes) against an energy-basis (TJ) factor converts via the fuel's net calorific value; anything else (e.g. a volume-basis unit like litres) is rejected with an explicit error, never guessed. `calculateEmission` (`server/calculations/emission-calculation.ts`) is the single enforcement point — its `status: "rejected"` branch is this rule working as intended, not a bug to "fix" by adding a guessed conversion.

### 7. A finalized reporting boundary is immutable

ISO 14064-3 treats a GHG statement as a fixed, dated snapshot. Once `reportingBoundaries.status = "finalized"`, no route writes to its scoped data without going through the explicit, reasoned recalculate flow. The practical enforcement point is `finalizedLockMessage()` (`server/routes.ts:396`) — see the `api-conventions` skill for how routes must call it.
````

- [ ] **Step 2: Verify frontmatter is well-formed**

Run:

```bash
node -e "
const fs = require('fs');
const content = fs.readFileSync('.claude/skills/ghg-domain-conventions/SKILL.md', 'utf8');
const match = content.match(/^---\n([\s\S]*?)\n---/);
if (!match) { console.error('FAIL: no frontmatter block found'); process.exit(1); }
const fm = match[1];
if (!/^name:\s*ghg-domain-conventions\s*$/m.test(fm)) { console.error('FAIL: name field missing or does not equal ghg-domain-conventions'); process.exit(1); }
if (!/^description:\s*Use when.+$/m.test(fm)) { console.error('FAIL: description field missing or does not start with Use when'); process.exit(1); }
console.log('PASS: frontmatter valid');
"
```

Expected: `PASS: frontmatter valid`

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/ghg-domain-conventions/SKILL.md
git commit -m "docs: add ghg-domain-conventions project skill"
```

---

### Task 3: `api-conventions` skill

**Files:**
- Create: `.claude/skills/api-conventions/SKILL.md`

**Interfaces:**
- Produces: a discoverable project skill named `api-conventions`, triggered when adding or modifying an Express route. Independent of Tasks 1-2 — no shared interface, though its body cross-references `ghg-domain-conventions` by name (a documentation reference only, not a code dependency).

- [ ] **Step 1: Create the skill file**

Create `.claude/skills/api-conventions/SKILL.md` with exactly this content:

````markdown
---
name: api-conventions
description: Use when adding or modifying an Express route in server/routes.ts, including its auth, rate limiting, validation, or response shape
---

# API Conventions

## Overview

How routes get written in this codebase, including the security-relevant parts (auth, rate limiting, password handling) folded in directly — at this project's actual scale (solo developer, MVP stage), the real security rules mostly ARE about how a route is written.

## Rules

### 1. Every tenant-scoped route: `requireAuth` + `requireOrg`, no exceptions

Cross-tenant (super-admin) routes use `requireAuth` + `requireSuperAdmin` instead (`server/middleware/tenant.ts`, `server/middleware/admin.ts`) — never both together on the same route. A route is one or the other, not a hybrid.

### 2. Before any write to a reporting-boundary-scoped resource, check `finalizedLockMessage`

The practical enforcement of `ghg-domain-conventions`' immutability rule. Call `finalizedLockMessage(organizationId, reportingBoundaryId)` (`server/routes.ts:396`) before the write; if it returns a non-null message, reject with `409`. Real usages: `server/routes.ts:1882, 1903, 1958, 2443, 2463`.

### 3. Response envelope keys are singular-camelCase, matching the resource

`{ sourceStream }` / `{ sourceStreams }`, `{ calculationApproach }`, `{ measurementApproach }`, `{ dataQualityRecord }` (`server/routes.ts:2398, 2476, 2613, 2720`) — singular for a single resource, plural for a list, named after the resource, not a generic `data`/`result` wrapper.

### 4. Optional-but-sent-as-empty-string fields use the trim+transform pattern

Never bare `.min(1).optional()` — a controlled form input's default value is `""`, not `undefined`, so `.optional()` alone still rejects an empty string with "must contain at least 1 character." Trim first and fold `""`/whitespace-only into `undefined` so a genuinely blank field passes, while a name that's just spaces still doesn't get stored as one:

```ts
z.string().trim().optional().transform((v) => (v && v.length > 0 ? v : undefined))
```

(`shared/schema.ts:120-124`, where a real registration bug shipped from getting this wrong.)

### 5. Server-side validation always duplicates client-side validation

A client-side check is never the only gate — the server re-validates independently.

### 6. Security baseline for auth-sensitive routes

bcrypt hashing, `SALT_ROUNDS = 12` (`server/auth.ts:6`); rate limiting via `express-rate-limit` on register/login/forgot-password/resend-verification (`registerLimiter`, `loginLimiter`, `forgotPasswordLimiter`, `resendVerificationLimiter` in `server/routes.ts`); every access-control action logged regardless of actor tier; no admin route ever sets or sees a user's actual password.
````

- [ ] **Step 2: Verify frontmatter is well-formed**

Run:

```bash
node -e "
const fs = require('fs');
const content = fs.readFileSync('.claude/skills/api-conventions/SKILL.md', 'utf8');
const match = content.match(/^---\n([\s\S]*?)\n---/);
if (!match) { console.error('FAIL: no frontmatter block found'); process.exit(1); }
const fm = match[1];
if (!/^name:\s*api-conventions\s*$/m.test(fm)) { console.error('FAIL: name field missing or does not equal api-conventions'); process.exit(1); }
if (!/^description:\s*Use when.+$/m.test(fm)) { console.error('FAIL: description field missing or does not start with Use when'); process.exit(1); }
console.log('PASS: frontmatter valid');
"
```

Expected: `PASS: frontmatter valid`

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/api-conventions/SKILL.md
git commit -m "docs: add api-conventions project skill"
```

---

### Task 4: Trim `CLAUDE.md`, update `INDEX.md`

**Files:**
- Modify: `CLAUDE.md:64-107` (the "Known gaps" bullet list and the "Stack and architecture rules" section)
- Modify: `docs/superpowers/INDEX.md` (skills initiative row; "Next priorities" section)

**Interfaces:**
- Consumes: the three skill names created in Tasks 1-3 (`database-conventions`, `ghg-domain-conventions`, `api-conventions`) — referenced by name only, as documentation pointers.

- [ ] **Step 1: Remove the closed "Known gaps" bullet in `CLAUDE.md`**

In the "Known gaps against the playbook's later stages" list, remove this bullet (currently `CLAUDE.md:66-68`):

```markdown
- No `.claude/skills/` directory of project-specific policy skills (only generic `superpowers`
  process skills are in use) -- conventions like the `organizationId`-scoping rule below live only
  in this file and in code comments, not in a discoverable skill.
```

The gap is fully closed by Tasks 1-3, not partially — remove the bullet entirely rather than rewording it (this project's established precedent for a fully-closed gap, e.g. the GWP version-tagging gap, is removal with a pointer left where the fact now lives — not a struck-through or "no longer true" bullet left in place).

- [ ] **Step 2: Trim the "Stack and architecture rules" section**

Replace this block (currently `CLAUDE.md:84-107`):

```markdown
## Stack and architecture rules (non-negotiable)

- React + TypeScript client (Vite), Express server, Drizzle ORM, Postgres (Neon),
  passport-local + session auth.
- Every tenant-scoped table query must filter on `organizationId`. No exceptions. A prior session
  found and fixed 6 `upsertX` methods in `server/storage.ts` missing `organizationId` in their
  `onConflictDoUpdate` conflict condition -- treat this class of bug as a standing thing to check
  in any new upsert method, not a one-off.
- `drizzle-kit push` is retired for this project -- confirmed broken across three early attempts.
  Use hand-written idempotent migration scripts (`scripts/manual-migration-NNN.mjs`) instead --
  `information_schema` checks before any DDL change, `applied`/`skipped` tracking, wrapped in one
  transaction, safe to re-run. Latest is `015`; the next one is `016`.
- GWP values: sourced from the `gwp_values` table, versioned (AR6 by default, `gwpVersion` column
  present at the schema level, not just in the static reference xlsx) -- the version-tagging gap
  this file used to list as open is closed.
- Emission factor sourcing hierarchy: local/site-specific -> national -> regional -> named global
  agencies (IEA, IPCC EFDB, UNFCCC, GHG Protocol, DEFRA) -> IPCC generic defaults, in that order,
  with any IPCC-default substitution flagged in the data quality fields. Never silently default to
  IPCC generic.
- Any destructive database operation runs as two genuinely separate steps: (1) a dry-run that
  prints exactly what will be affected, (2) a hard stop to actually read that output, (3) a
  separate execution step, only after confirming nothing unexpected showed up. Established after a
  real incident (2026-09-09: a chained dry-run+delete script removed an org without pausing to
  react to its own diagnostic output). Never chain check-then-delete in one script run again.
```

with:

```markdown
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
```

- [ ] **Step 3: Update the skills row in `docs/superpowers/INDEX.md`'s Platform/process initiatives table**

Read the file first and confirm this row is still present verbatim (it was last touched in commit `c381db8` — if other work has since changed it, stop and report rather than guessing at a merge). Replace:

```markdown
| `.claude/skills/` (project-specific policy skills) — [intent](intents/2026-09-11-claude-skills-intent.md) · [spec](specs/2026-09-11-claude-skills-design.md) | Spec approved | Design done 2026-09-11: three skills (`database-conventions`, `ghg-domain-conventions`, `api-conventions`), `CLAUDE.md`'s overlapping bullets to be trimmed to one-liners + pointers once built. Plan not yet written. Real prerequisite for PR review per the playbook's own dependency graph ("PR review requires updated CLAUDE.md and skills"). |
```

with:

```markdown
| `.claude/skills/` (project-specific policy skills) — [intent](intents/2026-09-11-claude-skills-intent.md) · [spec](specs/2026-09-11-claude-skills-design.md) · [plan](plans/2026-09-11-claude-skills.md) | Shipped | Implemented 2026-09-11: all three skills created (`database-conventions`, `ghg-domain-conventions`, `api-conventions`) under `.claude/skills/`, `CLAUDE.md`'s overlapping bullets trimmed to one-liners + pointers. Closes the playbook's own dependency-graph prerequisite for PR review ("PR review requires updated CLAUDE.md and skills"). |
```

- [ ] **Step 4: Update "Next priorities, in order" in the same file**

Read the file first and confirm the section is still present verbatim as below (last revised in commit `c381db8` — if it has since changed, stop and report rather than guessing at a merge). Replace the entire numbered list:

```markdown
1. ~~Test suite (Stage 4, "Test — Feedback loop")~~ — **done.** Plan executed via
   `subagent-driven-development` 2026-09-11 (2 tasks, 1 escalated finding ruled on by the product
   owner, final whole-branch review + fix wave + scoped re-review, all clean), merged to `main`
   (fast-forward, commit `9bd3666`). `npm run check` and `npm run test` both verified green on the
   merged tree post-merge.
2. **Deploy-stage pair, per the product owner's 2026-09-11 instruction given right after the
   merge:** `REVIEW.md` + PR-gated deploy (AI PR review), and Hooks as approval gates. Sequencing
   between/within these two not yet finalized — see the flagged dependency-graph conflict below
   before starting either.
3. **Resume the paused Hooks (build-time guardrails) execution** — worktree already created and
   ready at `.claude/worktrees/build-hooks` (branch `worktree-build-hooks`), dependencies
   installed, baseline `npm run check` verified clean, Task 1's implementer not yet dispatched.
   Nothing to redo, just re-enter and continue when this becomes the priority again. Distinct
   initiative from item 2's "Hooks as approval gates" — this one is protected-path/credential-scan/
   formatting guardrails during a session, not deploy-time gating.
4. `.claude/skills/` — spec approved, plan not yet written. **Also a documented prerequisite for
   item 2's PR-review piece** ("PR review requires updated CLAUDE.md and skills" per the playbook's
   own dependency graph, and the skills initiative row below says the same) — this is the flagged
   conflict: the product owner's new ordering puts REVIEW.md/PR-review ahead of skills, but the
   playbook's own dependency graph says skills must come first. Not resolved silently; surfaced for
   a decision before either piece of item 2 starts.
5. **Once Hooks' full repo-wide Prettier reformat actually lands** (still pending — item 3 above
   hasn't run yet, so this hasn't triggered): refresh the stale `file:line` anchors throughout
   [`docs/superpowers/plans/2026-09-10-document-extraction.md`](plans/2026-09-10-document-extraction.md)
   — the reformat will shift line numbers repo-wide, and this plan's task steps reference exact
   lines (`server/routes.ts:2478`, `BoundaryWorkspace.tsx:621`, etc.) that go stale the moment
   that happens. **Do this before resuming any other feature build**, document extraction
   included — do not execute that plan against stale line references.
6. Everything else (document extraction itself, Stage 6 monitoring) resumes only after 1-5 above
   are done.
```

with:

```markdown
1. ~~Test suite (Stage 4, "Test — Feedback loop")~~ — **done.** Plan executed via
   `subagent-driven-development` 2026-09-11 (2 tasks, 1 escalated finding ruled on by the product
   owner, final whole-branch review + fix wave + scoped re-review, all clean), merged to `main`
   (fast-forward, commit `9bd3666`). `npm run check` and `npm run test` both verified green on the
   merged tree post-merge.
2. ~~`.claude/skills/`~~ — **done.** Implemented 2026-09-11 via
   [`docs/superpowers/plans/2026-09-11-claude-skills.md`](plans/2026-09-11-claude-skills.md): all
   three skills created, `CLAUDE.md` trimmed to point at them. This closes the dependency-graph
   conflict this section previously flagged — asked of the product owner 2026-09-11, answer was
   "build skills first, then REVIEW.md." `REVIEW.md`/PR-review is now unblocked.
3. **Deploy-stage pair, now the active priority (unblocked by item 2 above):** `REVIEW.md` +
   PR-gated deploy (AI PR review), and Hooks as approval gates. Sequencing between/within these two
   not yet finalized.
4. **Resume the paused Hooks (build-time guardrails) execution** — worktree already created and
   ready at `.claude/worktrees/build-hooks` (branch `worktree-build-hooks`), dependencies
   installed, baseline `npm run check` verified clean, Task 1's implementer not yet dispatched.
   Nothing to redo, just re-enter and continue when this becomes the priority again. Distinct
   initiative from item 3's "Hooks as approval gates" — this one is protected-path/credential-scan/
   formatting guardrails during a session, not deploy-time gating.
5. **Once Hooks' full repo-wide Prettier reformat actually lands** (still pending — item 4 above
   hasn't run yet, so this hasn't triggered): refresh the stale `file:line` anchors throughout
   [`docs/superpowers/plans/2026-09-10-document-extraction.md`](plans/2026-09-10-document-extraction.md)
   — the reformat will shift line numbers repo-wide, and this plan's task steps reference exact
   lines (`server/routes.ts:2478`, `BoundaryWorkspace.tsx:621`, etc.) that go stale the moment
   that happens. **Do this before resuming any other feature build**, document extraction
   included — do not execute that plan against stale line references.
6. Everything else (document extraction itself, Stage 6 monitoring) resumes only after 1-5 above
   are done.
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/superpowers/INDEX.md
git commit -m "docs: trim CLAUDE.md to point at new skills, mark skills initiative shipped"
```

---

## Verification

1. `ls .claude/skills/*/SKILL.md` — three files exist, one per skill.
2. All three `node -e` frontmatter checks (Task 1-3, Step 2) print `PASS`.
3. `npm run check` — stays clean (no code was touched, this confirms nothing was accidentally broken).
4. Manual read-through: open each `SKILL.md` and confirm every file-path/line-number citation still matches the live codebase (line numbers can drift if other work lands on `main` between plan-writing and execution — re-verify with `Grep`/`Read` at execution time, don't trust the numbers in this plan blindly).
5. **Behavioral spot-check (manual, per the approved spec — not scripted):** once all three skills exist, the controlling session (not a task implementer) dispatches one short, fresh subagent per skill with a plausible task in its trigger area (e.g. "add a new tenant-scoped upsert method to server/storage.ts" for `database-conventions`) and confirms the skill's guidance is reflected in the subagent's approach. Done once, after Task 4, not as part of any task's own steps.
