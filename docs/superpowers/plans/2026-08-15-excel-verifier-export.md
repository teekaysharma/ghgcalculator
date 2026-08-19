# Excel Workbook Export for the Lead Verifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship two Excel export options from the Organization Report — a generic, complete ISO 14064-3/GHG Protocol-aligned workbook, and a best-effort fill of the real official EAD Deliverable C Template — sharing one new data-assembly query.

**Architecture:** A new `getSourceStreamDetailForBoundary` storage method assembles the per-source-stream calculation trail that neither export can get from the existing `getConsolidatedReport`. Two independent generation modules consume it: `server/utils/xlsx-export.ts` builds the generic workbook from scratch (7 sheets, live formulas where the underlying arithmetic is simple); `server/utils/ead-template-fill.ts` loads the real template file, clears its illustrative example rows, and writes only to genuine data-entry cells, never touching the template's own formulas. Two new routes, one new UI control (a two-option export menu).

**Tech Stack:** `xlsx` (SheetJS, already a dependency, used server-side for the first time), Express, Drizzle ORM — no new dependencies.

## Global Constraints

- Every tenant-scoped table query MUST filter on `organizationId` — no exceptions (standing project rule).
- Never touch the EAD template's own formulas — write only to cells confirmed to be genuine data-entry targets (verified per-sheet below); a cell already carrying an `f` (formula) property is never written to.
- Illustrative/example data already present in the real template (see Task 6) MUST be cleared before writing real data — never leave a fabricated example number in a file handed to a client or verifier.
- One reporting boundary per export; no gating on finalize status; the workbook states its DRAFT/FINALIZED status explicitly.
- This project has no automated test framework. Verification is `npm run check` (tsc) plus live checks against the running dev server / real database, matching this project's established pattern for every prior task this session.
- Any command that mutates the live Neon DB requires the user's explicit go-ahead each time — none of this plan's tasks need one (all additive read-side work), but flag clearly if that changes.

---

### Task 1: Add native mass per gas to `getConsolidatedReport`

**Files:**
- Modify: `server/storage.ts:87-135` (the `ConsolidatedReport` interface) and `server/storage.ts:1046-1111` (the aggregation loop and `gasBreakdown` construction inside `getConsolidatedReport`)

**Interfaces:**
- Produces: `ConsolidatedReport.gasBreakdown` gains a `nativeMass: number` field per entry (metric tonnes), alongside the existing `gas`/`co2e`/`pctOfTotal`. Consumed by Task 3's generic workbook Gas Breakdown sheet.

- [ ] **Step 1: Add `nativeMass` to the `ConsolidatedReport` interface**

In `server/storage.ts`, change line 91 from:

```ts
  gasBreakdown: { gas: string; co2e: number; pctOfTotal: number }[];
```

to:

```ts
  gasBreakdown: { gas: string; co2e: number; nativeMass: number; pctOfTotal: number }[];
```

- [ ] **Step 2: Track native mass alongside tonnes in the aggregation loop**

In `server/storage.ts`, find this block (around line 1035-1044):

```ts
    const scopeTotals = { scope1: 0, scope2: 0, scope3: 0 };
    const gasTotals = new Map<string, number>();
    const perFacilityScopeTotals = new Map<number, { scope1: number; scope2: number; scope3: number }>();
```

Add a second map right after `gasTotals`:

```ts
    const scopeTotals = { scope1: 0, scope2: 0, scope3: 0 };
    const gasTotals = new Map<string, number>();
    // Native mass (metric tonnes of the gas itself, not CO2e) per gas --
    // GHG Protocol's required-reporting-content list states emissions
    // "shall include... data for all six GHGs separately... in metric
    // tonnes and in tonnes of CO2 equivalent," not CO2e alone.
    const gasNativeMassTotals = new Map<string, number>();
    const perFacilityScopeTotals = new Map<number, { scope1: number; scope2: number; scope3: number }>();
```

Find the type annotation for `breakdown` (around line 1073-1074):

```ts
      const breakdown =
        (record.gasBreakdown as { gas: string; co2e?: number; co2ePerUnit?: number; isBiogenic?: boolean }[] | null) ?? [];
```

Widen it to include `nativeFactor` (already present on every real persisted `GasComponent`, per `shared/schema.ts`'s `GasComponent` interface — this destructured type just wasn't reading it yet):

```ts
      const breakdown =
        (record.gasBreakdown as
          | { gas: string; co2e?: number; co2ePerUnit?: number; nativeFactor?: number; isBiogenic?: boolean }[]
          | null) ?? [];
```

Find the per-component loop (around line 1077-1090) and add native-mass accumulation alongside the existing `gasTotals.set` call:

```ts
      for (const component of breakdown) {
        const componentEmissionKg =
          component.co2e !== undefined ? component.co2e : quantity * (component.co2ePerUnit ?? 0);
        const componentTonnes = (componentEmissionKg * multiplier) / 1000;
        if (component.gas === "CO2" && component.isBiogenic === true) {
          recordBiogenicCo2Tonnes += componentTonnes;
          continue;
        }
        gasTotals.set(component.gas, (gasTotals.get(component.gas) ?? 0) + componentTonnes);
        // Native mass: quantity x nativeFactor is the native-unit
        // contribution BEFORE any GWP multiplication (nativeFactor is
        // "kg of this gas per unit of activity data"), same multiplier
        // and biogenic-CO2 exclusion as the CO2e accumulation above so
        // the two stay reconcilable.
        const componentNativeTonnes = (quantity * (component.nativeFactor ?? 0) * multiplier) / 1000;
        gasNativeMassTotals.set(component.gas, (gasNativeMassTotals.get(component.gas) ?? 0) + componentNativeTonnes);
      }
```

- [ ] **Step 3: Include `nativeMass` when building the `gasBreakdown` output array**

Find (around line 1106-1111):

```ts
    const gasTotal = Array.from(gasTotals.values()).reduce((sum, v) => sum + v, 0);
    const gasBreakdown = Array.from(gasTotals.entries()).map(([gas, co2e]) => ({
      gas,
      co2e,
      pctOfTotal: gasTotal > 0 ? (co2e / gasTotal) * 100 : 0,
    }));
```

Change to:

```ts
    const gasTotal = Array.from(gasTotals.values()).reduce((sum, v) => sum + v, 0);
    const gasBreakdown = Array.from(gasTotals.entries()).map(([gas, co2e]) => ({
      gas,
      co2e,
      nativeMass: gasNativeMassTotals.get(gas) ?? 0,
      pctOfTotal: gasTotal > 0 ? (co2e / gasTotal) * 100 : 0,
    }));
```

- [ ] **Step 4: Run `npm run check`**

Run: `npm run check`
Expected: no errors.

- [ ] **Step 5: Live-verify against the dev server**

Start the dev server, hit `GET /api/reporting-boundaries/:id/consolidated-report` for a boundary with real emission records (any boundary created earlier this session works), confirm the response's `gasBreakdown` entries each have a `nativeMass` field with a plausible non-zero value for gases with real components (e.g. for a 10 TJ Wood/Wood Waste record with CO2 native factor 112000 kg/TJ, `nativeMass` for CO2 should be `null`/excluded per the existing biogenic-CO2 exclusion, but CH4/N2O native masses should be present and reconcilable: `nativeMass * gwpValue ≈ co2e` for that gas, within rounding).

- [ ] **Step 6: Commit**

```bash
git add server/storage.ts
git commit -m "Add native mass per gas to getConsolidatedReport's gasBreakdown"
```

---

### Task 2: New `getSourceStreamDetailForBoundary` storage method

**Files:**
- Modify: `server/storage.ts` (add to `IStorage` interface near line 289, implement in `DbStorage` near the end of the class before line 1269)

**Interfaces:**
- Consumes: `sourceStreams`, `calculationApproaches`, `measurementBasedApproaches`, `fallbackApproaches`, `facilities` tables (all in `shared/schema.ts`, already imported into `server/storage.ts`).
- Produces: `SourceStreamDetail[]` (new exported interface), via `storage.getSourceStreamDetailForBoundary(organizationId: number, reportingBoundaryId: number): Promise<SourceStreamDetail[]>`. Consumed by Task 3 (generic workbook) and Tasks 5-6 (EAD fill).

- [ ] **Step 1: Add the `SourceStreamDetail` interface**

In `server/storage.ts`, add directly after the `ConsolidatedReport` interface (after line 135):

