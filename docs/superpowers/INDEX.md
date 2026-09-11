# Project Index

**What this file is:** the one place to look to know where the whole project stands, without
reading every spec/plan file or the codebase itself. One row per feature or process initiative.
Detail lives in the linked `intent.md`/`spec.md`/`plan.md` files — this table is pointers and
current status only, kept short on purpose.

**Maintenance rule:** this file is updated in the *same commit* as any intent/spec/plan file
being created, or any row's status changing — never a separate remembered chore. Two other
coordination docs in this repo (`HANDOFF-SESSION.md`, `docs/iso-controls-matrix.md`) went stale
by weeks because updating them wasn't tied to the change that made them stale. This file exists
specifically so that doesn't happen a third time.

**Stage vocabulary:** Intent captured → Spec approved → Plan written → Building → Shipped, with
Deferred / On hold / Not started / Status unknown / Superseded for work that isn't moving through
that pipeline right now.

## Next priorities, in order

Explicit sequencing, not just per-row status — set 2026-09-11 by the product owner, revised same
day, binding until revised again here.

1. **Test suite (Stage 4, "Test — Feedback loop")** — flagged 2026-09-11 ("This step needs to be
   built"), interrupting Hooks execution mid-setup to take it up. Spec approved same day (first
   slice: emission-calculation arithmetic); plan not yet written. Still the active priority.
2. **Resume the paused Hooks execution** — worktree already created and ready at
   `.claude/worktrees/build-hooks` (branch `worktree-build-hooks`), dependencies installed,
   baseline `npm run check` verified clean, Task 1's implementer not yet dispatched. Nothing to
   redo, just re-enter and continue when this becomes the priority again.
3. `.claude/skills/` — spec approved, plan not yet written.
4. **Once Hooks' full repo-wide Prettier reformat actually lands** (still pending — item 2 above
   hasn't run yet, so this hasn't triggered): refresh the stale `file:line` anchors throughout
   [`docs/superpowers/plans/2026-09-10-document-extraction.md`](plans/2026-09-10-document-extraction.md)
   — the reformat will shift line numbers repo-wide, and this plan's task steps reference exact
   lines (`server/routes.ts:2478`, `BoundaryWorkspace.tsx:621`, etc.) that go stale the moment
   that happens. **Do this before resuming any other feature build**, document extraction
   included — do not execute that plan against stale line references.
5. Everything else (document extraction itself, the remaining playbook gaps — CI/CD, `REVIEW.md`,
   Stage 6 monitoring) resumes only after 1-4 above are done.

## Product features

| Feature | Intent | Spec | Plan | Stage | Status |
|---|---|---|---|---|---|
| Production readiness roadmap | — | — | [plan](plans/2026-08-12-production-readiness-roadmap.md) | Superseded | Pre-dates the per-feature intent/spec/plan convention. The subsystems it roadmapped were each individually designed and built via the rows below; nothing in it is still open on its own terms. |
| Verification-ready multi-facility inventory | — | [spec](specs/2026-08-14-verification-ready-multi-facility-inventory-design.md) | [01: schema](plans/2026-08-14-verification-ready-inventory-01-schema-migration.md) · [02: calc+persistence](plans/2026-08-14-verification-ready-inventory-02-calculation-and-persistence.md) · [03: rollup](plans/2026-08-14-verification-ready-inventory-03-consolidated-rollup-view.md) · [04: jurisdiction+legacy](plans/2026-08-14-verification-ready-inventory-04-jurisdiction-picker-and-legacy-retirement.md) | Shipped | Source streams, calculation/measurement/fallback approaches, base year + rationale, three consolidation approaches, finalize/recalculate snapshot lock. |
| Excel verifier export | — | [spec](specs/2026-08-15-excel-verifier-export-design.md) | [plan](plans/2026-08-15-excel-verifier-export.md) | Shipped | `server/utils/xlsx-export.ts`, `server/utils/ead-template-fill.ts`. |
| Report module architecture | — | [spec](specs/2026-08-15-report-module-architecture-design.md) | [plan](plans/2026-08-15-report-module-architecture.md) | Shipped | `client/src/components/OrganizationReport.tsx` + `getConsolidatedReport`. |
| Scope 2 dual reporting | — | [spec](specs/2026-08-15-scope2-dual-reporting-design.md) | [plan](plans/2026-09-02-scope2-dual-reporting.md) | Shipped | Location-based + market-based, both required on electricity source streams. |
| Scope 3 factor library (EXIOBASE) | — | [spec](specs/2026-09-02-scope3-factor-library-design.md) | [plan](plans/2026-09-02-scope3-factor-library.md) | Shipped | `exiobase_factors` table populated. Pipeline itself documented separately: `scripts/exiobase/README.md`. **Non-commercial license** — get a commercial license from `exiobase-support@googlegroups.com` before selling a product surfacing this data. |
| Registration hardening | — | [spec](specs/2026-09-03-registration-hardening-design.md) | [plan](plans/2026-09-03-registration-hardening.md) | Shipped | Email verification (Resend) + password complexity rules. |
| Membership/account lifecycle | — | [spec](specs/2026-09-04-membership-lifecycle-management-design.md) | [plan](plans/2026-09-04-membership-lifecycle-management.md) | Shipped | Deactivate/reactivate (membership + account), unified token-based password reset, two-tier permission model. |
| Super-admin control panel | — | [spec](specs/2026-09-04-super-admin-panel-design.md) | [plan](plans/2026-09-04-super-admin-panel.md) | Shipped, extended beyond its plan | Cross-tenant account directory, verify/delete/promote/demote, audit log. Extended 2026-09-09 (self-service name editor, real Privacy/Help pages, read-only cross-tenant GHG-data drill-down, optional org creation) directly in-session under deadline pressure, with no spec/plan of its own for the extension — an acknowledged process deviation, see `CLAUDE.md`'s Development Process section. |
| Platform BRD | — | [spec](specs/2026-09-09-platform-brd-structure-design.md) | — (writing task, no code — no `plan.md` needed) | Shipped | Published as a Claude Artifact ("GHG Calculator BRD"), 12 sections. |
| Activity-data document extraction | [intent](intents/2026-09-10-document-extraction-intent.md) | [spec](specs/2026-09-10-document-extraction-design.md) | [plan](plans/2026-09-10-document-extraction.md) | Planned | Plan written 2026-09-10, execution not started. Needs `GEMINI_API_KEY` + `BLOB_READ_WRITE_TOKEN` provisioned (project owner only) before it's testable end to end. **⚠️ Do not execute this plan until "Next priorities" item 2 above (refreshing its stale line references after the Hooks reformat) is done.** |
| Emissions-factors upload facility (EPA/EXIOBASE/IPCC tables, superadmin-only) | — | — (discussed in-session, never committed to a file) | — | On hold | Design presented and discussed; explicitly **not approved to build** ("think it over... do not attempt anything yet," reinforced twice). Distinct from document extraction above — this one is reference-factor tables, not a tenant's own activity data. |
| Tenant lifecycle governance (archive/unarchive, governed multi-step deletion) | — | — | — | Deferred by design | Approved concept, no design pass started. Binding constraint meanwhile: a tenant must never be deactivated/deleted as a side effect of any user or membership action. |
| Identity/profile decoupling (machine-allocated usernames, admin-assigned email as login identity, separate display name) | — | — | — | Deferred by design | Approved concept, needs its own brainstorming/design pass before building — touches `email`-as-identity everywhere (auth, sessions, invites, verification). |
| ESG Institute Carbon Calculator comparison | — | — | — | Status unknown | Flagged once in an earlier session as a to-do; never confirmed done or dropped since. Verify before assuming either way. |

