# Verification -- Facility-Level MRV Layer (2026-08-03)

Repo: github.com/teekaysharma/ghgcalculator, branch saas-multitenant. Local clone: C:\Users\LENOVO\Documents\ClaudeCowork\OUTPUTS\ghgcalculator.

Scope: manual verification of everything added in the 2026-07-29 session (facility-level MRV granularity layer, 12 tenant-scoped tables + 2 global reference tables), per TeeKay's priority call this session. No shell/exec access -- no `npm run check`, no `git`, no migration run against a database. Everything below is read-based cross-checking across three parallel review passes, not compilation. `npm run check` and running `scripts/manual-migration-002.mjs` against a non-production database are still the only way to fully close this out.

## 1. shared/schema.ts vs scripts/manual-migration-002.mjs

All 14 new tables checked column by column, types, nullability, defaults, foreign keys, indexes, and constraints. Result: full match on all 14 -- facility_identifiers, facility_contacts, facility_products, source_streams, calculation_approaches, measurement_based_approaches, fallback_approaches, methane_reports, data_quality_records, verification_findings, management_qa_records, mitigation_measures, primary_activity_types, product_benchmarks. No column present in one file and missing from the other, in either direction.

All 12 tenant-scoped tables have `organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE` plus a matching `org_idx` index in both files. The 2 reference tables correctly have no `organization_id` in either file. The migration script's table-creation order respects foreign key dependencies against the pre-existing `facilities`/`reporting_boundaries` tables from migration-001.

Two unconfirmed (not bugs, just unverified) notes: Drizzle's bare `timestamp()` should generate a timezone-less column matching the migration's plain `TIMESTAMP`, and the migration's unique-constraint names follow Drizzle's default auto-naming convention -- both assumed correct by convention, neither independently confirmed against a live Drizzle-generated migration. Worth a sanity check if `drizzle-kit push` is ever run on this branch again, given it has reportedly crashed here before.

## 2. server/storage.ts and server/routes.ts

Every get/list/update/delete method for the 12 tenant-scoped tables filters on `organizationId` in its WHERE clause. No org-scoping gaps found beyond the six upsert methods already flagged last session (upsertFacilityIdentifier, upsertCalculationApproach, upsertMeasurementBasedApproach, upsertFallbackApproach, upsertMethaneReport, upsertDataQualityRecord).

Every route for the 12 tenant tables is gated `requireAuth, requireOrg`. Every create route referencing a parent resource (facility, reporting boundary, or source stream) verifies parent ownership scoped to the caller's org before writing. Update/delete-by-id routes rely on storage filtering on `(id, organizationId)` directly, which is an equivalent guarantee. The two `/api/reference/*` routes correctly use `requireAuth` only, matching that reference data has no `organization_id` column.

All six `onConflictDoUpdate` conflict targets have a real backing unique constraint in the schema, so the six upserts are structurally valid queries, not just missing org-scoping.

Every storage method called from routes.ts resolves to a method that actually exists in storage.ts, and no storage method goes uncalled. One documentation discrepancy: the handoff notes describe "32 new methods," the actual count found is 39 (37 tenant-scoped plus 2 reference-data reads). Not a code defect, just a stale number in the handoff.

Not verified by this pass: actual TypeScript compilation (subtler type mismatches, e.g. Drizzle's inferred numeric-column types under `onConflictDoUpdate`'s `set`, can't be ruled out without running `tsc`), and the pre-existing non-MRV parts of both files, which were out of scope.

## 3. The six-method upsert fix -- confirmed, not applied

Installed version: `drizzle-orm ^0.39.1`. Drizzle's `onConflictDoUpdate` supports a `setWhere` option (added in v0.30.8, well below this project's version), which scopes the UPDATE itself:

```ts
db.insert(table)
 .values(data)
 .onConflictDoUpdate({
 target: someColumn,
 set: data,
 setWhere: eq(table.organizationId, orgId),
 });
```

Per Postgres `ON CONFLICT ... DO UPDATE ... WHERE` semantics, if `setWhere` evaluates false the update is silently skipped, zero rows affected, no error -- the correct "no-op instead of cross-tenant overwrite" behavior. Source: https://orm.drizzle.team/docs/insert#where-clauses.

The `.returning()` + throw-if-empty pattern proposed in the 2026-07-29 handoff is a sound secondary check but should not replace `setWhere` -- without `setWhere`, the query has no conflict-target scoping at all and will overwrite another tenant's row before the empty-check ever runs.

This fix was confirmed valid this session but not applied, per your priority call to verify first. It's now unblocked and ready to apply on request.

## 4. Merge-gate test log

