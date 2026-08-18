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