## Platform/process initiatives (AI-native SDLC alignment, started 2026-09-10)

| Initiative | Stage | Status |
|---|---|---|
| `intent.md` → `spec.md` → `plan.md` artifact chain | Adopted | Established 2026-09-10 per https://claude.com/blog/the-ai-native-sdlc-playbook. Applied going forward; not backfilled onto the pre-existing specs/plans above (no value in reconstructing intent that was never recorded — this index's rows are the equivalent lightweight pointer instead). |
| `CLAUDE.md` as shared institutional knowledge | Done | Committed and refreshed 2026-09-10 (was git-ignored and 3+ weeks stale before). Critical subset of `ClaudeCowork/ABOUT ME/CLAUDE-TKS.md` carried over. |
| This index | Done | Created 2026-09-11. |
| `.claude/skills/` (project-specific policy skills) — [intent](intents/2026-09-11-claude-skills-intent.md) · [spec](specs/2026-09-11-claude-skills-design.md) | Spec approved | Design done 2026-09-11: three skills (`database-conventions`, `ghg-domain-conventions`, `api-conventions`), `CLAUDE.md`'s overlapping bullets to be trimmed to one-liners + pointers once built. Plan not yet written. Real prerequisite for PR review per the playbook's own dependency graph ("PR review requires updated CLAUDE.md and skills"). |
| Hooks (build-time guardrails) — [intent](intents/2026-09-11-build-hooks-intent.md) · [spec](specs/2026-09-11-build-hooks-design.md) · [plan](plans/2026-09-11-build-hooks.md) | Plan written, execution paused | **Paused 2026-09-11 at a clean, resumable checkpoint** — mid-way through kicking off `subagent-driven-development`, before Task 1's implementer was dispatched. Worktree already created and ready at `.claude/worktrees/build-hooks` (branch `worktree-build-hooks`), `npm install` done, `npm run check` baseline verified clean. Paused (not abandoned) to take up the Test-suite item below at the user's request. Resume by re-entering that worktree and dispatching Task 1 — no setup work is lost. Includes the full one-time repo-wide reformat that triggers "Next priorities" item 2 above (still applies once resumed). |
| Test suite — [intent](intents/2026-09-11-emission-calculation-test-suite-intent.md) · [spec](specs/2026-09-11-emission-calculation-test-suite-design.md) | Spec approved | First slice only (too large for one spec — decomposed during brainstorming): the GHG calculation arithmetic in `PUT /api/source-streams/:id/calculation-approach`, extracted to a pure `server/calculations/emission-calculation.ts`, tested with Vitest, 6 cases. Chosen over tenant-isolation and hooks-testing slices as the highest domain-correctness risk. Establishes the baseline "feedback loop" the playbook's Continuous Evals would later depend on — not that full gate itself. Plan not yet written. Full-codebase coverage remains a separate, larger, not-yet-scoped effort. |
| CI/CD | Not started | No `.github/` directory at all — not even lint/typecheck on push. |
| `REVIEW.md` + PR-gated deploy | Not started | No PR workflow exists today — direct commits to `main`, approved per-instance in chat (see `CLAUDE.md`'s Merge Policy section). Requires `.claude/skills/` first per the playbook's dependency graph. |
| Stage 6 monitoring / control-band alerting / autonomous maintenance loop | Not started | |