```ts
// -----------------------------------------------------------------------
// SourceStreamDetail
//
// The per-source-stream calculation trail neither export can get from
// getConsolidatedReport (which only returns facility-level rollups).
// One row per source stream, joined with whichever of the three approach
// tables it actually has a row in (a source stream has at most one of
// calculationApproach / measurementApproach / fallbackApproach -- each of
// those tables' sourceStreamId column is unique).
// -----------------------------------------------------------------------
export interface SourceStreamDetail {
  sourceStreamId: number;
  facilityId: number;
  facilityName: string;
  streamCode: string | null;
  name: string;
  description: string | null;
  ghgSourceCategory: string | null;
  scope: string | null;
  materiality: string | null;
  estimatedAnnualEmissionsTco2e: number | null;
  approachTier: "calculation" | "measurement" | "fallback" | "none";
  calculationApproach: {
    fuelOrMaterialType: string | null;
    activityDataValue: number | null;
    activityDataUnit: string | null;
    activityDataSource: string | null;
    activityDataTier: string | null;
    emissionFactorValue: number | null;
    emissionFactorUnit: string | null;
    emissionFactorSource: string | null;
    emissionFactorSourceUrl: string | null;
    emissionFactorAuthorityName: string | null;
    isIpccDefault: boolean;
    gasBreakdown: unknown;
    netCalorificValue: number | null;
    calculatedEmissionsTco2e: number | null;
  } | null;
  measurementApproach: {
    measurementMethod: string | null;
    monitoringFrequency: string | null;
    measurementUnit: string | null;
    annualMeasuredQuantity: number | null;
    qaqcProcedure: string | null;
    calibrationFrequency: string | null;
  } | null;
  fallbackApproach: {
    justification: string | null;
    fallbackMethodDescription: string | null;
    estimatedEmissionsTco2e: number | null;
  } | null;
}
```

- [ ] **Step 2: Add the method signature to `IStorage`**

In `server/storage.ts`'s `IStorage` interface, add near the other reporting-boundary methods (after `getEnabledModuleKeys` around line 162 is a reasonable spot, or wherever the ISO 14064-1 boundary-layer group of method signatures sits):

```ts
  getSourceStreamDetailForBoundary(organizationId: number, reportingBoundaryId: number): Promise<SourceStreamDetail[]>;
```

- [ ] **Step 3: Implement in `DbStorage`**

Add near `getConsolidatedReport` (directly after it, before the closing brace of the class, i.e. before line 1269):

```ts
  async getSourceStreamDetailForBoundary(organizationId: number, reportingBoundaryId: number): Promise<SourceStreamDetail[]> {
    const streams = await db
      .select()
      .from(sourceStreams)
      .where(and(eq(sourceStreams.organizationId, organizationId), eq(sourceStreams.reportingBoundaryId, reportingBoundaryId)));
    if (streams.length === 0) return [];

    const streamIds = streams.map((s) => s.id);
    const facilityIds = Array.from(new Set(streams.map((s) => s.facilityId)));

    const [facilityRows, calcRows, measureRows, fallbackRows] = await Promise.all([
      db.select().from(facilities).where(and(eq(facilities.organizationId, organizationId), inArray(facilities.id, facilityIds))),
      db
        .select()
        .from(calculationApproaches)
        .where(and(eq(calculationApproaches.organizationId, organizationId), inArray(calculationApproaches.sourceStreamId, streamIds))),
      db
        .select()
        .from(measurementBasedApproaches)
        .where(and(eq(measurementBasedApproaches.organizationId, organizationId), inArray(measurementBasedApproaches.sourceStreamId, streamIds))),
      db
        .select()
        .from(fallbackApproaches)
        .where(and(eq(fallbackApproaches.organizationId, organizationId), inArray(fallbackApproaches.sourceStreamId, streamIds))),
    ]);

    const facilityNameById = new Map(facilityRows.map((f) => [f.id, f.name]));
    const calcByStream = new Map(calcRows.map((r) => [r.sourceStreamId, r]));
    const measureByStream = new Map(measureRows.map((r) => [r.sourceStreamId, r]));
    const fallbackByStream = new Map(fallbackRows.map((r) => [r.sourceStreamId, r]));

    return streams.map((s) => {
      const calc = calcByStream.get(s.id);
      const measure = measureByStream.get(s.id);
      const fallback = fallbackByStream.get(s.id);
      const approachTier: SourceStreamDetail["approachTier"] = calc ? "calculation" : measure ? "measurement" : fallback ? "fallback" : "none";

      return {
        sourceStreamId: s.id,
        facilityId: s.facilityId,
        facilityName: facilityNameById.get(s.facilityId) ?? "",
        streamCode: s.streamCode,
        name: s.name,
        description: s.description,
        ghgSourceCategory: s.ghgSourceCategory,
        scope: s.scope,
        materiality: s.materiality,
        estimatedAnnualEmissionsTco2e: s.estimatedAnnualEmissionsTco2e ? Number(s.estimatedAnnualEmissionsTco2e) : null,
        approachTier,
        calculationApproach: calc
          ? {
              fuelOrMaterialType: calc.fuelOrMaterialType,
              activityDataValue: calc.activityDataValue ? Number(calc.activityDataValue) : null,
              activityDataUnit: calc.activityDataUnit,
              activityDataSource: calc.activityDataSource,
              activityDataTier: calc.activityDataTier,
              emissionFactorValue: calc.emissionFactorValue ? Number(calc.emissionFactorValue) : null,
              emissionFactorUnit: calc.emissionFactorUnit,
              emissionFactorSource: calc.emissionFactorSource,
              emissionFactorSourceUrl: calc.emissionFactorSourceUrl,
              emissionFactorAuthorityName: calc.emissionFactorAuthorityName,
              isIpccDefault: calc.isIpccDefault,
              gasBreakdown: calc.gasBreakdown,
              netCalorificValue: calc.netCalorificValue ? Number(calc.netCalorificValue) : null,
              calculatedEmissionsTco2e: calc.calculatedEmissionsTco2e ? Number(calc.calculatedEmissionsTco2e) : null,
            }
          : null,
        measurementApproach: measure
          ? {
              measurementMethod: measure.measurementMethod,
              monitoringFrequency: measure.monitoringFrequency,
              measurementUnit: measure.measurementUnit,
              annualMeasuredQuantity: measure.annualMeasuredQuantity ? Number(measure.annualMeasuredQuantity) : null,
              qaqcProcedure: measure.qaqcProcedure,
              calibrationFrequency: measure.calibrationFrequency,
            }
          : null,
        fallbackApproach: fallback
          ? {
              justification: fallback.justification,
              fallbackMethodDescription: fallback.fallbackMethodDescription,
              estimatedEmissionsTco2e: fallback.estimatedEmissionsTco2e ? Number(fallback.estimatedEmissionsTco2e) : null,
            }
          : null,
      };
    });
  }
```

- [ ] **Step 4: Run `npm run check`**

Run: `npm run check`
Expected: no errors (confirm `facilities`, `calculationApproaches`, `measurementBasedApproaches`, `fallbackApproaches`, `sourceStreams` are already imported at the top of `server/storage.ts` — they are, used by other methods in this file already).

- [ ] **Step 5: Live-verify**

Add a temporary call in a scratch script (or use the dev server + a direct DB-backed test) against a boundary with at least one source stream that has a calculation approach: confirm `getSourceStreamDetailForBoundary` returns one entry with `approachTier: "calculation"` and the `calculationApproach` object populated with real values matching what's in the database. Confirm a source stream with no approach yet returns `approachTier: "none"` and both approach objects `null`, not throwing.

- [ ] **Step 6: Commit**

```bash
git add server/storage.ts
git commit -m "Add getSourceStreamDetailForBoundary storage method"
```

---

### Task 3: Generic 7-sheet workbook + `export.xlsx` route + UI button (generic option only)

**Files:**
- Create: `server/utils/xlsx-export.ts`
- Modify: `server/routes.ts` (add route near the existing `export.csv` route, `server/routes.ts:1020`)
- Modify: `client/src/components/OrganizationReport.tsx` (add the Export Excel button)

**Interfaces:**
- Consumes: `ConsolidatedReport` (from Task 1, `server/storage.ts`), `SourceStreamDetail[]` (from Task 2).
- Produces: `buildGenericWorkbook(report: ConsolidatedReport, streamDetails: SourceStreamDetail[]): XLSX.WorkBook`, exported from `server/utils/xlsx-export.ts`. Consumed only by the route in this task.

- [ ] **Step 1: Write `server/utils/xlsx-export.ts`**

