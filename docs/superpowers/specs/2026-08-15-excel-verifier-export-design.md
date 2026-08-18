# Excel Workbook Export for the Lead Verifier — Design

Session date: 2026-08-15. Branch `saas-multitenant`. First of two sub-projects scoped this round — generic verifier-facing Excel export, then a customizable board-report template (separate spec). Also closes a standing item first named in `docs/superpowers/plans/2026-08-12-production-readiness-roadmap.md`: *"Audit View + Excel export: generic export of the on-screen audit view, and the official EAD-template-fill export."*

## Context and decisions made during brainstorming

- **Target: generic self-built workbook now; the official EAD template fill is an explicit later phase, not built here.** The real regulator-issued `Deliverable C Template_v8 1.xlsx` (Abu Dhabi EAD facility-level MRV template) exists on this machine and was read in full in an earlier session, but filling it precisely is a distinct, jurisdiction-specific project. This export needs to work for any client/jurisdiction now, given the international-simultaneous-rollout goal — the EAD-specific fill is named as a known follow-on, not forgotten.
- **Scope: one reporting boundary per export.** Matches ISO 14064-3 — verification applies to one fixed, dated GHG statement, the same principle the finalize/recalculate lock already enforces. One workbook = one entity's one reporting year.
- **Availability: anytime, draft state labeled clearly.** Not gated behind finalization — a verifier engagement needs a working draft to review pre-sign-off, and internal teams need to check their own numbers before finalizing. The workbook states its status (`DRAFT` or `FINALIZED`, plus `finalizedAt` if set) prominently on the Summary sheet so it's never ambiguous which kind of document a verifier is holding.
- **Formulas: hybrid, not all-or-nothing.** Live Excel formulas for straightforward arithmetic a verifier would want to independently recheck (sums, percentages, the source-stream-level `factor × quantity` and `native × GWP` calculations). Static values with an explanatory text note for figures driven by conditional business logic that would produce an unreadable, fragile formula (biogenic CO2 exclusion, equity-share weighting) — Excel formulas handle simple arithmetic well and branching logic badly; forcing the latter into a cell formula would hurt auditability, not help it.

## Standards cross-check (done after initial design approval, per explicit request to verify against the RAG corpus before implementation)

Checked against ISO 14064-3:2019, the GHG Protocol Corporate Standard's own required-reporting-content list, and ISO 14064-1:2018/its application guidance. Two categories of finding:

**Real gaps in the first draft, now fixed below**: (1) GHG Protocol's required content list states a report *"shall include... emissions data for all six GHGs separately... in metric tonnes and in tonnes of CO2 equivalent"* — the first draft's Gas Breakdown sheet only had tCO2e, not native mass. (2) The same list requires *"details of and justification for the exclusion of any Scope 3 emissions"* — since this platform hasn't built structured Scope 3 categories yet, showing a Scope 3 total with no completeness disclosure would itself be a standards gap, not a neutral omission. (3) ISO 14064-3 requires evidence of *"the appropriateness of the estimate methodology... the quality of the data used"* for any estimated activity data — the first draft's Source Stream sheet didn't explicitly surface `activityDataSource`/`activityDataTier`, which already exist in the schema. (4) ISO 14064-3 requires *"any restatements have been adequately assessed"* — the Verification Findings sheet needed to explicitly distinguish recalculation-triggered findings, not leave them unlabeled among other finding types.

**A boundary deliberately not crossed**: ISO 14064-3 assigns risk categorization (inherent/control/detection risk, per §6.1.2.2) to the *verifier*, not the reporting organization. The export surfaces the inputs a verifier needs to make that judgment themselves — materiality classification, data quality tier, activity data source — rather than having the platform pre-assign a risk score, which would overstep into the verifier's own responsibility under the standard.

## Tab structure

Seven sheets, each mapping to something a lead verifier is actually checking during an ISO 14064-3 engagement:

1. **Summary** — reporting entity name, boundary year, consolidation approach, status (DRAFT/FINALIZED + date), **an explicit "Standard applied" statement (ISO 14064-1 / GHG Protocol Corporate Standard)**, Scope 1/2/3, `Total` as a live `=SUM(Scope1,Scope2,Scope3)` formula, biogenic CO2 memo line, intensity ratios, base-year comparison **plus the base-year rationale text (`baseYearRationale`) itself, not just the numeric comparison**, and **a Scope 3 completeness disclosure** stating plainly that structured Scope 3 categories are not yet built in this system (rather than presenting a Scope 3 total with no caveat).
2. **Facilities** — one row per facility (name, country, equity %, Scope 1/2/3), with a formula-driven organization-total row at the bottom that must reconcile with the Summary sheet's totals (a verifier's first cross-check).
3. **Emissions by Source Stream** — the calculation trail: facility → source stream name/scope/category → calculation-approach tier (calculation-based / measurement-based / fallback) → **activity data source and tier (`activityDataSource`/`activityDataTier` — e.g. metered, calculated, estimated)** → activity data (value + unit) → emission factor (value + unit + source + authority) → per-gas breakdown (CO2/CH4/N2O native quantity × GWP value, GWP version stated) → resulting tCO2e, as a live formula per row, plus **materiality classification and estimated annual emissions (`materiality`, `estimatedAnnualEmissionsTco2e`)** per stream. Rolls up to match the Facilities sheet. This sheet needs data the app doesn't currently expose in one assembled place — see Data Model below.
4. **Gas Breakdown** — gas, **native mass in metric tonnes**, tCO2e, and a live `=tCO2e/Total` percentage column — both units shown separately, per the GHG Protocol's explicit requirement, not CO2e alone.
5. **Data Quality & Uncertainty** — one row per source stream: data quality tier, uncertainty %, uncertainty justification, whether an IPCC default factor was used and why.
6. **Verification Findings & Management QA** — the existing tracked verification findings (type, description, severity, status — **with recalculation/restatement-triggered findings explicitly labeled as such**, not left indistinguishable from other finding types) and management QA procedures (description, responsible person, review frequency).
7. **Source Documentation** — every emission factor actually used by this boundary's source streams, with its source URL and authority name, deduplicated — so a verifier checking traceability doesn't have to cross-reference the app.

## Data model — new query needed, no schema changes

`getConsolidatedReport` (`server/storage.ts`) already computes most of what Sheets 1, 2, 5, 6 need, **except**: its `gasBreakdown` currently returns only `{ gas, co2e, pctOfTotal }` — no native mass in metric tonnes, which the Gas Breakdown sheet's revised design now requires alongside tCO2e. This needs a small addition to that aggregation (sum native quantities per gas across the boundary's records), not a rewrite.

Sheet 3 (and Sheet 7's factor list) needs the underlying per-source-stream detail — facility → source stream → its calculation/measurement/fallback approach → that approach's `gasBreakdown` — which today lives across `sourceStreams`, `calculationApproaches`, `measurementBasedApproaches`, and `fallbackApproaches`, joined but never assembled into one flat, exportable shape. `sourceStreams.materiality` and `sourceStreams.estimatedAnnualEmissionsTco2e`, and `calculationApproaches.activityDataSource`/`activityDataTier`, all already exist as columns (confirmed against the live schema and a real created row this session) — this query just needs to select and include them, not add anything new to the schema.

**New storage method**: `getSourceStreamDetailForBoundary(organizationId: number, reportingBoundaryId: number)`, returning one row per source stream with its facility name, approach tier, activity data (value, unit, source, tier), factor, materiality classification, estimated annual emissions, and gas breakdown — reusing the same org-scoped join pattern already established for `getConsolidatedReport`. This is genuinely new work, not just formatting — it is the one piece of this export that isn't already computed elsewhere.

No new tables, no new columns. Purely new/extended read queries over existing data.

## Generation approach

The `xlsx` package (SheetJS, already a dependency — currently used client-side only, in `WasteFactorGuide.tsx`'s template download) is used server-side for the first time here. It supports writing formula strings to a cell (`cell.f = "SUM(B2:B10)"`), which Excel recalculates on open — this is how the live-formula requirement above gets satisfied without the server itself evaluating anything.

**New route**: `GET /api/reporting-boundaries/:id/consolidated-report/export.xlsx`, sibling to the existing `export.csv` route (`server/routes.ts:1020`), same auth/org-scoping/404 pattern. Calls `getConsolidatedReport` (for Sheets 1/2/4/5/6) and the new `getSourceStreamDetailForBoundary` (for Sheets 3/7), builds the workbook in a new `server/utils/xlsx-export.ts` module (parallel to the existing `server/utils/csv.ts` — wait, that file doesn't exist anymore, it was retired when the legacy calculator's CSV path was removed; this module is a fresh addition, not a revival), and streams the `.xlsx` binary back with the appropriate `Content-Type`/`Content-Disposition` headers.

## UI

A new "Export Excel" button in `OrganizationReport.tsx`, alongside the existing "Export CSV" button, triggering a direct download from the new route — no new page, no new form, matching how the CSV export already works.

## Explicitly deferred (tracked, not built this round)

- The official EAD template fill (data-cells-only, template's own formulas untouched) — a distinct, jurisdiction-specific project building on this one's source-stream detail query.
- Any other jurisdiction-specific official template (should the platform later need one for a different regulator).
- PDF export (already deferred earlier this session, unrelated to this Excel-specific requirement).
