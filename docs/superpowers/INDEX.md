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
| Activity-data document extraction | [intent](intents/2026-09-10-document-extraction-intent.md) | [spec](specs/2026-09-10-document-extraction-design.md) | [plan](plans/2026-09-10-document-extraction.md) | Planned | Plan written 2026-09-10, execution not started. Needs `GEMINI_API_KEY` + `BLOB_READ_WRITE_TOKEN` provisioned (project owner only) before it's testable end to end. |
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
| `.claude/skills/` (project-specific policy skills — security standards, API conventions, organizationId-scoping rule, idempotent-migration pattern, two-step destructive-DB-op rule) | Not started | Real prerequisite for PR review per the playbook's own dependency graph ("PR review requires updated CLAUDE.md and skills"). CLAUDE.md side is done; this is the other half. |
| Hooks (build-time guardrails) | Not started | No prerequisite in the playbook's dependency graph — available to start independently of everything else above. |
| Test suite | Not started | Zero `.test.`/`.spec.` files anywhere in the repo. `npm run verify` (`scripts/verify-branch.mjs`) + standalone `verify-*.mjs` scripts are real end-to-end smoke checks, happy-path only, not a regression net. |
| CI/CD | Not started | No `.github/` directory at all — not even lint/typecheck on push. |
| `REVIEW.md` + PR-gated deploy | Not started | No PR workflow exists today — direct commits to `main`, approved per-instance in chat (see `CLAUDE.md`'s Merge Policy section). Requires `.claude/skills/` first per the playbook's dependency graph. |
| Stage 6 monitoring / control-band alerting / autonomous maintenance loop | Not started | |