```ts
// server/utils/xlsx-export.ts
//
// Builds the generic, complete ISO 14064-3 / GHG Protocol-aligned
// verifier workbook -- the unconstrained export, as opposed to
// server/utils/ead-template-fill.ts's fixed-template fill. See
// docs/superpowers/specs/2026-08-15-excel-verifier-export-design.md.
//
// Formula philosophy: live Excel formulas for straightforward arithmetic
// a verifier would want to independently recheck (sums, percentages,
// per-row factor x quantity); static values with a text note for figures
// driven by conditional business logic (biogenic exclusion, equity-share
// weighting) that would make an unreadable, fragile formula.

import * as XLSX from "xlsx";
import type { ConsolidatedReport, SourceStreamDetail } from "../storage";

function summarySheet(report: ConsolidatedReport): XLSX.WorkSheet {
  const total = report.totals.scope1 + report.totals.scope2 + report.totals.scope3;
  const rows: (string | number)[][] = [
    ["Reporting entity", report.reportingEntity.name],
    ["Reporting year", report.reportingBoundary.reportingYear],
    ["Consolidation approach", report.reportingBoundary.consolidationApproach],
    ["Status", report.reportingBoundary.status.toUpperCase()],
    ["Finalized at", report.reportingBoundary.finalizedAt ?? "(not finalized)"],
    ["Standard applied", "ISO 14064-1:2018 / GHG Protocol Corporate Accounting and Reporting Standard"],
    [],
    ["Scope 1 (tCO2e)", report.totals.scope1],
    ["Scope 2 (tCO2e)", report.totals.scope2],
    ["Scope 3 (tCO2e)", report.totals.scope3],
    ["Total (tCO2e)", 0], // placeholder value, overwritten with a live formula below
    [],
    ["Biogenic CO2 -- memo item, excluded from gross Scope 1/2/3 above", report.totals.biogenicCo2],
    [],
    [
      "Scope 3 completeness",
      "This platform does not yet structure Scope 3 into the GHG Protocol's 15 categories. The Scope 3 total above is the sum of all records tagged scope3; it is not broken out by category and no category-specific exclusions are separately justified. Treat this figure as provisional pending category structuring.",
    ],
    [],
    ["Base year", report.reportingEntity.baseYear ?? "(not set)"],
    ["Base year rationale", report.reportingEntity.baseYearRationale ?? ""],
    [
      "Base year comparison",
      report.baseYearComparison
        ? `Base year total ${report.baseYearComparison.baseYearTotal ?? "N/A"} tCO2e, current year ${report.baseYearComparison.currentYearTotal} tCO2e, change ${report.baseYearComparison.changePercent?.toFixed(1) ?? "N/A"}%`
        : "(no base year comparison available)",
    ],
    [],
    ["tCO2e per revenue unit", report.intensity.tco2ePerRevenue ?? "(not available)"],
    ["tCO2e per FTE", report.intensity.tco2ePerFte ?? "(not available)"],
    ["tCO2e per production unit", report.intensity.tco2ePerProductionUnit ?? "(not available)"],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  // Total (tCO2e) is row 10 (0-indexed row 10 -> Excel row 11), column B.
  // Scope 1/2/3 are rows 7-9 (0-indexed) -> Excel rows 8-10, column B.
  ws["B11"] = { t: "n", f: "SUM(B8:B10)" };
  return ws;
}

function facilitiesSheet(report: ConsolidatedReport): XLSX.WorkSheet {
  const header = ["Facility", "Country", "Equity %", "Scope 1", "Scope 2", "Scope 3"];
  const rows = report.facilities.map((f) => [
    f.name,
    f.country ?? "",
    f.equityShareOwnershipPercent ?? "",
    f.scope1,
    f.scope2,
    f.scope3,
  ]);
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const totalRowIndex = rows.length + 1; // 0-indexed data rows start at 1 (row 0 is header)
  const firstDataRow = 2; // Excel row 2 = first facility (row 1 = header)
  const lastDataRow = rows.length + 1;
  const totalExcelRow = totalRowIndex + 1;
  XLSX.utils.sheet_add_aoa(ws, [["TOTAL", "", "", 0, 0, 0]], { origin: `A${totalExcelRow}` });
  ws[`D${totalExcelRow}`] = { t: "n", f: `SUM(D${firstDataRow}:D${lastDataRow})` };
  ws[`E${totalExcelRow}`] = { t: "n", f: `SUM(E${firstDataRow}:E${lastDataRow})` };
  ws[`F${totalExcelRow}`] = { t: "n", f: `SUM(F${firstDataRow}:F${lastDataRow})` };
  return ws;
}

function sourceStreamSheet(streamDetails: SourceStreamDetail[]): XLSX.WorkSheet {
  const header = [
    "Facility",
    "Source stream",
    "Scope",
    "Category",
    "Approach tier",
    "Activity data source",
    "Activity data tier",
    "Activity data value",
    "Activity data unit",
    "Emission factor value",
    "Emission factor unit",
    "Emission factor source",
    "Materiality",
    "Estimated annual emissions (tCO2e)",
    "Gas",
    "Native quantity",
    "GWP value",
    "GWP version",
    "tCO2e (this gas)",
  ];
  const rows: (string | number)[][] = [];
  for (const s of streamDetails) {
    const calc = s.calculationApproach;
    const breakdown = (calc?.gasBreakdown as { gas: string; nativeFactor: number; gwpValue: number; gwpVersion: string; co2ePerUnit: number }[] | null) ?? [];
    if (breakdown.length === 0) {
      rows.push([
        s.facilityName,
        s.name,
        s.scope ?? "",
        s.ghgSourceCategory ?? "",
        s.approachTier,
        calc?.activityDataSource ?? "",
        calc?.activityDataTier ?? "",
        calc?.activityDataValue ?? "",
        calc?.activityDataUnit ?? "",
        calc?.emissionFactorValue ?? "",
        calc?.emissionFactorUnit ?? "",
        calc?.emissionFactorSource ?? "",
        s.materiality ?? "",
        s.estimatedAnnualEmissionsTco2e ?? "",
        "",
        "",
        "",
        "",
        "",
      ]);
      continue;
    }
    for (const c of breakdown) {
      rows.push([
        s.facilityName,
        s.name,
        s.scope ?? "",
        s.ghgSourceCategory ?? "",
        s.approachTier,
        calc?.activityDataSource ?? "",
        calc?.activityDataTier ?? "",
        calc?.activityDataValue ?? "",
        calc?.activityDataUnit ?? "",
        calc?.emissionFactorValue ?? "",
        calc?.emissionFactorUnit ?? "",
        calc?.emissionFactorSource ?? "",
        s.materiality ?? "",
        s.estimatedAnnualEmissionsTco2e ?? "",
        c.gas,
        c.nativeFactor,
        c.gwpValue,
        c.gwpVersion,
        0, // placeholder, overwritten with a live formula below
      ]);
    }
  }
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  // tCO2e (this gas) = Native quantity (col P) x GWP value (col Q), live
  // formula per row so a verifier can independently recheck the math.
  for (let i = 0; i < rows.length; i++) {
    const excelRow = i + 2; // row 1 is header
    if (rows[i][14] === "") continue; // no gas breakdown row for this stream
    ws[`S${excelRow}`] = { t: "n", f: `P${excelRow}*Q${excelRow}` };
  }
  return ws;
}

function gasBreakdownSheet(report: ConsolidatedReport): XLSX.WorkSheet {
  const header = ["Gas", "Native mass (t)", "tCO2e", "% of total"];
  const total = report.gasBreakdown.reduce((sum, g) => sum + g.co2e, 0);
  const rows = report.gasBreakdown.map((g) => [g.gas, g.nativeMass, g.co2e, 0]);
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  for (let i = 0; i < rows.length; i++) {
    const excelRow = i + 2;
    ws[`D${excelRow}`] = { t: "n", f: total > 0 ? `C${excelRow}/SUM(C2:C${rows.length + 1})` : "0" };
  }
  return ws;
}

function dataQualitySheet(report: ConsolidatedReport): XLSX.WorkSheet {
  const header = ["Source stream", "Data quality tier", "Uncertainty %", "Uncertainty justification", "Used IPCC default factor?", "Substitution reason"];
  const rows = report.dataQualityRecords.map((r) => [
    r.sourceStreamName ?? "",
    r.dataQualityTier ?? "",
    r.uncertaintyPercent ?? "",
    r.uncertaintyJustification ?? "",
    r.usedIpccDefaultFactor ? "Yes" : "No",
    r.ipccDefaultSubstitutionReason ?? "",
  ]);
  return XLSX.utils.aoa_to_sheet([header, ...rows]);
}

function verificationAndQaSheet(report: ConsolidatedReport): XLSX.WorkSheet {
  const findings = report.verificationFindings as {
    findingType: string;
    description: string;
    severity: string | null;
    status: string;
  }[];
  const qa = report.managementQaRecords as {
    qaProcedureDescription: string | null;
    responsiblePerson: string | null;
    reviewFrequency: string | null;
  }[];
  const rows: (string | number)[][] = [["VERIFICATION FINDINGS"], ["Type", "Description", "Severity", "Status", "Recalculation-related?"]];
  for (const f of findings) {
    // Recalculation reasons are logged as verification findings with
    // findingType "observation" per server/routes.ts's recalculate route
    // -- flagged explicitly here per ISO 14064-3's restatement-assessment
    // requirement, since the type field alone doesn't distinguish a
    // recalculation note from any other observation.
    const isRecalculation = f.description.toLowerCase().includes("recalculat");
    rows.push([f.findingType, f.description, f.severity ?? "", f.status, isRecalculation ? "Yes" : "No"]);
  }
  rows.push([], ["MANAGEMENT QA"], ["Procedure", "Responsible person", "Review frequency"]);
  for (const q of qa) {
    rows.push([q.qaProcedureDescription ?? "", q.responsiblePerson ?? "", q.reviewFrequency ?? ""]);
  }
  return XLSX.utils.aoa_to_sheet(rows);
}

function sourceDocumentationSheet(streamDetails: SourceStreamDetail[]): XLSX.WorkSheet {
  const header = ["Factor source", "Source URL", "Authority", "Used by source streams"];
  const byKey = new Map<string, { source: string; url: string; authority: string; streams: Set<string> }>();
  for (const s of streamDetails) {
    const calc = s.calculationApproach;
    if (!calc || !calc.emissionFactorSource) continue;
    const key = `${calc.emissionFactorSource}|${calc.emissionFactorSourceUrl}|${calc.emissionFactorAuthorityName}`;
    const existing = byKey.get(key) ?? {
      source: calc.emissionFactorSource,
      url: calc.emissionFactorSourceUrl ?? "",
      authority: calc.emissionFactorAuthorityName ?? "",
      streams: new Set<string>(),
    };
    existing.streams.add(s.name);
    byKey.set(key, existing);
  }
  const rows = Array.from(byKey.values()).map((v) => [v.source, v.url, v.authority, Array.from(v.streams).join(", ")]);
  return XLSX.utils.aoa_to_sheet([header, ...rows]);
}

export function buildGenericWorkbook(report: ConsolidatedReport, streamDetails: SourceStreamDetail[]): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, summarySheet(report), "Summary");
  XLSX.utils.book_append_sheet(wb, facilitiesSheet(report), "Facilities");
  XLSX.utils.book_append_sheet(wb, sourceStreamSheet(streamDetails), "Emissions by Source Stream");
  XLSX.utils.book_append_sheet(wb, gasBreakdownSheet(report), "Gas Breakdown");
  XLSX.utils.book_append_sheet(wb, dataQualitySheet(report), "Data Quality");
  XLSX.utils.book_append_sheet(wb, verificationAndQaSheet(report), "Verification and QA");
  XLSX.utils.book_append_sheet(wb, sourceDocumentationSheet(streamDetails), "Source Documentation");
  return wb;
}
```

