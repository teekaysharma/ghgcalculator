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
