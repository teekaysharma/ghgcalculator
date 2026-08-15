# Scope 2 Dual Reporting (Grid Electricity + District Cooling) — Design

Session date: 2026-08-15. Branch `saas-multitenant`. First of three sub-projects scoped this round (content gaps identified in `GAP-ANALYSIS-2026-08-15.md`): Scope 2 dual reporting, structured Scope 3 categories, target/SBTi tracking. Each gets its own spec → plan → implementation cycle; this document covers Scope 2 only. Also extends `docs/superpowers/plans/2026-08-12-production-readiness-roadmap.md` Step 3 item 1 ("Scope 2 dual reporting... smallest, most self-contained... natural starting point").

## Context and decisions made during brainstorming

- **Geographic scope of location-based default factors: global**, via IEA's country-level Emissions Factors database (~190 countries), not UAE-only — decided because building it once covers both "UAE-showcase-ready now" and "international rollout in parallel" with the same effort.
- **Market-based method for v1: structure + fallback only.** A user-supplied supplier-specific/contractual factor is used when available; otherwise the market-based total falls back to the location-based figure, per GHG Protocol Scope 2 Guidance's own prescribed behavior when no contractual instrument or residual-mix data exists. Residual-mix datasets for markets that publish them (EU via AIB, US via eGRID/Green-e) are explicitly deferred as a follow-on — additive later, not a schema change.
- **Scope: electricity + district cooling.** District cooling (Tabreed/Empower-style) is common enough in UAE facilities to be a real gap if left out; purchased heat/steam beyond district cooling is deferred.
- **Factor granularity: source-driven, not uniform.** Checked directly rather than assumed: GHG Protocol Scope 2 Guidance itself only requires per-gas reporting "where available," and CBAM's own default methodology for electricity (Implementing Regulation 2023/1773, Annex III §D.2) uses a blended tCO2e/MWh figure sourced from IEA — confirming blended-by-default isn't a rigor compromise for most markets. US EPA eGRID is a real, current exception: it publishes genuinely separate CO2/CH4/N2O rates per subregion. **Decision: blended CO2e everywhere by default; US eGRID gets real per-gas disaggregation this round**, using the exact same per-gas GWP mechanism already built for Stationary Combustion — no new calculation logic, just new data following the existing pattern.
- **Architectural principle — build for future add-on modules.** Everything in this design is additive (new nullable columns, a new optional factor slot, new report fields with a backward-compatible alias) — nothing rewrites an existing calculation path. This is deliberate: a future module/add-on system (CBAM-specific calculation, Scope-3-category modules, target-tracking) should be able to feature-gate this kind of addition per organization without rework. The actual packaging/licensing/marketplace mechanism for "modules downloaded by a client" is its own future design — it will likely need to intersect with the billing/entitlement layer named as missing in `GAP-ANALYSIS-2026-08-15.md` — and is explicitly NOT designed here, only kept unblocked.

## Data model

### `ipcc_default_factors` — provenance labeling fix

The picker currently renders this table's rows under the label "IPCC default factors" — accurate today because every row is IPCC-sourced. Once IEA/EPA/utility rows are seeded into the same table, that label becomes misleading about where a number actually came from, which cuts against this project's traceability discipline (every factor must be traceable to a real, checkable source). Fix: rename the picker's `SelectLabel` to "Default reference factors." The table's internal DB name (`ipcc_default_factors`) is not renamed — that's a legacy identifier, not user-facing, and renaming it would be unnecessary migration churn. Every row's own `sourceDocument`/`sourceUrl` must be the real, specific citation (IEA, EPA eGRID, Tabreed/Empower) regardless of what table it lives in.

### `ipcc_default_factors` — new `country` column