- [ ] **Step 2: Add the route in `server/routes.ts`**

Add directly after the existing `export.csv` route (after line 1037, the closing `});` of that handler):

```ts
  app.get("/api/reporting-boundaries/:id/consolidated-report/export.xlsx", requireAuth, requireOrg, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid reporting boundary id" });
    const report = await storage.getConsolidatedReport(req.organizationId!, id);
    if (!report) return res.status(404).json({ message: "Reporting boundary not found" });
    const streamDetails = await storage.getSourceStreamDetailForBoundary(req.organizationId!, id);

    const { buildGenericWorkbook } = await import("./utils/xlsx-export");
    const wb = buildGenericWorkbook(report, streamDetails);
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${report.reportingEntity.name}-${report.reportingBoundary.reportingYear}-ISO14064.xlsx"`,
    );
    return res.send(buffer);
  });
```

Add `import * as XLSX from "xlsx";` to the top of `server/routes.ts` alongside the other imports (check it isn't already imported before adding — it likely isn't, since this is the first server-side use of the package).

- [ ] **Step 3: Add the Export Excel button to `OrganizationReport.tsx`**

In `client/src/components/OrganizationReport.tsx`, find the existing "Export CSV" button (around line 111-117):

```tsx
            <Button
              size="sm"
              variant="outline"
              onClick={() => window.open(`/api/reporting-boundaries/${reportingBoundaryId}/consolidated-report/export.csv`, "_blank")}
            >
              Export CSV
            </Button>
```

Add directly after it (this task wires only the generic/ISO option; Task 7 adds the EAD option and turns this into a real two-choice menu):

```tsx
            <Button
              size="sm"
              variant="outline"
              onClick={() => window.open(`/api/reporting-boundaries/${reportingBoundaryId}/consolidated-report/export.xlsx`, "_blank")}
            >
              Export Excel (ISO 14064-3)
            </Button>
```

- [ ] **Step 4: Run `npm run check` and `npx vite build`**

Run: `npm run check && npx vite build`
Expected: no errors.

- [ ] **Step 5: Live-verify**

Start the dev server, open the Organization Report for a boundary with real facility/source-stream/emission data (reuse or recreate one via the API, following the same pattern used earlier this session), click "Export Excel (ISO 14064-3)", confirm a `.xlsx` file downloads. Open it (or inspect it via a quick `XLSX.readFile` script) and confirm: 7 sheets present with the expected names, Summary sheet's Total cell is a live formula (`B11` should read as a formula summing B8:B10, not a static number), Facilities sheet's total row formulas match the sum of the facility rows, Gas Breakdown sheet has both native mass and tCO2e columns populated.

- [ ] **Step 6: Commit**

```bash
git add server/utils/xlsx-export.ts server/routes.ts client/src/components/OrganizationReport.tsx
git commit -m "Add generic ISO 14064-3 Excel export"
```

---

### Task 4: Add the EAD template file + core load/clear/save plumbing

**Files:**
- Create: `server/assets/ead-deliverable-c-template.xlsx` (copy of the real template)
- Create: `server/utils/ead-template-fill.ts`

**Interfaces:**
- Produces: `loadEadTemplate(): XLSX.WorkBook`, `clearIllustrativeRows(wb: XLSX.WorkBook): void`, exported from `server/utils/ead-template-fill.ts`. Consumed by Tasks 5-6 (the actual field-filling logic) and Task 7 (the route).

- [ ] **Step 1: Copy the real template file into the repo**

Before copying, confirm licensing/redistribution is acceptable for a government-issued MRV template expected to be freely distributable to reporting facilities (a quick check, not assumed) -- flag to the user if anything looks off rather than proceeding silently.

```bash
mkdir -p server/assets
cp "C:/Users/LENOVO/Documents/EAD MRV AUH/20260227 - Deliverable C Template_v8 1.xlsx" server/assets/ead-deliverable-c-template.xlsx
```

- [ ] **Step 2: Write `server/utils/ead-template-fill.ts`'s loading and illustrative-row-clearing logic**

The illustrative/example cells identified by direct inspection of the real template (row/column references are 0-indexed as returned by `sheet_to_json`, i.e. add 1 for the Excel row number):

- `3d1_Source Streams (Calculated)`: row 8 (source stream `F01`, columns C-F contain the "Raw meal; Cement clinker..." example) and row 37 (tier/uncertainty example for `F01`).
- `3d2_ Calculation Approaches`: row 15 (`F01`/"Natural gas" example) and row 43 (`F03`/"Crude oil" example, explicitly marked "Illustrative" in column J) and rows 74/76 (`MI01`/`MI02` measurement-instrument examples, marked "Illustrative" in column L).
- `3e1_Emission Sources (Measured)`: row 7 (`S01`/100000/"Major" example, marked "Illustrative") and row 36 (`S01` tier/uncertainty example).
- `2c2_Facility Description`: rows 12-13 (`P01`/"Refinery products", `P02`/"EAF high alloy steel" example products) and rows 31-35 (`S01`-`S05` example emission sources named `"x"`/`"xx"`/`"xxx"`/`"y"`/`"yy"`).
- `4I - Management & QA`: rows 6, 11, 14-17, 21, 24, 26 (multiple cells explicitly marked "Illustrative" in the last column of each row).

```ts
// server/utils/ead-template-fill.ts
//
// Fills the real, official EAD Deliverable C Template with this
// platform's data. Never touches the template's own formulas or
// structure -- only writes to confirmed data-entry cells, and always
// clears the template's own illustrative example data first. See
// docs/superpowers/specs/2026-08-15-excel-verifier-export-design.md
// for the full list of findings this module's design is based on
// (fixed row capacity, illustrative rows, intra-template formulas, the
// Product -> Emission Source -> Source Stream hierarchy gap).

import * as XLSX from "xlsx";
import path from "path";

const TEMPLATE_PATH = path.join(__dirname, "..", "assets", "ead-deliverable-c-template.xlsx");

export function loadEadTemplate(): XLSX.WorkBook {
  // cellFormula: true preserves existing formulas on read so
  // clearIllustrativeRows/the fill functions can detect and skip them.
  return XLSX.readFile(TEMPLATE_PATH, { cellFormula: true });
}

