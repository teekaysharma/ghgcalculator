import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

// Mirrors server/modules.ts's MODULE_REGISTRY labels for display purposes
// only. If a second real module is ever added there, add its label here
// too -- this project's existing convention already duplicates small
// shared shapes between client/server (see GasComponent in
// shared/schema.ts vs client/src/types/emissions.ts) rather than sharing
// server-only files with the client bundle.
const MODULE_LABELS: Record<string, string> = {
  standard: "Standard (GHG Protocol / ISO 14064-1)",
};

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
    missingEquityShare: boolean;
    scope1: number;
    scope2: number;
    scope3: number;
  }[];
  intensity: {
    tco2ePerRevenue: number | null;
    tco2ePerFte: number | null;
    tco2ePerProductionUnit: number | null;
    revenueCurrency: string | null;
  };
  gasCoverage: { gas: string; covered: boolean }[];
  dataQualityRecords: {
    id: number;
    sourceStreamId: number;
    sourceStreamName: string | null;
    dataQualityTier: string | null;
    uncertaintyPercent: string | null;
    uncertaintyJustification: string | null;
    usedIpccDefaultFactor: boolean | null;
    ipccDefaultSubstitutionReason: string | null;
  }[];
  verificationFindings: { id: number; findingType: string; description: string; severity: string | null; status: string }[];
  managementQaRecords: { id: number; qaProcedureDescription: string | null; responsiblePerson: string | null; reviewFrequency: string | null }[];
  baseYearComparison: { baseYearTotal: number | null; currentYearTotal: number; changePercent: number | null } | null;
}

