# Verification-Ready Inventory — Plan 3: Consolidated Rollup View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is Plan 3 of 4 for `docs/superpowers/specs/2026-08-14-verification-ready-multi-facility-inventory-design.md`. **Requires Plan 1 and Plan 2 complete** — this plan reads `emission_records` rows Plan 2's calculation trigger writes, and the `status`/`finalizedAt` fields Plan 2's finalize mechanic sets.

**Goal:** Build the "Organization Report" — the actual auditable global data sheet: one screen per reporting entity + year that consolidates every facility's emissions, applying the declared consolidation approach (control vs. equity share), with the gas breakdown, intensity ratios, base-year comparison, data-quality summary, and verification findings all in one place (Section 3 of the design spec).

**Architecture:** One new aggregation endpoint (`GET /api/reporting-boundaries/:id/consolidated-report`), one new storage method doing the actual SQL aggregation, one new React component, wired into `AppShell.tsx` as a new nav section.

**Tech Stack:** Express, Drizzle (`sql` aggregate helpers), React + TanStack Query, reusing `ResultsView.tsx`'s existing per-gas table pattern.

## Global Constraints

- Every tenant-scoped query MUST filter on `organizationId`.
- A facility with no source streams yet is still listed, flagged incomplete — never silently dropped (ISO 14064-3: an unexplained missing source is itself a materiality issue).
- Biogenic CO2 is kept as a separate memo figure, never netted into gross totals.
- Finalizing is blocked if `equity_share` is selected but any facility lacks `equityShareOwnershipPercent`.

---

### Task 1: The consolidated-report aggregation endpoint

**Files:**
- Modify: `server/storage.ts` (new method `getConsolidatedReport`)
- Modify: `server/routes.ts` (new route)

**Interfaces:**
- Consumes: `emission_records` (Plan 1/2 columns), `facilities.equityShareOwnershipPercent` (Plan 1), `reportingBoundaries.consolidationApproach`/`status`/`revenueAmount`/`revenueCurrency`/`fullTimeEquivalentEmployees` (Plan 1), `reportingEntities.baseYear` (Plan 1), `facilityProducts.actualProduction` (existing), `dataQualityRecords`/`verificationFindings`/`managementQaRecords` (existing).
- Produces: `GET /api/reporting-boundaries/:id/consolidated-report` → JSON shape consumed by Task 2's UI:

```ts
interface ConsolidatedReport {
  reportingBoundary: { id: number; reportingYear: number; consolidationApproach: string; status: string; finalizedAt: string | null };
  reportingEntity: { id: number; name: string; baseYear: number | null; baseYearRationale: string | null };
  totals: { scope1: number; scope2: number; scope3: number; biogenicCo2: number };
  gasBreakdown: { gas: string; co2e: number; pctOfTotal: number }[];
  facilities: {
    id: number;
    name: string;
    country: string | null;
    equityShareOwnershipPercent: number | null;
    incomplete: boolean;
    scope1: number;
    scope2: number;
    scope3: number;
  }[];
  intensity: { revenuePerTco2e: number | null; fteEmployeesPerTco2e: number | null; productionPerTco2e: number | null };
  gasCoverage: { gas: string; covered: boolean }[];
  dataQualityRecords: unknown[];
  verificationFindings: unknown[];
  managementQaRecords: unknown[];
  baseYearComparison: { baseYearTotal: number | null; currentYearTotal: number; changePercent: number | null } | null;
}
```

- [ ] **Step 1: Add the storage method**

In `server/storage.ts`, add to `IStorage`:

```ts
  getConsolidatedReport(organizationId: number, reportingBoundaryId: number): Promise<ConsolidatedReport | undefined>;
```