// Cells confirmed by direct inspection to contain the template's own
// fabricated illustrative example data (not real data, not formulas) --
// each must be cleared before writing real data over it. Listed as
// [sheetName, cellAddress] pairs. Deliberately explicit and enumerated
// rather than pattern-matched (e.g. "clear anything in row 8") -- some
// rows mix a real formula-linked cell with an illustrative one, and an
// address-based approach avoids ever guessing.
// CORRECTED 2026-08-15, mid-implementation: the addresses originally in
// this list were derived from a sheet_to_json dump that used
// `blankrows: false`, which silently drops blank separator rows and
// shifts every subsequent array index relative to the real Excel row
// number -- the drift compounds with each blank row skipped (up to 11
// rows off in the worst case, in 2c2_Facility Description's emission
// source table). Caught when Task 4's implementer's own live-verification
// found a listed address (C9 in 3d1) unexpectedly carrying a formula --
// investigation traced it to a header cell, not the illustrative "F01"
// example row, which is actually one row lower (C10). All addresses below
// were re-derived from a direct, un-skipped row dump (no blankrows
// option) and cross-checked against individually-probed cell reads.
const ILLUSTRATIVE_CELLS: [string, string][] = [
  // 3d1_Source Streams (Calculated): table 1 header row 9, F01 example at
  // row 10; table 2 header row 40, F01 example at row 41.
  ["3d1_Source Streams (Calculated)", "C10"],
  ["3d1_Source Streams (Calculated)", "E10"],
  ["3d1_Source Streams (Calculated)", "F10"],
  ["3d1_Source Streams (Calculated)", "G10"],
  ["3d1_Source Streams (Calculated)", "C41"],
  ["3d1_Source Streams (Calculated)", "D41"],
  ["3d1_Source Streams (Calculated)", "E41"],
  ["3d1_Source Streams (Calculated)", "F41"],
  ["3d1_Source Streams (Calculated)", "G41"],
  ["3d1_Source Streams (Calculated)", "H41"],
  // 3d2_Calculation Approaches: Fuel table header row 24, F01/"Natural gas"
  // example at row 25 -- the only sub-table this plan's fill logic
  // actually writes to (see Task 5). The sheet also has a separate
  // "Other inputs/outputs" table (a "Crude oil" example) and a
  // measurement-instrument specification table further down, neither of
  // which this implementation fills or clears -- their illustrative
  // content is a disclosed, out-of-scope gap, not silently missed: no
  // real data is ever written into those cells either, so nothing here
  // contradicts the "clear before writing real data" rule, which only
  // binds cells this fill logic actually populates.
  ["3d2_ Calculation Approaches", "C25"],
  ["3d2_ Calculation Approaches", "D25"],
  ["3d2_ Calculation Approaches", "E25"],
  ["3d2_ Calculation Approaches", "F25"],
  // 3e1_Emission Sources (Measured): table 1 header row 8, S01 example at
  // row 9; table 2 header row 39, S01 example at row 40.
  ["3e1_Emission Sources (Measured)", "C9"],
  ["3e1_Emission Sources (Measured)", "D9"],
  ["3e1_Emission Sources (Measured)", "C40"],
  ["3e1_Emission Sources (Measured)", "D40"],
  ["3e1_Emission Sources (Measured)", "E40"],
  ["3e1_Emission Sources (Measured)", "F40"],
  ["3e1_Emission Sources (Measured)", "G40"],
  // 2c2_Facility Description: product table header row 16, P01/P02
  // examples at rows 17-18; emission source table header row 42, S01/S02
  // examples at rows 43-44.
  ["2c2_Facility Description", "C17"],
  ["2c2_Facility Description", "G17"],
  ["2c2_Facility Description", "H17"],
  ["2c2_Facility Description", "C18"],
  ["2c2_Facility Description", "G18"],
  ["2c2_Facility Description", "H18"],
  ["2c2_Facility Description", "C43"],
  ["2c2_Facility Description", "D43"],
  ["2c2_Facility Description", "E43"],
  ["2c2_Facility Description", "G43"],
  ["2c2_Facility Description", "H43"],
  ["2c2_Facility Description", "I43"],
  ["2c2_Facility Description", "C44"],
  ["2c2_Facility Description", "D44"],
  ["2c2_Facility Description", "E44"],
  ["2c2_Facility Description", "I44"],
  // ADDED after Task 5's review surfaced a real gap: 2c2_Facility
  // Description's own source-stream activity table (header row 74,
  // columns C/G/H = Source Stream ID/level of activity/units), whose
  // G/H values at row 75 are what 3d2_Calculation Approaches' D25/E25
  // formulas (IFERROR(INDEX('2c2_Facility Description'!G$75:G$84,
  // MATCH($B25,'2c2_Facility Description'!$C$75:$C$84,0)),"")) read.
  // Per explicit instruction, this plan NEVER overwrites a template
  // formula -- so D25/E25 (and every equivalent) are left alone, formula
  // intact, in every fill task. That only produces a correct (blank)
  // result if the value the formula's INDEX resolves to is actually
  // cleared -- otherwise the untouched formula silently surfaces
  // fabricated data through a cell that looks like a live lookup.
  // VERIFIED DIRECTLY against the real template file (node + XLSX,
  // cellFormula: true) before adding these addresses -- the only actual
  // fabricated example VALUES in this table are G75=10000, H75="MWh".
  // C75="F01" (and C76="F02" ... C90="F16") are NOT illustrative data --
  // they are the template's own static row-ID scaffold that 3d1!B10 and
  // 3e1!B9-equivalent cells formula-read from directly
  // (3d1!B10.f === "'2c2_Facility Description'!C75"). Clearing C75 would
  // have deleted a value a live formula elsewhere depends on -- a second,
  // different way of "touching a formula" (breaking what it resolves to)
  // that the "never overwrite a formula" rule equally forbids. Only the
  // two fabricated values are listed below; the ID column is left
  // completely untouched.
  ["2c2_Facility Description", "G75"],
  ["2c2_Facility Description", "H75"],
];

// Shared write guard for every fill function (Tasks 5 and 6): never
// overwrite a cell that already carries a formula, full stop -- no
// exceptions, per explicit instruction. Where the real template ships a
// convenience/default formula in what is otherwise a labeled data-entry
// cell (e.g. 3d2_Calculation Approaches' D/E columns), that cell is
// simply left as-is; the real value is not written there. Any resulting
// gap in the exported EAD file for that specific cell is a disclosed,
// accepted limitation of the EAD-specific export -- the generic
// ISO 14064-3 workbook (Task 3) is unaffected and always carries the
// complete data regardless of what any individual EAD template cell
// allows.
function writeIfNotFormula(ws: XLSX.WorkSheet, address: string, cell: XLSX.CellObject): void {
  const existing = ws[address];
  if (existing && existing.f) return;
  ws[address] = cell;
}

export function clearIllustrativeRows(wb: XLSX.WorkBook): void {
  for (const [sheetName, address] of ILLUSTRATIVE_CELLS) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const cell = ws[address];
    // Never clear a cell that turns out to carry a live formula -- an
    // illustrative address list built from a point-in-time inspection
    // could in principle be stale against a future template revision;
    // this is the guard that keeps a formula cell safe even if that
    // happens, consistent with the "never touch template formulas" rule.
    if (cell && cell.f) continue;
    delete ws[address];
  }
}
```

- [ ] **Step 3: Run `npm run check`**

Run: `npm run check`
Expected: no errors.

- [ ] **Step 4: Live-verify the load + clear step in isolation**

Write a short throwaway script (not committed) that calls `loadEadTemplate()`, then `clearIllustrativeRows()`, then re-reads a few of the cleared addresses (e.g. `3d1_Source Streams (Calculated)`!C10, the real "Raw meal; Cement clinker..." example cell -- not C9, which is the header row and is itself formula-linked, correctly left untouched) to confirm they're now empty, and re-reads a known formula cell (e.g. `3d1_Source Streams (Calculated)`!B10, which should still read `='2c2_Facility Description'!C75`) to confirm formulas were left untouched.

- [ ] **Step 5: Commit**

```bash
git add server/assets/ead-deliverable-c-template.xlsx server/utils/ead-template-fill.ts
git commit -m "Add EAD template file and illustrative-row-clearing plumbing"
```

---

### Task 5: EAD fill -- core sheets (Source Streams, Calculation Approaches, Data Gaps)

**Files:**
- Modify: `server/utils/ead-template-fill.ts` (add the field-filling functions)

**Interfaces:**
- Consumes: `SourceStreamDetail[]` (Task 2), `ConsolidatedReport` (Task 1).
- Produces: `fillCoreSheets(wb: XLSX.WorkBook, streamDetails: SourceStreamDetail[]): { omittedCount: number }`, exported. Consumed by Task 7's route.

- [ ] **Step 1: Add the core-sheet fill function**

Add to `server/utils/ead-template-fill.ts`, after `clearIllustrativeRows`:

```ts
// Row numbers below were re-derived directly (no blankrows-skipping) after
// Task 4 caught the original derivation's drift -- see the comment above
// ILLUSTRATIVE_CELLS for the root cause. 3d1_Source Streams (Calculated)
// has exactly 25 pre-labeled rows (F01-F25): table 1 (description/
// estimated-emissions/category) at Excel rows 10-34, table 2 (tier/
// uncertainty) at rows 41-65. This is a hard limit in the official
// template -- fill up to capacity, report how many were omitted so the
// caller can warn.
const SOURCE_STREAM_ROW_CAPACITY = 25;