export default function OrganizationReport({ reportingBoundaryId }: { reportingBoundaryId: number }) {
  const queryClient = useQueryClient();
  const query = useQuery<{ report: ConsolidatedReport }>({
    queryKey: [`/api/reporting-boundaries/${reportingBoundaryId}/consolidated-report`],
  });
  const { organizations } = useAuth();

  const [reportView, setReportView] = useState("standard");

  // Every org has at least "standard" (always enabled, no row needed in
  // organization_modules). With only one entitled key, there's nothing to
  // choose between yet, so the selector stays hidden rather than showing a
  // single-option dropdown to every customer until a real second module
  // exists.
  const enabledModules = organizations[0]?.enabledModules ?? ["standard"];
  // Reconcile against enabledModules in case a previously-selected module
  // was revoked while it was the active view -- not consumed anywhere yet
  // (no second renderer exists), but kept correct for when one does.
  const activeView = enabledModules.includes(reportView) ? reportView : "standard";

  if (query.isLoading) return <div className="text-sm text-neutral-500 py-8 text-center">Loading report...</div>;
  if (!query.data) return <div className="text-sm text-neutral-500 py-8 text-center">Report not found.</div>;

  const { report } = query.data;
  const total = report.totals.scope1 + report.totals.scope2 + report.totals.scope3;

  return (
    <div className="space-y-4">
      {enabledModules.length > 1 && (
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-neutral-600">Report view</label>
          <select
            className="border rounded-md px-2 py-1 text-sm"
            value={reportView}
            onChange={(e) => setReportView(e.target.value)}
          >
            {enabledModules.map((key) => (
              <option key={key} value={key}>
                {MODULE_LABELS[key] ?? key}
              </option>
            ))}
          </select>
        </div>
      )}
      <Card className="bg-white">
        <CardContent className="pt-6 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-medium">{report.reportingEntity.name} — {report.reportingBoundary.reportingYear}</h3>
            <p className="text-sm text-neutral-500">
              Consolidation: {report.reportingBoundary.consolidationApproach} · Status: {report.reportingBoundary.status}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => window.open(`/api/reporting-boundaries/${reportingBoundaryId}/consolidated-report/export.csv`, "_blank")}
            >
              Export CSV
            </Button>
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
                    const { omittedSourceStreams, omittedMeasurementStreams, omittedMitigationMeasures } = await res.json();
                    const omissions: string[] = [];
                    if (omittedSourceStreams > 0) omissions.push(`${omittedSourceStreams} calculation-tier source stream(s)`);
                    if (omittedMeasurementStreams > 0) omissions.push(`${omittedMeasurementStreams} measurement-tier source stream(s)`);
                    if (omittedMitigationMeasures > 0) omissions.push(`${omittedMitigationMeasures} mitigation measure(s)`);
                    if (omissions.length > 0) {
                      const proceed = window.confirm(
                        `${omissions.join(" and ")} exceed the EAD template's row limits and will not be included in this file — see the ISO 14064-3 workbook for the complete data. Continue anyway?`,
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
          </div>
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

      {/* GRI 305-1 / GHG Protocol: CO2 from biomass combustion is reported
          separately from gross Scope 1/2/3, not inside it. Shown
          unconditionally (including at 0.00) rather than hidden when empty --
          "no biogenic CO2 in this inventory" is itself a disclosure a
          verifier looks for, and a silently absent line is indistinguishable
          from a line that was never computed. The CH4/N2O caveat is spelled
          out because it is the part readers most often get wrong. */}
      <Card className="bg-white border-neutral-200">
        <CardContent className="pt-4 pb-4 flex items-baseline justify-between gap-4">
          <div className="text-sm">
            <span className="font-medium">Biogenic CO2</span>{" "}
            <span className="text-neutral-500">
              — memo item, excluded from gross Scope 1/2/3 above. Biogenic CH4 and N2O are NOT excluded; they remain in the
              scope totals.
            </span>
          </div>
          <div className="text-lg font-semibold whitespace-nowrap">
            {report.totals.biogenicCo2.toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
            <span className="text-xs font-normal text-neutral-400">tCO2</span>
          </div>
        </CardContent>
      </Card>

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
                <tr key={f.id} className={f.incomplete || f.missingEquityShare ? "bg-amber-50" : ""}>
                  <td className="px-3 py-2">
                    {f.name}
                    {f.incomplete && <span className="ml-2 text-xs text-amber-700">No activity data yet</span>}
                    {/* Distinct from "no activity data": this facility may
                        have real activity data, but under equity-share
                        consolidation a missing ownership % makes its
                        multiplier 0, so it contributes nothing to the
                        totals. An unexplained 0.00 is a completeness
                        finding in its own right, so say why. */}
                    {f.missingEquityShare && (
                      <span className="ml-2 text-xs text-amber-700">Equity share % not set — excluded from totals</span>
                    )}
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

      {/* GRI 305-4 / IFRS S2 GHG intensity: emissions per unit of the
          organization-specific denominator. Null checks are explicit rather
          than truthiness checks because 0 is a legitimate intensity (a
          zero-emissions inventory) that must still be disclosed. */}
      {(report.intensity.tco2ePerRevenue !== null ||
        report.intensity.tco2ePerFte !== null ||
        report.intensity.tco2ePerProductionUnit !== null) && (
        <Card className="bg-white">
          <CardContent className="pt-6 text-sm space-y-1">
            <h4 className="text-sm font-medium mb-2">GHG intensity (GRI 305-4 / IFRS S2)</h4>
            {report.intensity.tco2ePerRevenue !== null && (
              <p>
                tCO2e per {report.intensity.revenueCurrency ?? "unit"} of revenue:{" "}
                {report.intensity.tco2ePerRevenue.toLocaleString(undefined, { maximumSignificantDigits: 4 })}
              </p>
            )}
            {report.intensity.tco2ePerFte !== null && (
              <p>tCO2e per FTE employee: {report.intensity.tco2ePerFte.toLocaleString(undefined, { maximumFractionDigits: 3 })}</p>
            )}
            {report.intensity.tco2ePerProductionUnit !== null && (
              <p>
                tCO2e per unit of production:{" "}
                {report.intensity.tco2ePerProductionUnit.toLocaleString(undefined, { maximumSignificantDigits: 4 })}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Data quality / uncertainty summary. ISO 14064-3 6.1.3.6.3 expects a
          verifier to see the stated uncertainty and its justification per
          source, and the design spec calls for it in this report -- the data
          was already being returned by getConsolidatedReport but never
          rendered anywhere. */}
      {report.dataQualityRecords.length > 0 && (
        <Card className="bg-white">
          <CardContent className="pt-6">
            <h4 className="text-sm font-medium mb-3">Data quality and uncertainty</h4>
            <table className="min-w-full divide-y divide-neutral-200 text-sm">
              <thead>
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-neutral-500 uppercase">Source stream</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-neutral-500 uppercase">Tier</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-neutral-500 uppercase">Uncertainty</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-neutral-500 uppercase">Justification</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-neutral-500 uppercase">IPCC default</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-200">
                {report.dataQualityRecords.map((d) => (
                  <tr key={d.id}>
                    <td className="px-3 py-2">{d.sourceStreamName ?? `#${d.sourceStreamId}`}</td>
                    <td className="px-3 py-2">{d.dataQualityTier ?? "-"}</td>
                    <td className="px-3 py-2">{d.uncertaintyPercent !== null ? `±${d.uncertaintyPercent}%` : "-"}</td>
                    <td className="px-3 py-2 text-neutral-600">{d.uncertaintyJustification ?? "-"}</td>
                    <td className="px-3 py-2">
                      {d.usedIpccDefaultFactor ? (
                        <span className="text-amber-700">
                          Yes{d.ipccDefaultSubstitutionReason ? ` — ${d.ipccDefaultSubstitutionReason}` : ""}
                        </span>
                      ) : (
                        "No"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {report.verificationFindings.length > 0 && (
        <Card className="bg-white">
          <CardContent className="pt-6">
            <h4 className="text-sm font-medium mb-3">Verification findings</h4>
            <ul className="space-y-2 text-sm">
              {report.verificationFindings.map((f) => (
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
            {report.managementQaRecords.map((q) => (
              <p key={q.id} className="text-neutral-600">
                {q.qaProcedureDescription} {q.responsiblePerson ? `— reviewed by ${q.responsiblePerson}` : ""}{" "}
                {q.reviewFrequency ? `(${q.reviewFrequency})` : ""}
              </p>
            ))}
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
