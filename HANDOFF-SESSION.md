# Session Handoff -- GHG Calculator SaaS (saas-multitenant)

Repo: https://github.com/teekaysharma/ghgcalculator, branch: saas-multitenant
Local clone: C:\Users\LENOVO\Documents\ClaudeCowork\OUTPUTS\ghgcalculator
Log file convention: redirect terminal output to log1.txt in that folder (overwritten each run), read it directly instead of pasting/attaching in chat -- chat attachments have failed repeatedly in this project.

This is the SaaS workstream, NOT the Electron workstream. The Claude Project's standing instructions describe the Electron desktop app at Batch 5 -- that is this Project's default framing, but this thread's actual work is the SaaS branch above. Treat this file as authoritative for this session.

**Ownership/brand note (2026-07-29):** this project is TeeKay's personal project, going commercial independently. It is NOT a SustainaCert International product, despite what this Claude Project's stored memory says. No code in this repo hardcodes a SustainaCert brand reference (checked). Flag this contradiction again if it resurfaces.

## State as of last session (2026-07-25, before this one)

saas-multitenant has multi-tenancy (organizations/users/memberships), real Postgres persistence (Neon), auth (passport-local + sessions), ISO 14064-1 boundary setup (reporting entities/facilities/reporting boundaries), a working login/register/setup/calculator/team UI, rate limiting, and two reference datasets bundled as static files: DEFRA/DESNZ 2026 UK conversion factors (3,425 rows) and an IPCC AR6 GWP reference (266 gases, corrected from a prior 268-gas defect).

## This session's work (2026-07-29)

**Constraints this session operated under, unchanged for the next session too unless the setup changes:** no shell/exec access to this machine (file read/write via Filesystem MCP only -- no `npm`, `tsc`, `git`, or `node` could be run), no `DATABASE_URL` (no live DB queries). Everything below was written and cross-checked by reading files back, not by compiling or running anything. Run `npm run check` (tsc) before trusting any of it compiles clean, and `node scripts/manual-migration-002.mjs` has never been executed against a real database.

1. **Investigated actual repo state** against the Claude Project's stored (stale) description and this file's prior claims -- confirmed the multi-tenancy, ISO 14064-1 boundary layer, and auth/session setup described above are real and match the code (read `shared/schema.ts`, `server/routes.ts`, `server/storage.ts`, `server/auth.ts`, `server/middleware/tenant.ts`, `server/index.ts`, `server/db.ts` in full). Confirmed the 266-gas GWP fix is present in the working tree (`client/src/components/WasteFactorGuide.tsx`) -- git commit status still not verified (no git access this session).

2. **Benchmarked against the EAD "Deliverable C" facility-level MRV Excel template** (attached this session, 14 sheets, all read directly). Finding: the current data model (`emission_records`: scope/activity/quantity/factor/emission) is a corporate-level GHG Protocol/ISO 14064-1 total model. EAD's template operates at source-stream and emission-source level with calculation-approach tiers (calculation-based / measurement-based / fallback), methane-specific reporting, verification/data-gap tracking, management & QA, and mitigation measures as structured data, not free text. Full findings in `GAP-ANALYSIS-2026-07-29.md` at repo root.

3. **Wrote a gap analysis** (`GAP-ANALYSIS-2026-07-29.md`, repo root) covering verified current state, known documented gaps (from README), newly identified gaps (hosting/deployment target undecided -- session-based auth via `connect-pg-simple`/`pg.Pool` is incompatible with Vercel-style serverless as-is; no billing/plan layer; no admin/ops surface), and the EAD granularity gap in detail.

4. **TeeKay's decisions on the two open forks**, both confirmed this session:
   - Hosting target: **not decided yet** -- proceed on the assumption of a persistent Node host (Railway/Render/Fly/VPS), which needs zero auth rewrite. Revisit if a serverless target is chosen later; that would require replacing session-based auth with token-based auth first.
   - Session scope: **start the EAD-equivalent rebuild now** (not "close known gaps first") -- the source-stream/calculation-tier schema below is the direct result.