New nullable `country` column (`text`, ISO 3166-1 alpha-2, mirroring `emission_factors.country`'s existing pattern). IPCC Tier-1 rows (Stationary Combustion) stay `null` — they're genuinely generic, that's the definition of a Tier-1 default. Grid Electricity and District Cooling rows get a real country code, since location-based Scope 2 is inherently location-specific.

### `ipcc_default_factors` — new `category` values and row shapes

Two new `category` values: `"Grid Electricity"` and `"District Cooling"`.

- **Most countries (blended):** one row per country, `sector = 'all'`, `gasType = 'CO2e'` (a new pseudo-gas value). `buildComponent` in `client/src/lib/ipccGasBundle.ts` treats `gasType === 'CO2e'` as already-blended: GWP = 1, `co2ePerUnit = nativeFactor` directly, no further multiplication. `gwpGasKeyFor` needs a one-line addition for this case (return the row's own value directly rather than looking up a GWP-table entry). `activityType` = `"Grid Electricity"` / `"District Cooling"`.
- **US (per-gas):** three rows per eGRID subregion, `country = 'US'`, `sector = 'all'`, `gasType` = `'CO2'` / `'CH4'` / `'N2O'` respectively, subregion identified in `activityType` (e.g. `"Grid Electricity — RFCE"`) rather than a new column, matching how Stationary Combustion already distinguishes fuels by name in `activityType`. These flow through the exact existing `gwpGasKeyFor`/GWP-lookup path unchanged.

No other schema changes to this table. `netCalorificValue` stays `null` for these rows (not meaningful for electricity/cooling — no combustion, no NCV).

### `calculation_approaches` — market-based factor slot

New nullable columns mirroring the existing factor-selection set exactly (real column names, from the live schema):

- `marketBasedEmissionFactorValue` (numeric, mirrors `emissionFactorValue`)
- `marketBasedEmissionFactorUnit` (text, mirrors `emissionFactorUnit`)
- `marketBasedEmissionFactorSource` (text, mirrors `emissionFactorSource`)
- `marketBasedEmissionFactorSourceUrl` (text, mirrors `emissionFactorSourceUrl`)
- `marketBasedEmissionFactorAuthorityName` (text, mirrors `emissionFactorAuthorityName`)
- `marketBasedIsIpccDefault` (boolean, default false, mirrors `isIpccDefault` — will almost always be false in practice since market-based factors are typically supplier-specific, but kept symmetric)
- `marketBasedGasBreakdown` (jsonb, mirrors `gasBreakdown`)
- `marketBasedCalculatedEmissionsTco2e` (numeric, mirrors `calculatedEmissionsTco2e`)

All eight columns are `null` for every source stream whose category isn't Grid Electricity/District Cooling, forever — zero behavior change for Stationary Combustion or anything else. `calculatedEmissionsTco2e` (the existing column) becomes, in effect, "the location-based figure" for electricity/cooling streams — no rename, since every other category already treats it as simply "the total," and renaming it would touch working code for no benefit.

When the market-based slot is left empty by the user, the calculation pipeline copies the location-based result into `marketBasedCalculatedEmissionsTco2e` at save time (not left `null`), so every downstream reader (the consolidated report) can sum it uniformly without a special "is this null, if so use location-based instead" branch scattered across the codebase. The UI still visibly labels this as "using location-based factor as fallback (no market-based instrument selected)" so it's never presented as if the user made an active market-based choice.

## Calculation approach UI

`EmissionFactorPicker` (or its caller, `CalculationApproachForm` in `BoundaryWorkspace.tsx`) renders a second instance of the picker — labeled "Market-based factor (optional)" — only when the source stream's `ghgSourceCategory` is Grid Electricity or District Cooling. Selecting a factor there populates the `marketBased*` columns; leaving it blank triggers the fallback behavior above. The existing single-picker flow is completely unchanged for every other category.

Country matching: the picker already receives `facilityCountry` (threaded from the source stream's facility). For Grid Electricity/District Cooling, it filters `ipcc_default_factors` rows to that country. No match found means an explicit message — "No default grid factor for this country yet — add your own with a source" — never a silent fallback to a different country's number.

## Reporting

`getConsolidatedReport` (`server/storage.ts`) gains `scope2LocationBased` and `scope2MarketBased` in its totals. The existing `scope2` field becomes an alias for `scope2LocationBased` (same value, same field, so nothing currently reading `totals.scope2` breaks) — `scope2MarketBased` is the new, additive figure.

Per GHG Protocol convention, `OrganizationReport.tsx` shows total company footprint under both methods where they differ (Scope 1 + Location-based Scope 2 + Scope 3, and Scope 1 + Market-based Scope 2 + Scope 3) rather than leaving the reader to compute that themselves — this is the actual "dual reporting" requirement, not just showing two Scope 2 numbers in isolation.

## Data sourcing (the larger share of this sub-project's real effort)

Three datasets, sourced and cited with the same rigor as the Stationary Combustion extraction earlier this session — never fabricated, every figure traceable:

1. **IEA global country-level grid electricity factors** (~190 countries) — IEA's Emissions Factors database.
2. **US EPA eGRID subregion CO2/CH4/N2O output rates** (~25 subregions) — EPA's published eGRID summary tables.
3. **UAE district cooling factor(s)** — Tabreed/Empower sustainability disclosures, or a recognized default if provider-specific figures aren't publicly available. Flagged now as the thinnest of the three and the most likely to need an honest "no seeded default, add your own with a source" outcome rather than a number that doesn't hold up to scrutiny.

## Explicitly deferred (tracked, not built this round)

- Residual-mix data for markets that publish it (EU/AIB, US/eGRID-Green-e) beyond the per-gas eGRID rates already in scope above.
- Generic purchased heat/steam beyond district cooling.
- The general framework/output-selector that a future CBAM module (or GRI/CDP/ESRS-shaped exports) would consume.
- A GWP multi-version toggle (viewing the same inventory under AR5 vs. AR6).
- The module/add-on packaging, licensing, and marketplace mechanism itself — this design only guarantees today's work doesn't block it.
