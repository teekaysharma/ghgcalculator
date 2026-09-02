# Scope 2 Dual Reporting (Grid Electricity + District Cooling) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GHG Protocol Scope 2 dual reporting (location-based + market-based) for grid electricity and district cooling, with real seeded default factors, without touching any existing calculation path for other categories.

**Architecture:** Purely additive. New nullable columns on `calculation_approaches` for the market-based factor slot; new `country` column and two new `category` values on `ipcc_default_factors`; a second, conditionally-rendered `EmissionFactorPicker` instance; two new totals fields on the consolidated report. Nothing existing is renamed, removed, or restructured.

**Tech Stack:** TypeScript/Drizzle (schema), React (UI), Node (migration + report aggregation), plus a real external data acquisition step (Ember Yearly Electricity Data, US EPA eGRID, UAE district cooling factor).

## Global Constraints

- Every requirement below is copied verbatim from `docs/superpowers/specs/2026-08-15-scope2-dual-reporting-design.md` (already brainstormed, reviewed, and self-corrected once during that session on GWP disclosure — read that file in full before starting Task 1, it has the reasoning behind each decision, not just the what).
- **Location-based default factors are blended CO2e everywhere except US eGRID**, which gets real per-gas (CO2/CH4/N2O) disaggregation using the exact same GWP mechanism Stationary Combustion already uses.
- **Blended rows must NOT be re-multiplied by this app's own GWP table.** A blended external figure (e.g. Ember's) already has GWP baked in by the source; re-applying AR6 GWP would double-count. `gasType = 'CO2e'` is the signal `buildComponent` uses to skip the internal `gwp_values` lookup.
- **Every blended row must still disclose a GWP source/version**, sourced from the originating dataset's own stated methodology (Ember's methodology PDF, in this case) — never left implying AR6 consistency that hasn't been confirmed.
- **Market-based factor slot is additive-only**: 8 new nullable columns on `calculation_approaches`, all `null` for every non-electricity/cooling source stream, forever.
- **When the user leaves the market-based picker empty, the pipeline copies the location-based result into `marketBasedCalculatedEmissionsTco2e` at save time** (not left `null`) — every downstream reader sums uniformly, no special-case branching. The UI must still visibly label this as a fallback, never presented as an active market-based choice.
- **No silent cross-country fallback.** If a country has no seeded location-based factor, the picker shows "No default grid factor for this country yet — add your own with a source," never another country's number.
- **Ember data license (CC BY 4.0)**: commercial use and redistribution are permitted, but attribution is required. Every Ember-sourced row's `sourceDocument`/`sourceUrl`/a visible citation must credit Ember per their stated citation format (see Task 5).
- **Explicitly deferred, not built this round** (do not scope-creep into these): residual-mix data beyond eGRID's per-gas rates, generic purchased heat/steam beyond district cooling, the framework/output-selector, a GWP multi-version toggle, module/add-on packaging.

---

### Task 1: Schema — country column, new category values, market-based columns

**Files:**
- Modify: `shared/schema.ts`

**Interfaces:**
- Produces: `ipccDefaultFactors.country` (nullable text), the `"Grid Electricity"`/`"District Cooling"` category values (no enum — `category` is already free text), and 8 new nullable columns on `calculationApproaches` for Task 5 (data seeding), Task 2 (calculation logic), and Task 3 (UI) to consume.

- [ ] **Step 1: Add `country` to `ipccDefaultFactors`**

In `shared/schema.ts`, inside the `ipccDefaultFactors` table definition, add immediately after the `isBiogenic` field:

```ts
  // New nullable column (spec: docs/superpowers/specs/2026-08-15-scope2-dual-reporting-design.md).
  // ISO 3166-1 alpha-2, mirroring emission_factors.country's existing
  // pattern. Stays null for genuinely generic rows (IPCC Tier-1 Stationary
  // Combustion) -- only Grid Electricity/District Cooling rows get a real
  // country code, since location-based Scope 2 is inherently
  // location-specific.
  country: text("country"),
```

- [ ] **Step 2: Add the 8 market-based columns to `calculationApproaches`**