Add the `ConsolidatedReport` type near the top of the file (or import from a new `shared/consolidatedReport.ts` if you prefer keeping large response-shape types out of `storage.ts` — either is fine, this project doesn't have an established convention for this yet since no prior endpoint returns a shape this large).

Implement it in `DbStorage`:

```ts
  async getConsolidatedReport(organizationId: number, reportingBoundaryId: number): Promise<ConsolidatedReport | undefined> {
    const boundary = await this.getReportingBoundary(organizationId, reportingBoundaryId);
    if (!boundary) return undefined;
    const entity = await this.getReportingEntity(organizationId, boundary.reportingEntityId);
    if (!entity) return undefined;

    const entityFacilities = await db
      .select()
      .from(facilities)
      .where(and(eq(facilities.organizationId, organizationId), eq(facilities.reportingEntityId, entity.id)));

    const records = await db
      .select()
      .from(emissionRecordsTable)
      .where(
        and(
          eq(emissionRecordsTable.organizationId, organizationId),
          eq(emissionRecordsTable.reportingBoundaryId, reportingBoundaryId),
        ),
      );

    const isEquityShare = boundary.consolidationApproach === "equity_share";

    function facilityMultiplier(facilityId: number): number {
      if (!isEquityShare) return 1;
      const f = entityFacilities.find((x) => x.id === facilityId);
      const pct = f?.equityShareOwnershipPercent;
      return pct !== null && pct !== undefined ? Number(pct) / 100 : 0;
    }

    const scopeTotals = { scope1: 0, scope2: 0, scope3: 0 };
    const biogenicByFacility = new Map<number, number>();
    const gasTotals = new Map<string, number>();
    const perFacilityScopeTotals = new Map<number, { scope1: number; scope2: number; scope3: number }>();

    for (const record of records) {
      if (!record.facilityId) continue;
      const multiplier = facilityMultiplier(record.facilityId);
      const emissionKg = Number(record.emission) * multiplier;
      const emissionTonnes = emissionKg / 1000;

      const scopeKey = record.scope as "scope1" | "scope2" | "scope3";
      if (scopeKey === "scope1" || scopeKey === "scope2" || scopeKey === "scope3") {
        scopeTotals[scopeKey] += emissionTonnes;
        const existing = perFacilityScopeTotals.get(record.facilityId) ?? { scope1: 0, scope2: 0, scope3: 0 };
        existing[scopeKey] += emissionTonnes;
        perFacilityScopeTotals.set(record.facilityId, existing);
      }

      const breakdown = (record.gasBreakdown as { gas: string; co2e: number }[] | null) ?? [];
      for (const component of breakdown) {
        gasTotals.set(component.gas, (gasTotals.get(component.gas) ?? 0) + (component.co2e * multiplier) / 1000);
      }
    }

    const gasTotal = Array.from(gasTotals.values()).reduce((sum, v) => sum + v, 0);
    const gasBreakdown = Array.from(gasTotals.entries()).map(([gas, co2e]) => ({
      gas,
      co2e,
      pctOfTotal: gasTotal > 0 ? (co2e / gasTotal) * 100 : 0,
    }));

    const facilitySourceStreams = await db
      .select({ facilityId: sourceStreams.facilityId })
      .from(sourceStreams)
      .where(and(eq(sourceStreams.organizationId, organizationId), eq(sourceStreams.reportingBoundaryId, reportingBoundaryId)));
    const facilitiesWithStreams = new Set(facilitySourceStreams.map((s) => s.facilityId));

    const facilitiesOut = entityFacilities.map((f) => {
      const totals = perFacilityScopeTotals.get(f.id) ?? { scope1: 0, scope2: 0, scope3: 0 };
      return {
        id: f.id,
        name: f.name,
        country: f.country,
        equityShareOwnershipPercent: f.equityShareOwnershipPercent ? Number(f.equityShareOwnershipPercent) : null,
        incomplete: !facilitiesWithStreams.has(f.id),
        ...totals,
      };
    });

    const totalTco2e = scopeTotals.scope1 + scopeTotals.scope2 + scopeTotals.scope3;

    const facilityProductRows = await db
      .select()
      .from(facilityProducts)
      .where(
        and(
          eq(facilityProducts.organizationId, organizationId),
          inArray(
            facilityProducts.facilityId,
            entityFacilities.map((f) => f.id),
          ),
        ),
      );
    const totalProduction = facilityProductRows.reduce((sum, p) => sum + (p.actualProduction ? Number(p.actualProduction) : 0), 0);

    const intensity = {
      revenuePerTco2e:
        boundary.revenueAmount && totalTco2e > 0 ? Number(boundary.revenueAmount) / totalTco2e : null,
      fteEmployeesPerTco2e:
        boundary.fullTimeEquivalentEmployees && totalTco2e > 0
          ? Number(boundary.fullTimeEquivalentEmployees) / totalTco2e
          : null,
      productionPerTco2e: totalProduction > 0 && totalTco2e > 0 ? totalProduction / totalTco2e : null,
    };

    // Explicit gas-coverage disclosure (Section 2b) -- states which of the
    // 7 Kyoto gases are backed by real data in THIS period's records versus
    // not yet covered by this system at all, rather than silently omitting
    // gases with no data.
    const allKyotoGases = ["CO2", "CH4", "N2O", "HFCs", "PFCs", "SF6", "NF3"];
    const gasCoverage = allKyotoGases.map((gas) => ({ gas, covered: gasTotals.has(gas) }));

    let baseYearComparison: ConsolidatedReport["baseYearComparison"] = null;
    if (entity.baseYear && entity.baseYear !== boundary.reportingYear) {
      const baseYearBoundaries = await db
        .select()
        .from(reportingBoundaries)
        .where(
          and(
            eq(reportingBoundaries.organizationId, organizationId),
            eq(reportingBoundaries.reportingEntityId, entity.id),
            eq(reportingBoundaries.reportingYear, entity.baseYear),
          ),
        );
      if (baseYearBoundaries[0]) {
        const baseYearReport = await this.getConsolidatedReport(organizationId, baseYearBoundaries[0].id);
        const baseYearTotal = baseYearReport
          ? baseYearReport.totals.scope1 + baseYearReport.totals.scope2 + baseYearReport.totals.scope3
          : null;
        baseYearComparison = {
          baseYearTotal,
          currentYearTotal: totalTco2e,
          changePercent: baseYearTotal && baseYearTotal > 0 ? ((totalTco2e - baseYearTotal) / baseYearTotal) * 100 : null,
        };
      }
    }

    const [dqRecords, findings, qaRecords] = await Promise.all([
      db
        .select()
        .from(dataQualityRecords)
        .where(
          and(
            eq(dataQualityRecords.organizationId, organizationId),
            inArray(
              dataQualityRecords.sourceStreamId,
              (await db.select({ id: sourceStreams.id }).from(sourceStreams).where(eq(sourceStreams.reportingBoundaryId, reportingBoundaryId))).map(
                (s) => s.id,
              ),
            ),
          ),
        ),
      db
        .select()
        .from(verificationFindings)
        .where(and(eq(verificationFindings.organizationId, organizationId), eq(verificationFindings.reportingBoundaryId, reportingBoundaryId))),
      db
        .select()
        .from(managementQaRecords)
        .where(and(eq(managementQaRecords.organizationId, organizationId), eq(managementQaRecords.reportingBoundaryId, reportingBoundaryId))),
    ]);

    return {
      reportingBoundary: {
        id: boundary.id,
        reportingYear: boundary.reportingYear,
        consolidationApproach: boundary.consolidationApproach,
        status: boundary.status,
        finalizedAt: boundary.finalizedAt ? boundary.finalizedAt.toISOString() : null,
      },
      reportingEntity: {
        id: entity.id,
        name: entity.name,
        baseYear: entity.baseYear,
        baseYearRationale: entity.baseYearRationale,
      },
      totals: { ...scopeTotals, biogenicCo2: 0 },
      gasBreakdown,
      facilities: facilitiesOut,
      intensity,
      gasCoverage,
      dataQualityRecords: dqRecords,
      verificationFindings: findings,
      managementQaRecords: qaRecords,
      baseYearComparison,
    };
  }
```

**Note on `biogenicCo2: 0`:** no biogenic-flagged factors are seeded yet (per the design spec's Section 1 note on `isBiogenic`), so there's nothing to sum. When biogenic fuels are added in a future session, this needs a real aggregation step (sum `emission_records` where the gas breakdown's source factor has `isBiogenic = true`, which requires joining back to `ipccDefaultFactors`/`emissionFactorsTable` by name — not possible from `emission_records.gasBreakdown` alone, since that JSON blob doesn't currently carry an `isBiogenic` flag per component). Flagging this as a known follow-up rather than building it against data that doesn't exist yet.

**Note on imports:** this method uses `inArray` from `drizzle-orm` — check the existing import line at the top of `server/storage.ts` (`import { and, desc, eq, sql } from "drizzle-orm";`) and add `inArray` to it. Also import `facilityProducts`, `dataQualityRecords`, `verificationFindings`, `managementQaRecords`, `sourceStreams`, `reportingBoundaries` from `@shared/schema` if any aren't already imported (check the existing import block).

- [ ] **Step 2: Add the route**

In `server/routes.ts`:

```ts
  app.get("/api/reporting-boundaries/:id/consolidated-report", requireAuth, requireOrg, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid reporting boundary id" });
    const report = await storage.getConsolidatedReport(req.organizationId!, id);
    if (!report) return res.status(404).json({ message: "Reporting boundary not found" });
    return res.json({ report });
  });
```

- [ ] **Step 3: Add finalize validation for `equity_share`**

In Plan 2 Task 3's `PATCH /api/reporting-boundaries/:id/finalize` handler, add a check before updating status — a boundary with `consolidationApproach === "equity_share"` cannot finalize if any of its entity's facilities lack `equityShareOwnershipPercent`:

```ts
  app.patch("/api/reporting-boundaries/:id/finalize", requireAuth, requireOrg, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid reporting boundary id" });

    const existing = await storage.getReportingBoundary(req.organizationId!, id);
    if (!existing) return res.status(404).json({ message: "Reporting boundary not found" });

    if (existing.consolidationApproach === "equity_share") {
      const entityFacilities = await storage.listFacilities(req.organizationId!);
      const missingEquity = entityFacilities.filter(
        (f) => f.reportingEntityId === existing.reportingEntityId && f.equityShareOwnershipPercent === null,
      );
      if (missingEquity.length > 0) {
        return res.status(400).json({
          message: `Cannot finalize: equity share consolidation requires an ownership percentage for every facility. Missing for: ${missingEquity.map((f) => f.name).join(", ")}.`,
        });
      }
    }

    const boundary = await storage.updateReportingBoundary(req.organizationId!, id, {
      status: "finalized",
      finalizedAt: new Date(),
    });
    return res.json({ reportingBoundary: boundary });
  });
```

This replaces the simpler version from Plan 2 Task 3 Step 1 — if implementing plans sequentially, edit that handler in place rather than adding a duplicate route.

- [ ] **Step 4: Run the TypeScript compiler**

Run: `npm run check`. Expected: zero errors. This is a large, real aggregation method — expect a few rounds of fixing import/type issues.

- [ ] **Step 5: Manual verification**

Query the endpoint directly against a boundary with at least one facility with calculated source streams (from Plan 2's verification):

```bash
curl -sS -b /tmp/ghg-cookies.txt "http://localhost:5000/api/reporting-boundaries/<id>/consolidated-report"
```

Confirm: `totals.scope1` matches the sum of that facility's `emission_records.emission` (converted to tonnes), `gasBreakdown` shows CO2/CH4/N2O split, `facilities` lists every facility under the entity (including ones with zero source streams, flagged `incomplete: true`), `gasCoverage` shows `CO2`/`CH4`/`N2O` as `covered: true` and the other 4 gases as `false`.

- [ ] **Step 6: Commit**

```bash
git add server/storage.ts server/routes.ts
git commit -m "$(cat <<'EOF'
Add consolidated multi-facility report aggregation endpoint

Section 3 of the verification-ready inventory design: GET
/api/reporting-boundaries/:id/consolidated-report sums every facility
under a reporting entity for a given year, applies the equity-share
percentage when that's the declared consolidation approach, and
returns per-gas, per-facility, intensity, base-year, and
gas-coverage-disclosure data in one response. Also adds equity-share
completeness validation to the finalize endpoint.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The Organization Report UI

**Files:**
- Create: `client/src/components/OrganizationReport.tsx`
- Modify: `client/src/components/AppShell.tsx` (new nav section)

**Interfaces:**
- Consumes: `GET /api/reporting-boundaries/:id/consolidated-report` (Task 1), the existing per-gas breakdown table pattern already in `client/src/components/ResultsView.tsx`.
- Produces: nothing consumed by later tasks — this is the plan set's final user-facing deliverable.

- [ ] **Step 1: Create `OrganizationReport.tsx`**

```tsx
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Input } from "@/components/ui/input";

interface ConsolidatedReport {
  reportingBoundary: { id: number; reportingYear: number; consolidationApproach: string; status: string; finalizedAt: string | null };
  reportingEntity: { id: number; name: string; baseYear: number | null; baseYearRationale: string | null };
  totals: { scope1: number; scope2: number; scope3: number; biogenicCo2: number };
  gasBreakdown: { gas: string; co2e: number; pctOfTotal: number }[];
  facilities: {
    id: number;
    name: string;
    country: string | null;
    equityShareOwnershipPercent: number | null;
    incomplete: boolean;
    scope1: number;
    scope2: number;
    scope3: number;
  }[];
  intensity: { revenuePerTco2e: number | null; fteEmployeesPerTco2e: number | null; productionPerTco2e: number | null };
  gasCoverage: { gas: string; covered: boolean }[];
  baseYearComparison: { baseYearTotal: number | null; currentYearTotal: number; changePercent: number | null } | null;
}

export default function OrganizationReport({ reportingBoundaryId }: { reportingBoundaryId: number }) {
  const queryClient = useQueryClient();
  const query = useQuery<{ report: ConsolidatedReport }>({
    queryKey: [`/api/reporting-boundaries/${reportingBoundaryId}/consolidated-report`],
  });

  if (query.isLoading) return <div className="text-sm text-neutral-500 py-8 text-center">Loading report...</div>;
  if (!query.data) return <div className="text-sm text-neutral-500 py-8 text-center">Report not found.</div>;

  const { report } = query.data;
  const total = report.totals.scope1 + report.totals.scope2 + report.totals.scope3;

  return (
    <div className="space-y-4">
      <Card className="bg-white">
        <CardContent className="pt-6 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-medium">{report.reportingEntity.name} — {report.reportingBoundary.reportingYear}</h3>
            <p className="text-sm text-neutral-500">
              Consolidation: {report.reportingBoundary.consolidationApproach} · Status: {report.reportingBoundary.status}
            </p>
          </div>
          {report.reportingBoundary.status === "draft" ? (
            <Button
              size="sm"
              onClick={async () => {
                await apiRequest("PATCH", `/api/reporting-boundaries/${reportingBoundaryId}/finalize`, {});
                queryClient.invalidateQueries({ queryKey: [`/api/reporting-boundaries/${reportingBoundaryId}/consolidated-report`] });
              }}
            >
              Finalize report
            </Button>
          ) : (
            <span className="text-xs text-green-700 bg-green-50 border border-green-200 rounded px-2 py-1">
              Finalized {report.reportingBoundary.finalizedAt ? new Date(report.reportingBoundary.finalizedAt).toLocaleDateString() : ""}
            </span>
          )}
        </CardContent>
      </Card>

      <Card className="bg-amber-50 border-amber-200">
        <CardContent className="pt-4 pb-4 text-sm text-amber-800">
          <strong>GHG coverage:</strong>{" "}
          {report.gasCoverage
            .map((g) => `${g.gas}${g.covered ? "" : " (not yet covered by this system)"}`)
            .join(", ")}
          . This report covers Stationary Combustion only as of this build — other Scope 1/2/3 categories are not yet
          calculated.
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <SummaryCard label="Scope 1" value={report.totals.scope1} />
        <SummaryCard label="Scope 2" value={report.totals.scope2} />
        <SummaryCard label="Scope 3" value={report.totals.scope3} />
        <SummaryCard label="Total" value={total} highlight />
      </div>

      <Card className="bg-white">
        <CardContent className="pt-6">
          <h4 className="text-sm font-medium mb-3">Emissions by gas</h4>
          <table className="min-w-full divide-y divide-neutral-200 text-sm">
            <thead>
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-neutral-500 uppercase">Gas</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-neutral-500 uppercase">tCO2e</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-neutral-500 uppercase">% of total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200">
              {report.gasBreakdown.map((g) => (
                <tr key={g.gas}>
                  <td className="px-3 py-2">{g.gas}</td>
                  <td className="px-3 py-2">{g.co2e.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                  <td className="px-3 py-2">{g.pctOfTotal.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card className="bg-white">
        <CardContent className="pt-6">
          <h4 className="text-sm font-medium mb-3">By facility</h4>
          <table className="min-w-full divide-y divide-neutral-200 text-sm">
            <thead>
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-neutral-500 uppercase">Facility</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-neutral-500 uppercase">Country</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-neutral-500 uppercase">Equity %</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-neutral-500 uppercase">Scope 1</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-neutral-500 uppercase">Scope 2</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-neutral-500 uppercase">Scope 3</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200">
              {report.facilities.map((f) => (
                <tr key={f.id} className={f.incomplete ? "bg-amber-50" : ""}>
                  <td className="px-3 py-2">
                    {f.name}
                    {f.incomplete && <span className="ml-2 text-xs text-amber-700">No activity data yet</span>}
                  </td>
                  <td className="px-3 py-2">{f.country ?? "-"}</td>
                  <td className="px-3 py-2">{f.equityShareOwnershipPercent ?? "-"}</td>
                  <td className="px-3 py-2">{f.scope1.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                  <td className="px-3 py-2">{f.scope2.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                  <td className="px-3 py-2">{f.scope3.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {report.baseYearComparison && (
        <Card className="bg-white">
          <CardContent className="pt-6 text-sm">
            <h4 className="text-sm font-medium mb-2">Base year comparison ({report.reportingEntity.baseYear})</h4>
            <p className="text-neutral-600">{report.reportingEntity.baseYearRationale}</p>
            <p className="mt-2">
              Base year: {report.baseYearComparison.baseYearTotal?.toLocaleString(undefined, { maximumFractionDigits: 2 }) ?? "n/a"} tCO2e ·
              Current: {report.baseYearComparison.currentYearTotal.toLocaleString(undefined, { maximumFractionDigits: 2 })} tCO2e ·
              Change: {report.baseYearComparison.changePercent !== null ? `${report.baseYearComparison.changePercent.toFixed(1)}%` : "n/a"}
            </p>
          </CardContent>
        </Card>
      )}

      {(report.intensity.revenuePerTco2e || report.intensity.fteEmployeesPerTco2e || report.intensity.productionPerTco2e) && (
        <Card className="bg-white">
          <CardContent className="pt-6 text-sm space-y-1">
            <h4 className="text-sm font-medium mb-2">Intensity</h4>
            {report.intensity.revenuePerTco2e && <p>Revenue per tCO2e: {report.intensity.revenuePerTco2e.toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>}
            {report.intensity.fteEmployeesPerTco2e && <p>FTE employees per tCO2e: {report.intensity.fteEmployeesPerTco2e.toFixed(3)}</p>}
            {report.intensity.productionPerTco2e && <p>Production units per tCO2e: {report.intensity.productionPerTco2e.toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function SummaryCard({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <Card className={highlight ? "bg-primary-50 border-primary-200" : "bg-white"}>
      <CardContent className="pt-6">
        <div className="text-xs text-neutral-500 uppercase">{label}</div>
        <div className="text-2xl font-bold">{value.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
        <div className="text-xs text-neutral-400">tCO2e</div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Wire into `AppShell.tsx`**

Add `"report"` to the `Section` type (line 29) and a nav item:

```ts
type Section = "setup" | "facilities" | "boundary" | "report" | "team";
```

```ts
  { key: "report", label: "Organization Report", description: "The consolidated, auditable emissions report across every facility for a reporting year." },
```

(Removing `"calculator"` here is Plan 4's job, not this task's — leave it in place for now if Plan 4 hasn't run yet.)

Add a section body. Since the report needs a `reportingBoundaryId`, add a simple boundary selector (reusing the existing `reportingBoundariesQuery` pattern already used elsewhere in this file):

```tsx
        {section === "report" && <OrganizationReportSection />}
```

```tsx
function OrganizationReportSection() {
  const boundariesQuery = useQuery<{ reportingBoundaries: ReportingBoundary[] }>({ queryKey: ["/api/reporting-boundaries"] });
  const boundaries = boundariesQuery.data?.reportingBoundaries ?? [];
  const [selectedId, setSelectedId] = useState<number | null>(null);

  if (boundariesQuery.isLoading) return <div className="text-sm text-neutral-500 py-8 text-center">Loading...</div>;
  if (boundaries.length === 0) {
    return <p className="text-sm text-neutral-500">No reporting boundaries yet. Create one in Boundary Workspace first.</p>;
  }

  const activeId = selectedId ?? boundaries[0].id;

  return (
    <div className="space-y-4">
      <select
        className="border rounded-md px-3 py-2 text-sm"
        value={activeId}
        onChange={(e) => setSelectedId(Number(e.target.value))}
      >
        {boundaries.map((b) => (
          <option key={b.id} value={b.id}>
            Reporting year {b.reportingYear} ({b.consolidationApproach})
          </option>
        ))}
      </select>
      <OrganizationReport reportingBoundaryId={activeId} />
    </div>
  );
}
```

Add `import OrganizationReport from "@/components/OrganizationReport";` at the top of `AppShell.tsx`.

- [ ] **Step 3: Run the TypeScript compiler**

Run: `npm run check`. Expected: zero errors.

- [ ] **Step 4: Manual verification**

Navigate to the new "Organization Report" nav item. Confirm: the boundary selector shows the reporting years created earlier, the report loads with correct scope totals, the gas-coverage banner is visible, facility rows show correctly (including the "No activity data yet" flag on any facility with zero source streams), the Finalize button works and flips the header to the finalized badge.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/OrganizationReport.tsx client/src/components/AppShell.tsx
git commit -m "$(cat <<'EOF'
Add Organization Report -- the consolidated auditable global data sheet

Section 3: closes the gap where AppShell had no view summing multiple
facilities into one organizational total. Shows per-gas breakdown,
per-facility detail (including incomplete facilities, never silently
dropped), base-year comparison, intensity ratios, and an explicit
gas-coverage disclosure.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

### Task 3: Render verification findings, QA procedure, and CSV export

**Files:**
- Modify: `client/src/components/OrganizationReport.tsx`
- Modify: `server/routes.ts` (CSV export route)
- Modify: `server/utils/csv.ts` (check the existing `generateCSV` helper's signature before adding a new call site)

**Interfaces:**
- Consumes: `report.verificationFindings`/`report.managementQaRecords` (already returned by Task 1's endpoint, just not rendered yet); the existing `generateCSV` utility already used by `ResultsView.tsx`'s CSV export.

- [ ] **Step 1: Add findings + QA cards to `OrganizationReport.tsx`**

Add after the intensity card:

```tsx
      {report.verificationFindings.length > 0 && (
        <Card className="bg-white">
          <CardContent className="pt-6">
            <h4 className="text-sm font-medium mb-3">Verification findings</h4>
            <ul className="space-y-2 text-sm">
              {report.verificationFindings.map((f: { id: number; findingType: string; description: string; severity: string | null; status: string }) => (
                <li key={f.id} className="border-b border-neutral-100 pb-2">
                  <span className="font-medium">{f.findingType}</span>{f.severity ? ` (${f.severity})` : ""} — {f.description}{" "}
                  <span className="text-xs text-neutral-400">[{f.status}]</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {report.managementQaRecords.length > 0 && (
        <Card className="bg-white">
          <CardContent className="pt-6 text-sm">
            <h4 className="text-sm font-medium mb-2">Management QA procedure</h4>
            {report.managementQaRecords.map((q: { id: number; qaProcedureDescription: string | null; responsiblePerson: string | null; reviewFrequency: string | null }) => (
              <p key={q.id} className="text-neutral-600">
                {q.qaProcedureDescription} {q.responsiblePerson ? `— reviewed by ${q.responsiblePerson}` : ""}{" "}
                {q.reviewFrequency ? `(${q.reviewFrequency})` : ""}
              </p>
            ))}
          </CardContent>
        </Card>
      )}
```

Widen the `ConsolidatedReport` TypeScript interface at the top of the file: replace `verificationFindings: unknown[]` / `managementQaRecords: unknown[]` (if written that loosely) with the concrete shapes used above.

- [ ] **Step 2: Add the CSV export route**

Check `server/utils/csv.ts`'s `generateCSV` export first (`grep -n "export function generateCSV" server/utils/csv.ts`) to confirm its parameter shape before calling it. Add a route in `server/routes.ts`:

```ts
  app.get("/api/reporting-boundaries/:id/consolidated-report/export.csv", requireAuth, requireOrg, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid reporting boundary id" });
    const report = await storage.getConsolidatedReport(req.organizationId!, id);
    if (!report) return res.status(404).json({ message: "Reporting boundary not found" });

    const rows = report.facilities.map((f) => ({
      facility: f.name,
      country: f.country ?? "",
      equityPercent: f.equityShareOwnershipPercent ?? "",
      scope1: f.scope1,
      scope2: f.scope2,
      scope3: f.scope3,
    }));
    const csv = generateCSV(rows);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${report.reportingEntity.name}-${report.reportingBoundary.reportingYear}.csv"`);
    return res.send(csv);
  });
```

Adjust the `generateCSV(rows)` call to match whatever its actual signature turns out to be (Step 2's grep) — this project's existing `ResultsView.tsx` download flow is the reference implementation; match its request/response shape (likely `POST /api/download-csv` with a body, based on `ResultsView.tsx`'s `downloadCsvMutation`) if a GET-with-query-string approach doesn't fit the existing `generateCSV` helper cleanly.

- [ ] **Step 3: Add the export button to the UI**

In `OrganizationReport.tsx`'s header card, add:

```tsx
<Button
  size="sm"
  variant="outline"
  onClick={() => window.open(`/api/reporting-boundaries/${reportingBoundaryId}/consolidated-report/export.csv`, "_blank")}
>
  Export CSV
</Button>
```

- [ ] **Step 4: Run the TypeScript compiler and verify manually**

Run `npm run check`. Then click Export CSV in the browser and confirm a correctly-named file downloads with the right facility rows.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/OrganizationReport.tsx server/routes.ts
git commit -m "$(cat <<'EOF'
Render verification findings/QA and add CSV export to Organization Report

Closes the gap flagged in this plan's own self-review -- the
consolidated report endpoint already returned verificationFindings/
managementQaRecords, they just weren't shown, and there was no export.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

## Self-Review

**Spec coverage:** every element of the design spec's Section 3 UI list is present across Task 2 and Task 3 (header/status/finalize, gas-coverage banner, scope summary cards, per-gas table, per-facility table with incomplete-flagging, base-year comparison, intensity ratios, verification findings, QA procedure, CSV export).

**Placeholder scan:** no TBD/TODO; the biogenic-CO2 `0` is explicitly explained as scoped-out with a stated reason (no biogenic data exists yet), not silently absent. Task 3 Step 2's CSV route explicitly says to verify `generateCSV`'s real signature before use rather than guessing it.

**Type consistency:** `ConsolidatedReport` interface is duplicated identically between `server/storage.ts` (Task 1) and `client/src/components/OrganizationReport.tsx` (Task 2) — verify field names match exactly if either is edited later.