`saas-mvp-test-log.xlsx` was searched for across the entire local ClaudeCowork folder tree. Still not found. The merge policy (nothing to main without a full green on this log's Critical-priority rows) has no confirmed artifact backing it right now -- status of that gate is unresolved, same as last session.

## Addendum (2026-08-03, same day) -- fix applied, compile confirmed

The `setWhere` fix was applied to all six upsert methods (`upsertFacilityIdentifier`, `upsertCalculationApproach`, `upsertMeasurementBasedApproach`, `upsertFallbackApproach`, `upsertMethaneReport`, `upsertDataQualityRecord`) in `server/storage.ts`, each now scoping the conflict update to the caller's `organizationId` and throwing explicitly if `.returning()` comes back empty.

TeeKay ran `npm run check` from the command line (this session has no exec access). First run surfaced 2 errors, both pre-existing and unrelated to the MRV work: `client/src/Footer.tsx:5` (untyped `styles` object, string literals widened past React's CSS union types) and `server/vite.ts:43` (`allowedHosts: true` widened to `boolean` instead of the literal `true` Vite's `ServerOptions` requires). Both fixed (explicit `React.CSSProperties` typing on the Footer styles object, `as const` on `allowedHosts`). Second run: clean, zero errors.

Confirmed: the entire facility-level MRV layer (schema, migration script, storage, routes) plus the six-method upsert fix now compiles clean under `tsc`. This does not confirm runtime correctness -- the migration has still never been run against a real database.

## Addendum 2 (2026-08-03) -- migration run, confirmed live

TeeKay ran `node scripts/manual-migration-002.mjs` against his Neon database (the only one he has, no separate dev/test branch exists -- proceeded directly per his call, accepted given the script's additive-only/transactional/idempotent design). Result: 58 statements applied, 0 skipped -- a clean first-time apply. All 14 tables and their indexes now exist; 26 reference rows seeded (8 primary_activity_types, 18 product_benchmarks). No errors, no rollback triggered.

The facility-level MRV layer is now real in the database, not just in code. Schema, migration, storage, and routes are consistent with each other, compile clean, and are now backed by an actual applied schema.

## Addendum 3 (2026-08-03) -- migration-003: scope classification + reference-table FKs

Following a review of the UI plan, TeeKay confirmed scope 1/2/3 is the base activity-level taxonomy everything else (ISO 14064-1's six categories, EAD, other frameworks) reclassifies from, matching this project's own standing "shared Scopes 1/2/3 quantification as the base layer" principle. Three parallel agents were used for this pass.

Template analysis (client provided the actual file at `TEMPLATES/Deliverable C Template_v8 1.xlsx`, replacing last session's structural-only read): confirmed the 8 seeded `primary_activity_types` match the template exactly. Found the 18 seeded `product_benchmarks` have two problems, one entry ("Bottles and jars of colourless") is missing the word "glass" compared to the template's actual cell, a transcription error from last session, not a template error, and the seed only captured 18 of the actual 56 entries in that list (it continues to row 68, not row 30). Both fixed in migration-003. Separately confirmed the workbook has 207 live cross-sheet lookup formulas (INDEX/MATCH, not SUM totals) synchronizing detail sheets back to the master `2c2_Facility Description` sheet, and roughly 40 defined names now resolving to `#REF!`, evidence this template was adapted from a standard EU ETS Monitoring Plan template.

Schema and migration: `scripts/manual-migration-003.mjs` written, following migration-001/002's exact idempotent, transaction-wrapped, `ensureColumn`/`ensureConstraint`-style pattern. Adds four nullable, additive columns: `source_streams.scope` (text, CHECK constrained to scope1/scope2/scope3), `source_streams.scope3_category` (integer, CHECK constrained 1-15), `facility_identifiers.primary_activity_type_id` (FK to `primary_activity_types`, ON DELETE SET NULL), `facility_products.product_benchmark_id` (FK to `product_benchmarks`, ON DELETE SET NULL). Existing free-text `primary_activity`/`product_category` columns left untouched. `shared/schema.ts` updated to match, confirmed column-for-column by direct read. Also appended the product-benchmark typo fix and the 38 missing seed rows to the same migration, idempotent.

Storage and routes: `server/storage.ts` needed no changes, its methods pass insert/update objects straight to Drizzle. `server/routes.ts` DID need changes, a real gap that would have silently dropped the new fields, its request-validation zod schemas are hand-maintained locally rather than derived from `shared/schema.ts`, so they don't pick up new columns automatically. Fixed by adding the four fields to the four relevant zod objects. Confirmed `shared/schema.ts` myself directly; relied on the agent's detailed self-report for the routes.ts edits, a full independent re-read of that 64KB file wasn't practical through the available tools this pass.

Cross-check: `shared/schema.ts` already has an `isoInventoryCategories` constant with exactly six values, scaffolded during the original ISO 14064-1 boundary work, unused so far. This independently confirms the six-category figure and gives the future output-selector mapping layer something to map onto that already exists in code.

None of this has been run or compiled yet. Same next step as before: TeeKay runs `npm run check`, then `node scripts/manual-migration-003.mjs`, both from the command line.

## What's still open

- No UI exists yet for any of the 12 new MRV entities, or the new scope/reference-table fields -- routes and storage are live, nothing is wired to a screen.
- The framework output-selector (view/report as ISO 14064-1 / GHG Protocol / EAD) is planned for this build phase but not yet started -- needs the scope field live in the database first.
- Vercel/serverless deployment adaptation still open (hosting target: persistent Node host assumed, per TeeKay's 07-29 decision).
- Real email-invite flow and password reset still open.
- No billing/plan layer, no admin/ops surface.
- GWP fix (266 gases) commit status still unverified -- needs git access.
- `saas-mvp-test-log.xlsx` status still unresolved -- not found anywhere in the local ClaudeCowork folder.