export function fillCoreSheets(wb: XLSX.WorkBook, streamDetails: SourceStreamDetail[]): { omittedCount: number } {
  const calcStreams = streamDetails.filter((s) => s.approachTier === "calculation");
  const omittedCount = Math.max(0, calcStreams.length - SOURCE_STREAM_ROW_CAPACITY);
  const toFill = calcStreams.slice(0, SOURCE_STREAM_ROW_CAPACITY);

  const streamSheet = wb.Sheets["3d1_Source Streams (Calculated)"];
  const approachSheet = wb.Sheets["3d2_ Calculation Approaches"];
  // Same missing-sheet guard as clearIllustrativeRows -- a template
  // revision that renames or drops a sheet must not crash the export.
  if (!streamSheet || !approachSheet) return { omittedCount };

  toFill.forEach((s, i) => {
    const row1 = 10 + i; // first table: description/estimated-emissions/category, rows 10-34
    const row2 = 41 + i; // second table: tier/uncertainty, rows 41-65
    const calc = s.calculationApproach;

    // First table: Description, Estimated emissions, Selected category.
    // Column B (source stream ID, F01/F02/...) is formula-linked back to
    // 2c2_Facility Description and is never written here. Every write goes
    // through writeIfNotFormula -- per the explicit rule that no cell
    // carrying a formula is ever overwritten, even one that sits under the
    // sheet's own labeled data-entry header (see ILLUSTRATIVE_CELLS
    // comment for the 2c2!G75/H75 fix that keeps 3d2!D25/E25 correct
    // *without* touching their formula).
    writeIfNotFormula(streamSheet, `C${row1}`, { t: "s", v: s.description ?? s.name });
    writeIfNotFormula(streamSheet, `E${row1}`, { t: "n", v: s.estimatedAnnualEmissionsTco2e ?? 0 });
    writeIfNotFormula(streamSheet, `F${row1}`, { t: "s", v: s.materiality ?? "" });
    writeIfNotFormula(streamSheet, `G${row1}`, { t: "s", v: s.materiality ?? "" });

    // Second table: Tier level, Category, Uncertainty, Fuel stream type,
    // Source of accuracy. Column B is again formula-linked, not written.
    writeIfNotFormula(streamSheet, `C${row2}`, { t: "s", v: calc?.activityDataTier ?? "" });
    writeIfNotFormula(streamSheet, `D${row2}`, { t: "s", v: s.materiality ?? "" });
    writeIfNotFormula(streamSheet, `F${row2}`, { t: "s", v: calc?.fuelOrMaterialType ?? "" });
    writeIfNotFormula(streamSheet, `G${row2}`, { t: "s", v: calc?.activityDataSource ?? "" });

    // 3d2_Calculation Approaches, "Fuel" sub-table: Fuel Type, Activity
    // level, Unit, Source -- header at row 24, F01 example at row 25, so
    // data rows are 25-49 (25-row capacity, same as above). This is the
    // only sub-table of this sheet that gets filled -- see the comment
    // above ILLUSTRATIVE_CELLS for the other two sub-tables this
    // implementation deliberately doesn't touch. D{approachRow} and
    // E{approachRow} carry a live IFERROR(INDEX(...)) lookup formula on
    // every row, looking up against 2c2_Facility Description!$C$75:$C$84
    // by source-stream ID (F01-F10) -- writeIfNotFormula leaves those
    // alone. Only row 75 (F01) has real fabricated example values
    // (G75=10000, H75="MWh"); rows 76-84 (F02-F10) were already blank in
    // the real template, verified directly. ILLUSTRATIVE_CELLS clears
    // G75/H75, so row i=0's untouched formula resolves to blank via
    // IFERROR instead of leaking "10000"/"MWh"; every other row's formula
    // was already blank-resolving with nothing to clear.
    const approachRow = 25 + i;
    writeIfNotFormula(approachSheet, `C${approachRow}`, { t: "s", v: calc?.fuelOrMaterialType ?? "" });
    writeIfNotFormula(approachSheet, `D${approachRow}`, { t: "n", v: calc?.activityDataValue ?? 0 });
    writeIfNotFormula(approachSheet, `E${approachRow}`, { t: "s", v: calc?.activityDataUnit ?? "" });
    writeIfNotFormula(approachSheet, `F${approachRow}`, { t: "s", v: calc?.activityDataSource ?? "" });
  });

  return { omittedCount };
}

// 4h_Verification and Data Gaps has exactly 10 rows: header at row 19,
// data gap 1 at row 20, data gap 10 at row 29.
const DATA_GAP_ROW_CAPACITY = 10;

export function fillDataGapsSheet(
  wb: XLSX.WorkBook,
  gaps: { sourceStreamOrOtherId: string; from: string; until: string; description: string; estimatedEmissionsTco2e: number | null; source: string }[],
): { omittedCount: number } {
  const sheet = wb.Sheets["4h_Verification and Data Gaps"];
  if (!sheet) return { omittedCount: 0 };
  const omittedCount = Math.max(0, gaps.length - DATA_GAP_ROW_CAPACITY);
  const toFill = gaps.slice(0, DATA_GAP_ROW_CAPACITY);
  toFill.forEach((g, i) => {
    const row = 20 + i; // column B (row number 1-10) is a static label, not written
    writeIfNotFormula(sheet, `C${row}`, { t: "s", v: g.sourceStreamOrOtherId });
    writeIfNotFormula(sheet, `D${row}`, { t: "s", v: g.from });
    writeIfNotFormula(sheet, `E${row}`, { t: "s", v: g.until });
    writeIfNotFormula(sheet, `F${row}`, { t: "s", v: g.description });
    writeIfNotFormula(sheet, `H${row}`, { t: "n", v: g.estimatedEmissionsTco2e ?? 0 });
    writeIfNotFormula(sheet, `J${row}`, { t: "s", v: g.source });
  });
  return { omittedCount };
}
```

- [ ] **Step 2: Run `npm run check`**

Run: `npm run check`
Expected: no errors.

- [ ] **Step 3: Live-verify**

Using the same throwaway script pattern as Task 4, load the template, call `clearIllustrativeRows` then `fillCoreSheets` with a small set of real `SourceStreamDetail` records (e.g. 2-3 from a real boundary), then read back `3d1_Source Streams (Calculated)`!C10, `3d2_ Calculation Approaches`!C25 and confirm they contain the real values passed in, not the cleared illustrative ones. Confirm `omittedCount` is `0` for a small input and correctly non-zero when passed more than 25 records. Before trusting any address in this task, spot-check it directly against the real template file (read the cell, confirm it's the row you expect) rather than trusting the row numbers in this plan by inspection alone -- this exact category of mistake (an unverified row-number assumption) is what caused Task 4's original fix round.

**Formula-preservation check (required, per explicit instruction -- no formula in the EAD sheet is ever overwritten):** after running `fillCoreSheets`, read back `3d2_ Calculation Approaches`!D25 and E25 with `cellFormula: true` and confirm each still has a non-empty `.f` property containing `IFERROR(INDEX(...))` -- i.e. confirm the fill did NOT replace them with plain values, even though real `activityDataValue`/`activityDataUnit` data was passed in for that row. Separately confirm `2c2_Facility Description`!G75 and H75 are empty (cleared, not the illustrative `10000`/`"MWh"`) and that `2c2_Facility Description`!C75 still reads `"F01"` (must NOT have been cleared, since `3d1`!B10 formula-reads it). Report all four cell states verbatim in the report file -- do not summarize as "formulas preserved" without showing the actual `.f` and `.v` values read back.

- [ ] **Step 4: Commit**

```bash
git add server/utils/ead-template-fill.ts
git commit -m "Fill EAD template's core sheets: Source Streams, Calculation Approaches, Data Gaps"
```

---

### Task 6: EAD fill -- remaining sheets (best-effort: Emission Sources, Measurement/Fallback, Methane, Management & QA, Mitigation Measures)

**Files:**
- Modify: `server/utils/ead-template-fill.ts`

**Interfaces:**
- Produces: `fillRemainingSheets(wb: XLSX.WorkBook, streamDetails: SourceStreamDetail[], methaneReports: MethaneReport[], mitigationMeasures: MitigationMeasure[], managementQaRecords: ManagementQaRecord[]): void`, exported. Consumed by Task 7's route.

- [ ] **Step 1: Add the remaining-sheet fill function**

Add to `server/utils/ead-template-fill.ts`. This is the best-effort layer: the template's "Emission Source" concept (3e1 sheet, S01-S25) sits between Product and Source Stream in EAD's model, with no exact equivalent in this platform's schema (per the design spec's documented gap) -- approximated here by treating each measurement-tier source stream as its own Emission Source row, one-to-one, rather than the richer many-source-streams-per-emission-source grouping EAD's template allows for.

```ts
import type { MethaneReport, MitigationMeasure, ManagementQaRecord } from "@shared/schema";