Add immediately after the existing `calculatedEmissionsTco2e` field:

```ts
    // Market-based Scope 2 factor slot (spec: docs/superpowers/specs/
    // 2026-08-15-scope2-dual-reporting-design.md). Mirrors the
    // location-based factor-selection columns above exactly. All 8 stay
    // null for every source stream whose category isn't Grid
    // Electricity/District Cooling, forever -- zero behavior change for
    // Stationary Combustion or anything else. When left empty by the
    // user, the pipeline copies the location-based result into
    // marketBasedCalculatedEmissionsTco2e at save time (see Task 2) so
    // every downstream reader can sum uniformly.
    marketBasedEmissionFactorValue: numeric("market_based_emission_factor_value", { precision: 20, scale: 8 }),
    marketBasedEmissionFactorUnit: text("market_based_emission_factor_unit"),
    marketBasedEmissionFactorSource: text("market_based_emission_factor_source"),
    marketBasedEmissionFactorSourceUrl: text("market_based_emission_factor_source_url"),
    marketBasedEmissionFactorAuthorityName: text("market_based_emission_factor_authority_name"),
    marketBasedIsIpccDefault: boolean("market_based_is_ipcc_default").notNull().default(false),
    marketBasedGasBreakdown: jsonb("market_based_gas_breakdown"),
    marketBasedCalculatedEmissionsTco2e: numeric("market_based_calculated_emissions_tco2e", { precision: 20, scale: 4 }),
```

- [ ] **Step 3: Add both new fields to the corresponding `insertXSchema`/`pick()` blocks**

Find `insertIpccDefaultFactorSchema`(or equivalent — check the actual name near the `ipccDefaultFactors` table) and add `country: true`. Find the insert schema for `calculationApproaches` and add all 8 new `marketBased*` keys with `: true`.

- [ ] **Step 4: Typecheck**

Run: `npm run check`
Expected: clean, zero errors.

- [ ] **Step 5: Commit**

```bash
git add shared/schema.ts
git commit -m "schema: add country to ipcc_default_factors, market-based factor slot to calculation_approaches"
```

---

### Task 2: Calculation logic — blended CO2e handling, market-based fallback

**Files:**
- Modify: `client/src/lib/ipccGasBundle.ts`
- Modify: wherever `calculationApproaches` rows are saved server-side (find the actual route/storage method — likely `server/routes.ts` and/or `server/storage.ts`, the calculation-approach upsert path)

**Interfaces:**
- Consumes: `ipccDefaultFactors.country`, `gasType = 'CO2e'` rows, `calculationApproaches.marketBased*` columns from Task 1.
- Produces: `buildComponent` handling for blended rows; the save-time fallback-copy behavior the spec requires.

- [ ] **Step 1: Handle `gasType === 'CO2e'` in `buildComponent`**

