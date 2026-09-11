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
4. ~~Resume the paused Hooks (build-time guardrails) execution~~ — **done.** Completed 2026-09-11
   via `subagent-driven-development` (4 tasks, 3 escalated plan-defect findings fixed --
   `isProtectedPath` fail-open, `isEnvFile` fail-closed, `npx` ENOENT on Windows -- plus a
   cross-task path-normalization consolidation, final whole-branch review + fix wave + scoped
   re-review, all clean). See the Hooks row below for what actually shipped.
5. ~~Refresh the stale `file:line` anchors throughout `document-extraction.md`~~ — **done.**
   Completed 2026-09-11: every anchor re-verified against the current tree (post emission-calc
   extraction and post Prettier reformat) and corrected in place — `server/storage.ts` (IStorage
   interface, `getCalculationApproach` insertion point), `server/routes.ts` (`calculationApproachSchema`
   span, the PUT handler's new span and internal insertion point — shifted ~90 lines by the
   emission-calc extraction alone), and `client/src/components/BoundaryWorkspace.tsx`
   (`CalculationApproachForm`'s start, the `save` mutation, the JSX insertion points — one of which
   changed shape, not just line number, since Prettier wrapped a previously single-line `Input`).
   `scripts/verify-branch.mjs`'s anchors were untouched by either change. Search-based anchors
   (`shared/schema.ts`) needed no correction.
6. Document extraction itself is now unblocked and ready to execute whenever prioritized. Stage 6
   monitoring remains not-yet-started, separately.

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
| Activity-data document extraction | [intent](intents/2026-09-10-document-extraction-intent.md) | [spec](specs/2026-09-10-document-extraction-design.md) | [plan](plans/2026-09-10-document-extraction.md) | Planned | Plan written 2026-09-10, execution not started. `file:line` references refreshed 2026-09-11 (see "Next priorities" item 5) — safe to execute now. Still needs `GEMINI_API_KEY` + `BLOB_READ_WRITE_TOKEN` provisioned (project owner only) before it's testable end to end. |
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
| `.claude/skills/` (project-specific policy skills) — [intent](intents/2026-09-11-claude-skills-intent.md) · [spec](specs/2026-09-11-claude-skills-design.md) · [plan](plans/2026-09-11-claude-skills.md) | Shipped | Implemented 2026-09-11: all three skills created (`database-conventions`, `ghg-domain-conventions`, `api-conventions`) under `.claude/skills/`, `CLAUDE.md`'s overlapping bullets trimmed to one-liners + pointers. Closes the playbook's own dependency-graph prerequisite for PR review ("PR review requires updated CLAUDE.md and skills"). **Behavioral spot-check (2026-09-11, per the approved spec's own testing method — 3 fresh subagents, one plausible task per skill's trigger area):** `database-conventions` and `api-conventions` both surfaced strongly — the subagents cited the exact `organizationId`/`setWhere` pattern with its incident history, and one even found and correctly explained a real existing route rather than re-deriving it. `ghg-domain-conventions` was mixed: given a direct request to add volume-basis unit conversion, the subagent found the real `calculateEmission` code but did not cite rule 6's explicit "reject, never guess" boundary — it planned to build the conversion the skill says not to build. Not a defect in the skill file (the rule is stated correctly and completely); flagged as a real limitation of reference-style skill guidance for zero-exception rules under a plausible direct request, not fixed here — a candidate for a future pass if this rule needs to hold under pressure, not just be documented (see `writing-skills`' "Match the Form to the Failure" guidance on discipline-enforcing vs. reference skills). |
| Hooks (build-time guardrails) — [intent](intents/2026-09-11-build-hooks-intent.md) · [spec](specs/2026-09-11-build-hooks-design.md) · [plan](plans/2026-09-11-build-hooks.md) | Shipped | **Completed 2026-09-11** — three hooks now live in `.claude/settings.json` (protected-paths.mjs, credential-scan.mjs, format-on-write.mjs), plus the one-time Prettier reformat from Task 3 (commit bfda6ca) landed and verified idempotent. Two plan-mandated path-normalization bugs found and fixed during execution: Task 1 (isProtectedPath fail-open on non-native path formats) and Task 2 (isEnvFile fail-closed false-positive on POSIX-style paths) — both escalated to the product owner before fixing, both now verified robust across 6+ path formats. |
| Test suite — [intent](intents/2026-09-11-emission-calculation-test-suite-intent.md) · [spec](specs/2026-09-11-emission-calculation-test-suite-design.md) · [plan](plans/2026-09-11-emission-calculation-test-suite.md) | Shipped (first slice) | GHG calculation arithmetic in `PUT /api/source-streams/:id/calculation-approach` extracted to pure `server/calculations/emission-calculation.ts` and tested with Vitest. First slice: 6 passing tests covering units matching, kilogram/tonne conversion via NCV, volume-basis rejection, missing-NCV rejection, and insufficient-data cases. Establishes baseline feedback loop for later Continuous Evals. Broader coverage (tenant-isolation, hooks, additional slices) remains separate, not-yet-scoped work. **Coverage gap (found during final review, 2026-09-11):** `PUT /api/source-streams/:id/calculation-approach` itself has no end-to-end/integration test coverage of its own — `npm run verify` does not reach it (confirmed by direct inspection of `scripts/verify-branch.mjs`, which only exercises the unrelated legacy `POST /api/calculate` endpoint); the product owner ruled independent manual code review plus these Vitest unit tests sufficient proof for this extraction instead. **Also found during that review (pre-existing, not introduced by this branch, not fixed here):** `calculateEmission` can silently produce wrong results on malformed input — a non-numeric `activityDataValue` (e.g. `"abc"`) yields `status: "computed"` with `computedEmissionKg: NaN`; an empty-string value yields `computedEmissionKg: 0` (silently treating a cleared field as zero emissions, rather than "not recorded"); and an `activityDataUnit` of `"constructor"` or `"__proto__"` resolves through `Object.prototype` in the `WEIGHT_UNITS_PER_GG` lookup, bypassing its `undefined` guard, also producing `NaN`. All three are reachable from real user input and would persist to Postgres as the string `"NaN"`. Flagged as candidate first cases for the next test-suite slice. |
| CI/CD | Not started | No `.github/` directory at all — not even lint/typecheck on push. |
| `REVIEW.md` + PR-gated deploy | Not started | No PR workflow exists today — direct commits to `main`, approved per-instance in chat (see `CLAUDE.md`'s Merge Policy section). Its playbook dependency (`.claude/skills/`) is now closed — see "Next priorities" item 3 above. |
| Stage 6 monitoring / control-band alerting / autonomous maintenance loop | Not started | |