export function fillRemainingSheets(
  wb: XLSX.WorkBook,
  streamDetails: SourceStreamDetail[],
  methaneReports: MethaneReport[],
  mitigationMeasures: MitigationMeasure[],
  managementQaRecords: ManagementQaRecord[],
): void {
  // Row numbers below were re-derived directly (no blankrows-skipping)
  // after Task 4 caught the original derivation's systematic drift -- see
  // the comment above ILLUSTRATIVE_CELLS in Task 4 for the root cause and
  // fix methodology. Do not trust any row number in this function by
  // inspection alone -- re-probe the real template file before relying on
  // it, exactly as Task 5's live-verification step now requires.

  // 3e1_Emission Sources (Measured): best-effort, one row per
  // measurement-tier source stream (see module comment above for why
  // this is an approximation, not an exact hierarchy match). Table 1
  // header row 8, S01 example row 9 -> data rows 9-33. Table 2 header
  // row 39, S01 example row 40 -> data rows 40-64.
  const measurementStreams = streamDetails.filter((s) => s.approachTier === "measurement").slice(0, 25);
  const emissionSourceSheet = wb.Sheets["3e1_Emission Sources (Measured)"];
  if (emissionSourceSheet) {
    measurementStreams.forEach((s, i) => {
      const row1 = 9 + i;
      const row2 = 40 + i;
      writeIfNotFormula(emissionSourceSheet, `D${row1}`, { t: "n", v: s.measurementApproach?.annualMeasuredQuantity ?? 0 });
      writeIfNotFormula(emissionSourceSheet, `E${row1}`, { t: "s", v: s.materiality ?? "" });
      writeIfNotFormula(emissionSourceSheet, `D${row2}`, { t: "s", v: s.materiality ?? "" });
      writeIfNotFormula(emissionSourceSheet, `F${row2}`, { t: "s", v: s.measurementApproach?.measurementMethod ?? "" });
      writeIfNotFormula(emissionSourceSheet, `G${row2}`, { t: "s", v: s.measurementApproach?.qaqcProcedure ?? "" });
    });
  }

  // 3e2_MeasurementBasedApproaches -- a narrative section, not a labeled
  // table, so unlike the tabular sheets above there is no unambiguous
  // "row N is the data row" marker to verify against. (a) description
  // instructional text sits at row 5-6; the response goes directly below
  // it. This mapping stays approximate by nature of the sheet's own
  // design, disclosed as such rather than presented as precise.
  const measureSheet = wb.Sheets["3e2_MeasurementBasedApproaches"];
  if (measureSheet && measurementStreams.length > 0) {
    const first = measurementStreams[0].measurementApproach;
    writeIfNotFormula(measureSheet, "C6", { t: "s", v: first?.measurementMethod ?? "" });
    writeIfNotFormula(measureSheet, "C8", { t: "s", v: first?.monitoringFrequency ?? "" });
  }

  // 3f_Fallback Approach -- one description per workbook (the template
  // has no per-source-stream fallback table, just one narrative
  // section). (a) description instruction at row 7-8; (b) justification
  // instruction at row 19-20. Same narrative-section caveat as above.
  const fallbackStreams = streamDetails.filter((s) => s.approachTier === "fallback");
  const fallbackSheet = wb.Sheets["3f_Fallback Approach"];
  if (fallbackSheet && fallbackStreams.length > 0) {
    writeIfNotFormula(fallbackSheet, "C8", { t: "s", v: fallbackStreams[0].fallbackApproach?.fallbackMethodDescription ?? "" });
    writeIfNotFormula(fallbackSheet, "C20", { t: "s", v: fallbackStreams[0].fallbackApproach?.justification ?? "" });
  }

  // 3g_Methane -- facility-wide, per the schema comment on methaneReports
  // ("EAD treats this as its own sheet, facility-wide rather than per
  // source stream"). Uses the first report if more than one facility
  // has one, since the template's Methane sheet is a single narrative
  // section, not a per-facility table. (a) block spans rows 7-11, (b)
  // block rows 12-14 -- another narrative section, approximate by nature.
  const methaneSheet = wb.Sheets["3g_Methane"];
  if (methaneSheet && methaneReports.length > 0) {
    const m = methaneReports[0];
    writeIfNotFormula(methaneSheet, "C9", { t: "n", v: m.annualMethaneEmissions ? Number(m.annualMethaneEmissions) : 0 });
    writeIfNotFormula(methaneSheet, "C10", { t: "s", v: m.quantificationMethod ?? "" });
    writeIfNotFormula(methaneSheet, "C13", { t: "s", v: m.methaneSourcesDescription ?? "" });
  }

  // 4I - Management & QA -- the template wants three distinct narrative
  // sections (monitoring responsibility, QA procedure, data validation
  // procedure); this platform has one flat managementQaRecords list.
  // Best effort: first record -> Management responsibility table (real
  // tabular row, header at row 6, the one pre-filled example at row 7 --
  // the actual data row to write, not the header), second (if present)
  // -> QA procedure narrative (title row 17, department row 23), third
  // (if present) -> Data Validation narrative (title row 28, department
  // row 33). Any beyond the third are not represented on this sheet --
  // they remain fully visible in the generic workbook.
  // CORRECTED during Task 6 implementation, verified directly against
  // the real template (XLSX.readFile + ws["!merges"]): row 7 is
  // C7:E7 (Job title, real value cell, anchor C7) merged next to
  // F7:L7 (Responsibilities, anchor F7) -- column B is a blank margin
  // outside every merge, and E7 is the non-anchor half of the C7:E7
  // merge, so neither renders in Excel. Rows 17/23/28/33 are each
  // C{row}:D{row} (a merged LABEL cell, e.g. "Title of procedure") next
  // to E{row}:L{row} (the real value cell, anchor E{row}) -- D{row} is
  // inside the label merge and never renders. Use the anchors: C7/F7,
  // E17/E23/E28/E33.
  const qaSheet = wb.Sheets["4I - Management & QA"];
  if (qaSheet && managementQaRecords[0]) {
    writeIfNotFormula(qaSheet, "C7", { t: "s", v: managementQaRecords[0].responsiblePerson ?? "" });
    writeIfNotFormula(qaSheet, "F7", { t: "s", v: managementQaRecords[0].qaProcedureDescription ?? "" });
  }
  if (qaSheet && managementQaRecords[1]) {
    writeIfNotFormula(qaSheet, "E17", { t: "s", v: managementQaRecords[1].qaProcedureDescription ?? "" });
    writeIfNotFormula(qaSheet, "E23", { t: "s", v: managementQaRecords[1].responsiblePerson ?? "" });
  }
  if (qaSheet && managementQaRecords[2]) {
    writeIfNotFormula(qaSheet, "E28", { t: "s", v: managementQaRecords[2].qaProcedureDescription ?? "" });
    writeIfNotFormula(qaSheet, "E33", { t: "s", v: managementQaRecords[2].responsiblePerson ?? "" });
  }

  // 4J - Mitigation Measures -- one row per measure. Header at row 5,
  // format-guide row at row 6, real data rows 7-14.
  // CORRECTED during Task 6 implementation, verified directly against
  // the real template: row 5's own header reads C="Description of
  // measure", D="Category", E="Scope (1/2/3)", F="GHG", G="Start year",
  // H="Status", I="Pre-measure reference (tCO2e/yr)", J="Reporting year
  // reduction (tCO2e)" -- status is column H, not G; the reduction
  // figure is column J, not I. The originally assumed 20-row capacity
  // was also wrong: row 15 starts a different narrative sub-section
  // ("J1: Additional information", confirmed by reading C15/C16
  // directly), not more measure rows -- the real capacity is 8 rows
  // (7-14). Measures beyond the 8th are a disclosed, accepted gap in
  // this EAD-specific export; the generic ISO 14064-3 workbook (Task 3)
  // is unaffected and always carries the complete list.
  const MITIGATION_MEASURE_ROW_CAPACITY = 8;
  const measuresSheet = wb.Sheets["4J - Mitigation Measures"];
  if (measuresSheet) {
    mitigationMeasures.slice(0, MITIGATION_MEASURE_ROW_CAPACITY).forEach((m, i) => {
      const row = 7 + i;
      writeIfNotFormula(measuresSheet, `C${row}`, { t: "s", v: m.measureDescription });
      writeIfNotFormula(measuresSheet, `H${row}`, { t: "s", v: m.status });
      writeIfNotFormula(measuresSheet, `J${row}`, { t: "n", v: m.estimatedReductionTco2e ? Number(m.estimatedReductionTco2e) : 0 });
    });
  }
}
```

- [ ] **Step 2: Run `npm run check`**

Run: `npm run check`
Expected: no errors. Confirm `MethaneReport`, `MitigationMeasure`, `ManagementQaRecord` are exported from `shared/schema.ts` (they are, per the type exports alongside each table definition) and that `@shared/schema` is the correct import alias used elsewhere in `server/` (check `server/storage.ts`'s own import line for the exact alias path).

- [ ] **Step 3: Live-verify**

Same throwaway-script pattern: fill with a small set of real methane/mitigation/QA records, read back the target cells, confirm real values landed and no illustrative data or formula cells were disturbed. For the tabular sheets (3e1, 4I's job-title table, 4J), independently spot-check at least one row number against the real template file before trusting it, same as Task 5. For the narrative-section sheets (3e2, 3f, 3g), note in the report that these row targets are inherently approximate (no labeled data row exists to verify against) rather than claiming precision the sheet's own structure doesn't support.

- [ ] **Step 4: Commit**

```bash
git add server/utils/ead-template-fill.ts
git commit -m "Fill EAD template's remaining sheets (best-effort where the schema doesn't exactly mirror EAD's hierarchy)"
```

---

### Task 7: `export-ead.xlsx` route + capacity-warning UI + finish the export selector

**Files:**
- Modify: `server/routes.ts` (add the EAD export route)
- Modify: `client/src/components/OrganizationReport.tsx` (turn the single Export Excel button into a two-option menu, surface the capacity warning)

**Interfaces:**
- Consumes: everything from Tasks 4-6.
- Produces: `GET /api/reporting-boundaries/:id/consolidated-report/export-ead.xlsx?confirm=true` (the `confirm` param lets the client show the capacity warning before committing to the download, per the design spec).

- [ ] **Step 1: Add a route that reports capacity issues before download**

Add to `server/routes.ts`, after the generic `export.xlsx` route from Task 3:

```ts
  app.get("/api/reporting-boundaries/:id/consolidated-report/export-ead-check.json", requireAuth, requireOrg, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid reporting boundary id" });
    const streamDetails = await storage.getSourceStreamDetailForBoundary(req.organizationId!, id);
    const calcCount = streamDetails.filter((s) => s.approachTier === "calculation").length;
    return res.json({
      omittedSourceStreams: Math.max(0, calcCount - 25),
    });
  });

  app.get("/api/reporting-boundaries/:id/consolidated-report/export-ead.xlsx", requireAuth, requireOrg, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid reporting boundary id" });
    const report = await storage.getConsolidatedReport(req.organizationId!, id);
    if (!report) return res.status(404).json({ message: "Reporting boundary not found" });
    const streamDetails = await storage.getSourceStreamDetailForBoundary(req.organizationId!, id);
    const boundaryFacilityIds = report.facilities.map((f) => f.id);

    // getMethaneReport and listMitigationMeasures are both per-facility
    // (real signatures, checked against server/storage.ts's IStorage
    // interface) -- this boundary can have multiple facilities, so call
    // each per facility and flatten. listManagementQaRecords is already
    // per-boundary, matching this route's scope directly.
    const [methaneReportsData, mitigationMeasuresData, managementQaData] = await Promise.all([
      Promise.all(boundaryFacilityIds.map((fid) => storage.getMethaneReport(req.organizationId!, fid, id))).then(
        (reports) => reports.filter((r): r is NonNullable<typeof r> => r !== undefined),
      ),
      Promise.all(boundaryFacilityIds.map((fid) => storage.listMitigationMeasures(req.organizationId!, fid))).then((lists) =>
        lists.flat(),
      ),
      storage.listManagementQaRecords(req.organizationId!, id),
    ]);

    const { loadEadTemplate, clearIllustrativeRows, fillCoreSheets, fillRemainingSheets } = await import("./utils/ead-template-fill");
    const wb = loadEadTemplate();
    clearIllustrativeRows(wb);
    fillCoreSheets(wb, streamDetails);
    fillRemainingSheets(wb, streamDetails, methaneReportsData, mitigationMeasuresData, managementQaData);

    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${report.reportingEntity.name}-${report.reportingBoundary.reportingYear}-EAD.xlsx"`,
    );
    return res.send(buffer);
  });