5. **Added a "facility-level MRV granularity layer" to `shared/schema.ts`** (appended after the existing ISO 14064-1 boundary tables, ~600 lines): 12 new tenant-scoped tables (`facility_identifiers`, `facility_contacts`, `facility_products`, `source_streams`, `calculation_approaches`, `measurement_based_approaches`, `fallback_approaches`, `methane_reports`, `data_quality_records`, `verification_findings`, `management_qa_records`, `mitigation_measures`) plus 2 global reference tables (`primary_activity_types`, `product_benchmarks`). Framework-agnostic by design per the project's shared-foundation rule -- not an "EAD table set," a general facility-level MRV layer EAD (or ISO 14064-1, or GHG Protocol facility reporting) can sit on top of. Full verification-status caveat is in the file's own header comment: field structure comes from the EAD Excel template's structure, not from the EAD Technical Guidance document's clause text (that document was not read this session).

6. **Wrote `scripts/manual-migration-002.mjs`** (via subagent, then read back and cross-checked by a separate verification subagent): `CREATE TABLE IF NOT EXISTS` for all 14 tables, matching indexes/constraints, seed data for the two reference tables (8 primary activity types, 18 product benchmarks, sourced directly from the EAD workbook's "4k - Reference Lists" sheet). **Not run.**

7. **Extended `server/storage.ts`** (via subagent): `IStorage` interface + `DbStorage` implementations for all 12 new tables plus the 2 reference-data reads, 32 new methods total. Every org-scoped method filters on `organizationId`.

8. **Extended `server/routes.ts`** (via subagent): REST endpoints for every new entity, `requireAuth`+`requireOrg` gated (except the two `/api/reference/*` reads, which are `requireAuth`-only since reference data isn't tenant-scoped). Every create/upsert route verifies the parent resource (facility / reporting boundary / source stream) belongs to the caller's org before writing.

9. **Ran an independent verification pass** (separate subagent, read-only, adversarial) across all four files together. Result: migration DDL matches schema.ts exactly, column for column. All 12 tenant-scoped tables have correct route-layer ownership checks and correct storage-layer org-scoping on every get/list/update/delete. One residual finding, not currently exploitable but worth fixing -- see below.

## Known residual issue -- fix before this goes further

The six `upsertX` methods in `server/storage.ts` (`upsertFacilityIdentifier`, `upsertCalculationApproach`, `upsertMeasurementBasedApproach`, `upsertFallbackApproach`, `upsertMethaneReport`, `upsertDataQualityRecord`) use Drizzle's `onConflictDoUpdate({ target: <column>, set: data })` without including `organizationId` in the conflict-resolution condition. Every route that calls these today verifies the parent resource's org ownership first, so this is **not exploitable via the current API**. But it's a single layer of defense under this project's own zero-tolerance rule ("no query without organization_id in the WHERE clause") -- the moment any future route, script, or refactor calls one of these six methods without independently re-deriving the same ownership check, it becomes a silent cross-tenant overwrite.

Recommended fix, not yet applied (needs `npm run check` to confirm it compiles against the installed drizzle-orm version, `^0.39.1` -- I could not verify the exact `onConflictDoUpdate` API shape without exec access, so did not risk a blind edit to already-working code): add a `where` condition to each `onConflictDoUpdate` call scoping the update to rows where `organizationId` matches the incoming data, and throw explicitly if `.returning()` comes back empty (meaning a conflict existed but belonged to a different org) rather than silently returning `undefined`.

## Session update (2026-08-03)

Everything below this line reflects work done in a follow-on session, verifying and closing out items this file previously listed as open. Full detail in `VERIFICATION-2026-08-03.md` at repo root.

- Cross-checked `shared/schema.ts` against `scripts/manual-migration-002.mjs` column by column: full match on all 14 tables, no discrepancies.
- Cross-checked `server/storage.ts` and `server/routes.ts`: no org-scoping gaps beyond the six upsert methods already known. One documentation correction: actual new-method count is 39 (37 tenant-scoped + 2 reference reads), not 32.
- Applied the six-method upsert fix: `upsertFacilityIdentifier`, `upsertCalculationApproach`, `upsertMeasurementBasedApproach`, `upsertFallbackApproach`, `upsertMethaneReport`, `upsertDataQualityRecord` in `server/storage.ts` now each include `setWhere: eq(<table>.organizationId, data.organizationId)` on their `onConflictDoUpdate` call, plus an explicit throw if `.returning()` comes back empty (conflicting row belonged to a different org).
- TeeKay ran `npm run check`. First pass surfaced 2 pre-existing, unrelated errors (`client/src/Footer.tsx`, `server/vite.ts`, both untyped-object CSS/config literal widening issues) -- fixed. Second pass: clean, zero errors.
- TeeKay ran `node scripts/manual-migration-002.mjs` against his Neon database (his only one, no separate dev/test branch exists). Result: 58 statements applied, 0 skipped, clean first-time apply. All 14 tables + indexes now exist in the live database; 26 reference rows seeded.

## Session update (2026-08-04)

UI build for the facility-level MRV layer, per `UI-PLAN-2026-08-03.md` (repo root, canonical design plan, read that file for the full architecture rationale -- scope1/2/3 as the base taxonomy, ISO 14064-1's six categories not four, framework output-selector deferred, Excel-export scope).

- `scripts/manual-migration-003.mjs` run by TeeKay against the live Neon DB: 45 statements applied, 1 skipped (a no-op fix attempt -- the actual typo is in the client's EAD template cell, not the DB seed, which was already correct). Adds `source_streams.scope`/`scope3_category` (CHECK-constrained) and closes the two open FK gaps (`facility_identifiers.primary_activity_type_id`, `facility_products.product_benchmark_id`).
- `npm run check`: clean, zero errors (re-run by TeeKay after the migration-003 schema/routes.ts changes).
- Built `client/src/components/FacilityProfile.tsx` -- identifier/contacts/products/mitigation-measures tabs for one facility, `FacilityProfile({ facilityId })`.
- Built `client/src/components/BoundaryWorkspace.tsx` -- source-streams (with the mandatory scope picker -> quantification-approach picker -> data-quality-with-IPCC-flag flow described in the UI plan), methane report, verification findings, management QA tabs for one (facility, reportingBoundary) pair, `BoundaryWorkspace({ facilityId, reportingBoundaryId })`.
- Built `client/src/components/AppShell.tsx` -- the navigation shell: Setup / Facilities / Boundary Workspace / Scope 1/2/3 Calculator / Team sections, no new wouter routes (client-side state, matching the existing single-route pattern). Facilities and Boundary Workspace sections do their own entity/boundary/facility picking before rendering `FacilityProfile`/`BoundaryWorkspace`.
- Updated `client/src/pages/Home.tsx` to render `<AppShell />` in place of the old flat `<SetupPanel><EmissionCalculator/></SetupPanel><TeamPanel/>` body. Header/footer/logout unchanged.
- Ran an independent verification pass (separate subagent) on every API response-envelope key `FacilityProfile.tsx`/`BoundaryWorkspace.tsx` rely on, against the actual `server/routes.ts` handlers. Found and fixed 4 wrong assumptions in `FacilityProfile.tsx`: the facility-scoped routes return unprefixed keys (`identifier`, `contacts`, `products`, `measures`), not the `facilityIdentifier`/`facilityContacts`/`facilityProducts`/`mitigationMeasures` originally assumed by convention. `BoundaryWorkspace.tsx`'s 3 flagged assumptions (`finding` singular create/update key, `managementQaRecord` update key) were all confirmed correct as written, no fix needed.
- Not yet built: the framework output-selector (ISO 14064-1 six-category / GHG Protocol scope-subcategory / EAD-shape view toggle) -- deliberately scoped out of this round per my own build-order call even though TeeKay's original answer was "same phase" -- and the Audit View with its two separate export paths (generic Excel export of the on-screen audit view; and the official EAD-template-fill, which must never touch the template's own formulas, only data cells). Both remain open, see UI-PLAN-2026-08-03.md's revised build order.

`npm run check` re-run by TeeKay after AppShell.tsx/Home.tsx/the FacilityProfile+BoundaryWorkspace fixes: clean, zero errors.

**Needs TeeKay:** manually click through Setup -> Facilities -> Boundary Workspace in the running app (`npm run dev`) -- no runtime verification was possible this session (no shell access), only compile-time (tsc) is confirmed clean.

## Session update (2026-08-07)

Two threads from TeeKay reviewing the running UI directly for the first time.

DEFRA/AR6 factor selection (discussed, not yet built): confirmed the app already ships both client/public/emission-factors-template.xlsx (the real 3,425-row DEFRA 2026 dataset, despite the generic filename) and client/public/gwp-ar6-reference.xlsx (266-gas AR6 GWP table), but the only path into the calculator today is download-then-manually-reupload through the Waste Factor Format Guide dialog. Agreed idea: one-click load-DEFRA / include-AR6 buttons that read the bundled files server-side instead of round-tripping through downloads. Not built yet -- should be a shared factor-picker usable from both the old scope1/2/3 calculator and the new source-stream CalculationApproachForm (currently plain free-text factor fields, no lookup).

Primary activity classification -- expanded to ISIC Rev.4 (built): facility Primary activity used a primaryActivityTypeId FK into an 8-item list sourced verbatim from the EAD template's own dropdown validation (confirmed complete against the template, not an extraction bug -- just narrow, EU-ETS-benchmark-specific). TeeKay chose to replace it with ISIC Rev.4 (UN Statistics Division global standard, confirmed via direct fetch of the authoritative source text at unstats.un.org, not Rev.5 which exists but is still only partially published), at division-level granularity (88 divisions under 21 sections, two-level picker).

- shared/schema.ts: new global reference table isicDivisions (sectionCode, sectionName, divisionCode, divisionName), plus nullable facilityIdentifiers.isicDivisionId FK. primaryActivityTypeId/primaryActivityTypes untouched, left for a future EAD-export mapping.
- scripts/manual-migration-004.mjs (new, not yet run): creates isic_divisions, adds facility_identifiers.isic_division_id, seeds all 88 divisions. Needs TeeKay to run it against the live Neon DB, same as migrations 002/003.
- server/storage.ts / server/routes.ts: listIsicDivisions(), new GET /api/reference/isic-divisions route ({ isicDivisions: [...] }), and isicDivisionId added to the local zod schema for the facility-identifier PUT route (the migration-003-style silent-stripping bug class, checked and avoided this time).
- client/src/components/FacilityProfile.tsx: IdentifiersTab's Primary activity field is now a two-level section-then-division picker bound to isicDivisionId. The old primaryActivityTypeId Select was removed from the rendered form but its query/state/save-mutation line are left in place, unused, for future EAD-export use. Activity description free-text field unchanged.
- ISIC-TO-EAD-MAPPING-2026-08-07.md (new, repo root): best-effort ISIC-division -> EAD-category mapping for whoever eventually builds the EAD export. Flags divisions 23 (cement vs glass) and 24 (iron/steel vs aluminium) as genuinely ambiguous at division-level granularity, must not be auto-resolved without human confirmation; division 07 (metal ore roasting/sintering) flagged as a weak match. Not wired into any code.

Needs TeeKay: run npm run check, then node scripts/manual-migration-004.mjs against the Neon DB, then reload the app and check Facilities > Identifiers renders the new two-level picker correctly.

## Not yet done

- DEFRA/AR6 one-click factor-selection buttons (agreed, not built).
- Framework output-selector (ISO 14064-1 / GHG Protocol / EAD view toggle over the same scope-tagged data) and the Audit View + Excel export (generic + EAD-template-fill) -- see UI-PLAN-2026-08-03.md.
- Vercel deployment adaptation (still open, hosting target undecided, persistent Node host assumed per TeeKay's 07-29 decision).
- Real email-based invite flow, password reset -- both still open from before this session.
- No billing/plan layer, no admin/ops surface (named as gaps, not started).
- GWP fix commit status still unverified (git access needed).
- `saas-mvp-test-log.xlsx` still not found anywhere in the local ClaudeCowork folder -- merge-gate status unresolved.

## Roadmap note (2026-08-06): scaling backlog, deferred behind MVP

Compared this repo against `starrybodies/ghg-calculator` (open-source Python CLI/MCP-server GHG calculator, 967 embedded emission factors) at TeeKay's request. Full comparison given in that session's chat, not reproduced here -- summary and disposition only. Note: this was a README-level review of their repo, not independent verification of their factor values or test suite.

That tool is not a competitor to this product (single-user CLI/library vs. this project's multi-tenant hosted SaaS -- no auth, no persistence beyond JSON, no ISO 14064-1 boundary structure, no audit-defensible UI surfacing). Its value here is as a checklist of solved, expected patterns this schema is still missing. Three items identified, **explicitly deferred until after MVP local testing and merge to main** -- do not start these before the test log (`saas-mvp-test-log.xlsx`) gate is green and TeeKay says to move to scaling work:

1. **Scope 2 dual reporting (location-based + market-based), automatic on every electricity activity.** Matches the gap already flagged in the 2026-07-25 session's interrupted GHG Protocol gap analysis ("No Scope 2 dual reporting in the schema"). Required by GHG Protocol Scope 2 Guidance; not currently in `shared/schema.ts`.
2. **GWP version tagging as a schema-level concept**, not just in the static reference file -- every stored GWP-derived value traceable to a stated AR version (AR5/AR6) and horizon, queryable, not hardcoded. Matches the same gap analysis's "No GWP version tagging on emission factor records" finding. Caveat: `starrybodies/ghg-calculator`'s README states AR5 is current GHG Protocol guidance -- this conflicts with the source PDF fetched directly in the 2026-07-29 GWP reverification session (GHG Protocol's own "IPCC Global Warming Potential Values" v2.0, Aug 2024, labels AR6 "(recommended)"). Don't copy their AR5-default choice without re-checking that claim; the *pattern* (versioned, queryable GWP) is the useful part, not their specific default.
3. **Structured Scope 3 categories 1-15 as named schema fields**, with a spend-based fallback methodology (sector-factor x spend) for when granular activity data isn't available. Matches the gap analysis's Scope 1 subcategory-structuring finding -- same issue exists on Scope 3, arguably higher-impact since Scope 3 categorization is load-bearing for CDP/GRI reporting.

Not in scope for this backlog item: matching their emission-factor breadth (US eGRID grid subregions, Ember international electricity, USEEIO/EXIOBASE spend-based factors). That's a separate, larger data-sourcing effort, lower priority than the three schema items above, and lower priority than MVP.

## Merge policy (user-set, non-negotiable)

Nothing merges into main until local machine testing is complete with a full green on the test log's Critical-priority rows, tested by multiple people. `saas-mvp-test-log.xlsx` from the prior session was not found in the local ClaudeCowork folder this session -- confirm whether it still exists / was ever run before assuming that gate's status.

## Credentials and access

- Neon DB credentials: in the Claude Project file /mnt/project/Neon_Auth, not on the Windows filesystem.
- GitHub push access: user provides a fresh fine-grained PAT (Contents: read/write, single repo) each session when needed, previous one should be treated as expired/rotated.

## Start-of-session steps

1. Read the Claude Project instructions, then this file -- this file wins on conflict, same as before.
2. `git pull` the saas-multitenant branch (if git access exists this session), then read `README.md` + `MIGRATIONS.md` + `GAP-ANALYSIS-2026-07-29.md` + this file to get current state.
3. Run `npm run check` and, in a non-production DB, `node scripts/manual-migration-002.mjs` -- both untested as of this handoff. Fix whatever tsc surfaces before writing more code on top.
4. Apply the six-method upsert fix above once drizzle-orm's exact API is confirmed.

## Next task

With schema/migration/storage/routes for the facility-level MRV layer in place but unverified by compilation or execution: (1) get this session's code actually compiling and running against a real DB, (2) fix the upsert org-scoping gap, (3) build the UI layer for source streams / calculation approaches / verification findings / mitigation measures, or (4) return to the smaller known SaaS gaps (password reset, real invites, hosting) that were deferred this session in favor of the EAD-equivalent rebuild. TeeKay's call on ordering.