In `client/src/lib/ipccGasBundle.ts`, find `gwpGasKeyFor` (currently ~line 57) and `buildComponent` (~line 104). Add an early branch: when `row.gasType === 'CO2e'`, skip the `gwp_values` table lookup entirely and set `co2ePerUnit = nativeFactor` directly (the source already applied its own GWP; re-multiplying by this tool's AR6 table would double-count). The component's `gwpVersion`/`gwpSource` must still be populated — from the row's own `sourceDocument`/`notes` (populated in Task 5 with e.g. "Ember Yearly Electricity Data methodology" as the disclosed basis), not left blank and not defaulted to this tool's own AR6 label.

- [ ] **Step 2: Verify US eGRID rows are unaffected**

Confirm (read the surrounding code, don't just assume) that eGRID's three-rows-per-subregion (`gasType` = `'CO2'`/`'CH4'`/`'N2O'`) flow through the existing, unmodified `gwpGasKeyFor`/GWP-lookup path — no `'CO2e'` branch should ever trigger for these, since they're genuinely per-gas raw rates, not pre-blended. Add this as an explicit assertion/comment if the code path isn't already obviously exclusive.

- [ ] **Step 3: Save-time market-based fallback**

Find the server-side save path for a `calculationApproaches` row (the route handler that persists `emissionFactorValue`/`calculatedEmissionsTco2e` etc. — grep for where `calculatedEmissionsTco2e` is written). Add: if the source stream's `ghgSourceCategory` is `"Grid Electricity"` or `"District Cooling"` and `marketBasedEmissionFactorValue` is null/not provided, set `marketBasedCalculatedEmissionsTco2e = calculatedEmissionsTco2e` (copy the location-based result) and `marketBasedIsIpccDefault = false` at save time — never leave it `null` for these two categories. For every other category, all 8 `marketBased*` columns stay `null` (no change to existing behavior).

- [ ] **Step 4: Write a test covering the fallback-copy behavior**

Add a test (find this project's existing test pattern for calculation-approach saves, or add alongside `verify-branch.mjs`'s coverage if that's the established smoke-test location) asserting: given a Grid Electricity source stream saved with only a location-based factor, `marketBasedCalculatedEmissionsTco2e` equals `calculatedEmissionsTco2e` after save; given a Stationary Combustion source stream, all 8 `marketBased*` fields remain `null` after save.

- [ ] **Step 5: Run tests + typecheck**

Run: `npm run check` and the test command this project uses (check `package.json` scripts — likely folded into `npm run verify`).
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add client/src/lib/ipccGasBundle.ts <server file(s) touched>
git commit -m "feat: blended-CO2e handling and market-based save-time fallback for Scope 2"
```

---

### Task 3: UI — second picker for market-based, country-filtered location-based picker

**Files:**
- Modify: `client/src/components/EmissionFactorPicker.tsx`
- Modify: `client/src/components/BoundaryWorkspace.tsx` (the `CalculationApproachForm` caller)

**Interfaces:**
- Consumes: `marketBased*` columns (Task 1), `ipccDefaultFactors.country` (Task 1), `facilityCountry` (already threaded into `EmissionFactorPicker` per the spec — confirm this prop still exists before assuming).

- [ ] **Step 1: Confirm `facilityCountry` prop still exists**

Read `EmissionFactorPicker.tsx`'s current props. The spec assumes it already receives `facilityCountry`. If it doesn't (code may have drifted since Aug 15), add it — threaded from the source stream's facility, same pattern the spec describes, and note the drift in your task report.

- [ ] **Step 2: Country-filter the picker for Grid Electricity/District Cooling**

When the picker is rendering factors for a source stream whose `ghgSourceCategory` is `"Grid Electricity"` or `"District Cooling"`, filter `ipcc_default_factors` rows to `country === facilityCountry` (except US eGRID rows, which are `country = 'US'` and already match when the facility is US). No match: show "No default grid factor for this country yet — add your own with a source" — verbatim, no silent fallback to a different country.

- [ ] **Step 3: Rename the picker's provenance label**

Per the spec: the picker's `SelectLabel` currently reads "IPCC default factors" — accurate today, misleading once IEA/EPA/utility rows share the table. Change to "Default reference factors." Do not rename the DB table (`ipcc_default_factors` stays as-is — legacy identifier, not user-facing).

- [ ] **Step 4: Render a second picker instance for market-based**

In `CalculationApproachForm` (`BoundaryWorkspace.tsx`), when the source stream's `ghgSourceCategory` is Grid Electricity or District Cooling, render a second `EmissionFactorPicker` labeled "Market-based factor (optional)" below the existing (now implicitly "location-based") one. Selecting a factor there populates the 8 `marketBased*` columns from Task 1. Leaving it blank relies on Task 2 Step 3's save-time fallback. Every other category's form is completely unchanged — verify by reading the existing render path, don't just assume the conditional is additive.

- [ ] **Step 5: Visible fallback labeling**

When `marketBasedEmissionFactorValue` is null (fallback case) but the source stream is Grid Electricity/District Cooling, the UI must show something to the effect of "Using location-based factor as fallback (no market-based instrument selected)" — never presented as if the user made an active choice.

- [ ] **Step 6: Manual browser verification**

Per this project's UI-change convention: start the dev server, walk through creating a Grid Electricity source stream, confirm the country filter behaves (a country with no seeded factor shows the explicit message, not a silent wrong number), confirm the second picker appears only for Grid Electricity/District Cooling, confirm the fallback label appears when the market-based picker is left blank. Screenshot the flow.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/EmissionFactorPicker.tsx client/src/components/BoundaryWorkspace.tsx
git commit -m "feat: market-based factor picker and country-filtered location-based picker for Scope 2"
```

---

### Task 4: Reporting — dual totals

**Files:**
- Modify: `server/storage.ts` (`getConsolidatedReport`)
- Modify: `client/src/components/OrganizationReport.tsx`

**Interfaces:**
- Consumes: `marketBasedCalculatedEmissionsTco2e` (Task 1/2).
- Produces: `scope2LocationBased`, `scope2MarketBased` on the consolidated report's totals shape.

- [ ] **Step 1: Add the two new totals fields**

In `getConsolidatedReport` (`server/storage.ts`), add `scope2LocationBased` and `scope2MarketBased` to the totals aggregation. The existing `scope2` field becomes an alias for `scope2LocationBased` — same value, same field name, so every existing reader of `totals.scope2` keeps working unchanged. `scope2MarketBased` sums `marketBasedCalculatedEmissionsTco2e` the same way `scope2`/`scope2LocationBased` sums `calculatedEmissionsTco2e` today.

- [ ] **Step 2: Show both company-total figures**

In `OrganizationReport.tsx`, per GHG Protocol convention (the spec is explicit this is the actual "dual reporting" requirement, not just showing two Scope 2 numbers in isolation): show total company footprint under both methods where they differ — "Scope 1 + Location-based Scope 2 + Scope 3" and "Scope 1 + Market-based Scope 2 + Scope 3" — computed for the reader, not left for them to add up themselves.

- [ ] **Step 3: Typecheck + manual verification**

Run: `npm run check`. Load a report with at least one Grid Electricity source stream (from Task 3's manual verification) and confirm both totals render and reconcile with the Facilities/Source-Stream sheets' own sums.

- [ ] **Step 4: Commit**

```bash
git add server/storage.ts client/src/components/OrganizationReport.tsx
git commit -m "feat: scope2LocationBased/scope2MarketBased dual totals in consolidated report"
```

---

### Task 5: Data sourcing — Ember, EPA eGRID, UAE district cooling

**Files:**
- Create: `scripts/scope2-factors/fetch-ember.mjs` (or `.py`, implementer's choice — no existing pattern to match since this is genuinely new data acquisition, unlike Tasks 1-4)
- Create: `scripts/manual-migration-01X.mjs` (next number after whatever's landed by the time this task starts — check `ls scripts/manual-migration-*.mjs` first, do not assume a fixed number)

**Interfaces:**
- Produces: seeded `ipcc_default_factors` rows with `category IN ('Grid Electricity', 'District Cooling')`, for Task 3's picker to query.

This task is the "larger share of this sub-project's real effort" per the spec's own words, and unlike Tasks 1-4, the exact final row values are not pre-known — they come from real external data this task must fetch and verify, the same discipline as the EPA NAICS-6/EXIOBASE work on the `scope3-data-quality` branch (verify sources directly, never fabricate a plausible-looking number, disclose gaps honestly rather than inventing a figure that doesn't hold up).

- [ ] **Step 1: Fetch Ember's Yearly Electricity Data (Global CSV)**

Download from Ember's "Yearly electricity data – Global (CSV)" link (`https://ember-energy.org/data/yearly-electricity-data/` — confirm the exact current download URL, it may not be a stable direct link). Per Ember's own July 2026 format note (verified this session): one row per area/year/electricity-source, `"Total generation"` row per area carries the overall `Emissions intensity (gCO2e/kWh)` figure — filter to that row per country, most recent year available. Convert gCO2e/kWh to this table's expected unit (check `ipcc_default_factors.unit` convention against existing rows — likely needs a kg-basis conversion, verify rather than assume). License: CC BY 4.0, verified this session — attribution required, not a restriction on use.

**Citation, verify before seeding — do not reuse CaDI's citation text by mistake.** This session confirmed Ember's license (CC BY 4.0) and data format directly on `ember-energy.org`, but did not capture Ember's own specific citation wording — CaDI (a different organization, checked and rejected as a source earlier in this plan's spec) has its own distinct citation format that must not be applied to Ember-sourced rows. Find Ember's actual stated attribution requirement (their methodology page or site footer) before seeding `sourceDocument`/`sourceUrl`.

Seed as `category = 'Grid Electricity'`, `sector = 'all'`, `gasType = 'CO2e'`, `activityType = 'Grid Electricity'`, `country` = the ISO 3166-1 alpha-2 code (Ember's own country names will need mapping to codes — verify each mapping, especially for Ember's "simplified names" like "Türkiye" mentioned in their July 2026 format note), `sourceDocument`/`sourceUrl` citing Ember, `notes` stating the GWP basis as disclosed in Ember's methodology PDF (fetch and read it — do not assume it matches this tool's AR6 standard without checking, per the spec's own explicit correction on this exact point).

Countries Ember doesn't cover, or where the most recent data is itself flagged as an estimate rather than reported: do not seed a fabricated row — leave that country absent, so the picker's "No default grid factor for this country yet" message is honest.

- [ ] **Step 2: Fetch US EPA eGRID subregion rates**

Locate EPA's current published eGRID summary tables (search for the current release — eGRID data updates periodically, confirm you have the current version, not a stale cached one). Extract per-subregion CO2/CH4/N2O output rates (~25 subregions). Verify eGRID's own licensing status the same way the EPA NAICS-6 dataset was verified earlier this session (17 U.S.C. §105 public domain default for US federal data) — confirm this specific dataset doesn't carry an unusual exception before assuming the same status applies.

Seed as three rows per subregion: `country = 'US'`, `sector = 'all'`, `gasType` = `'CO2'`/`'CH4'`/`'N2O'` respectively, `activityType` = `"Grid Electricity — <subregion code>"` (matching how Stationary Combustion distinguishes fuels by name in `activityType`, per the spec).

- [ ] **Step 3: UAE district cooling factor**

Per the spec's own explicit flag: this is "the thinnest of the three and the most likely to need an honest 'no seeded default, add your own with a source' outcome." Search for a real, citable Tabreed or Empower sustainability-disclosure figure (their published sustainability/ESG reports are the most likely source for a real, attributable district-cooling emission factor). If nothing verifiable is found: do not seed a fabricated row. Report this explicitly rather than silently omitting it — District Cooling stays a real category in the schema/UI either way, just without a seeded UAE default until a real figure is found.

- [ ] **Step 4: Write the migration**

Follow the established `scripts/manual-migration-0XX.mjs` idempotent pattern (`tableExists`/`ensureTable` for the new `country` column via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` equivalent check, then a `bulkInsert`-style seed guarded by a row-count check, matching `scripts/manual-migration-010.mjs`'s pattern on the `scope3-data-quality` branch). Load the fetched/verified data from Step 1-3 into `ipcc_default_factors`.

- [ ] **Step 5: Run against the live DB, verify, confirm idempotency**

Run the migration, spot-check at least 3 real values against their original source (one Ember country, one eGRID subregion, the UAE district cooling row if one was found), re-run to confirm idempotency (Applied 0, Skipped N).

- [ ] **Step 6: Commit**

```bash
git add scripts/scope2-factors/ scripts/manual-migration-01X.mjs
git commit -m "feat: seed Grid Electricity (Ember) and District Cooling default factors"
```

## Self-Review Notes

- **Spec coverage**: all data-model, calculation, UI, and reporting requirements from the design spec are covered across Tasks 1-4. Task 5 covers the spec's Data Sourcing section, corrected in the spec itself (IEA → Ember) before this plan was written.
- **Known open item, deliberately not resolved in this plan**: Task 5's exact final country coverage and the UAE district cooling factor's existence are genuinely unknown until that task executes — this plan specifies the acquisition process and verification bar precisely, not fabricated final values, consistent with this project's "no evidence = no building" discipline.
- **Scope check**: does not touch the explicitly-deferred items (residual-mix data, generic heat/steam, framework/output-selector, GWP multi-version toggle, module packaging) — those remain out of scope per the spec.