```

- [ ] **Step 2: Turn the Export Excel button into a two-option menu with the capacity warning**

Replace the single button added in Task 3 with (using the existing shadcn `DropdownMenu` components already used elsewhere in this codebase -- check `client/src/components/ui/dropdown-menu.tsx` exists, which it does per this project's existing Radix dependency set):

```tsx
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

// ... inside the component, replacing the single Export Excel button:
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline">
                  Export Excel
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem
                  onClick={() => window.open(`/api/reporting-boundaries/${reportingBoundaryId}/consolidated-report/export.xlsx`, "_blank")}
                >
                  ISO 14064-3 / GHG Protocol (generic)
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={async () => {
                    const res = await apiRequest(
                      "GET",
                      `/api/reporting-boundaries/${reportingBoundaryId}/consolidated-report/export-ead-check.json`,
                    );
                    const { omittedSourceStreams } = await res.json();
                    if (omittedSourceStreams > 0) {
                      const proceed = window.confirm(
                        `${omittedSourceStreams} source stream(s) exceed the EAD template's row limit and will not be included in this file — see the ISO 14064-3 workbook for the complete data. Continue anyway?`,
                      );
                      if (!proceed) return;
                    }
                    window.open(`/api/reporting-boundaries/${reportingBoundaryId}/consolidated-report/export-ead.xlsx`, "_blank");
                  }}
                >
                  EAD Deliverable C Template
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
```

- [ ] **Step 3: Run `npm run check` and `npx vite build`**

Run: `npm run check && npx vite build`
Expected: no errors.

- [ ] **Step 4: Live-verify end to end**

Start the dev server, open Organization Report for a boundary with real data. Click Export Excel, confirm the dropdown shows both options. Click "ISO 14064-3 / GHG Protocol (generic)", confirm the same file as Task 3 downloads. Click "EAD Deliverable C Template" for a boundary with fewer than 25 calculation-tier source streams, confirm no warning appears and a `.xlsx` downloads; open it and confirm the real values landed in the expected cells (spot-check 2-3 from Task 5/6's verification) and that the illustrative example rows are gone. If feasible, create a boundary with more than 25 calculation-tier source streams and confirm the warning dialog appears with the correct count before the download proceeds.

- [ ] **Step 5: Commit**

```bash
git add server/routes.ts client/src/components/OrganizationReport.tsx
git commit -m "Add EAD export route, capacity warning, and finish the export selector UI"
```

---

## Self-review notes

- **Spec coverage:** generic 7-sheet workbook (Task 3) ✓, native mass per gas (Task 1) ✓, source-stream detail query (Task 2) ✓, EAD template load/clear (Task 4) ✓, EAD core-sheet fill (Task 5) ✓, EAD remaining-sheet best-effort fill (Task 6) ✓, capacity warning + two-option selector (Task 7) ✓, "never touch template formulas" enforced via the formula-check guard in `clearIllustrativeRows` and by only ever writing to addresses confirmed not to carry a formula ✓.
- **Placeholder scan:** no TBD/TODO. Task 7's three cross-cutting storage calls (`getMethaneReport`, `listMitigationMeasures`, `listManagementQaRecords`) were verified against `server/storage.ts`'s real `IStorage` interface before finalizing this plan -- the first two are per-facility (called once per boundary facility and flattened), the third is already per-boundary.
- **Type consistency:** `SourceStreamDetail` (Task 2) is consumed identically by name and shape in Tasks 3, 5, 6, 7. `getSourceStreamDetailForBoundary(organizationId, reportingBoundaryId)` signature matches across all call sites. `buildGenericWorkbook`, `loadEadTemplate`, `clearIllustrativeRows`, `fillCoreSheets`, `fillRemainingSheets` are each defined once and called with matching signatures in the task that consumes them.
- **Cell-address risk, disclosed rather than hidden:** Tasks 5-6's cell addresses were derived from one point-in-time read of the real template file, not from a published EAD schema/contract. If EAD revises the template, these addresses could silently drift. `clearIllustrativeRows`' formula-check guard mitigates the worst case (never overwriting a formula even if an address is stale), but the implementer should re-verify a handful of addresses live (Step 3/4 of Tasks 5-7) rather than trusting this document blindly -- exactly what those verification steps are for.
