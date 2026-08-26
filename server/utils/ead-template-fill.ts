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
import { fileURLToPath } from "url";
import fs from "fs";
import type { SourceStreamDetail } from "../storage";
import type { MethaneReport, MitigationMeasure, ManagementQaRecord } from "@shared/schema";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// TEMPLATE_PATH must resolve correctly under both `npm run dev` (tsx runs
// this file directly from server/utils/, so __dirname = server/utils/ and
// "../assets" reaches server/assets/) and the production build (esbuild
// bundles this whole module into dist/index.js, so __dirname = dist/ at
// runtime -- server/vite.ts:69 already establishes this exact fact for
// dist/public). Since the two environments have different directory
// depths relative to the repo root, a single relative path cannot work in
// both -- try the dev-relative location first, then the prod-relative one
// (populated by the build's `cp server/assets dist/assets` step added
// alongside this fix), and fail loudly and specifically if neither exists,
// matching the existing convention at server/vite.ts:69-75 rather than
// letting a bare ENOENT reach the client (see Task 9's I7 fix for the
// route-level catch that turns this into a clean 500 either way).
function resolveTemplatePath(): string {
  const devPath = path.join(__dirname, "..", "assets", "ead-deliverable-c-template.xlsx");
  if (fs.existsSync(devPath)) return devPath;
  const prodPath = path.join(__dirname, "assets", "ead-deliverable-c-template.xlsx");
  if (fs.existsSync(prodPath)) return prodPath;
  throw new Error(
    `Could not find the EAD template at ${devPath} or ${prodPath}. In production, make sure the build step copies server/assets/ into dist/assets/ (see package.json's "build" script).`,
  );
}

// Cached across calls -- the template is a static 400KB+ asset read from
// disk and re-parsed by XLSX.read on every single export request otherwise
// (measured: ~40-110ms of fully synchronous, event-loop-blocking work per
// call just for the parse). Caching the raw BUFFER (not the parsed
// workbook -- the fill functions mutate their workbook in place, so a
// cached parsed workbook would leak state between requests) still avoids
// the disk read and lets XLSX.read do a fresh parse into an isolated
// object per call.
let cachedTemplateBuffer: Buffer | null = null;

export function loadEadTemplate(): XLSX.WorkBook {
  if (!cachedTemplateBuffer) {
    cachedTemplateBuffer = fs.readFileSync(resolveTemplatePath());
  }
  // cellFormula: true preserves existing formulas on read so
  // clearIllustrativeRows/the fill functions can detect and skip them.
  return XLSX.read(cachedTemplateBuffer, { cellFormula: true });
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

// The schema stores materiality as lowercase ("major"/"minor" -- see
// shared/schema.ts's materialityLevels), but the real template's own
// illustrative example casing is Title Case ("Major") -- confirmed by
// direct inspection of 3d1_Source Streams (Calculated)!F10/G10/D41 --
// even though the row-8 instructional text itself reads lowercase
// ("classify your source stream (into major, minor, de minimis)").
// Title-case every write so the exported value matches the template's
// own convention rather than the schema's raw storage casing.
function titleCaseMateriality(value: string | null | undefined): string {
  if (!value) return "";
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

export function clearIllustrativeRows(wb: XLSX.WorkBook): void {
  for (const [sheetName, address] of ILLUSTRATIVE_CELLS) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const cell = ws[address];
    if (cell && cell.f) {
      // Never touch the formula itself -- but the formula's stale cached
      // result (computed once, when the template was authored, against
      // its own fabricated example data) must not ship in the delivered
      // file. Stripping .v/.w/.h leaves a formula cell with no cached
      // value; Excel recalculates a cell with a formula and no cached
      // value on open. Also see the module-level fullCalcOnLoad note in
      // the two export routes (server/routes.ts) for the belt-and-
      // suspenders fix for non-Excel consumers that don't force a recalc.
      delete cell.v;
      delete cell.w;
      delete cell.h;
      continue;
    }
    delete ws[address];
  }
}

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
    writeIfNotFormula(streamSheet, `F${row1}`, { t: "s", v: titleCaseMateriality(s.materiality) });
    writeIfNotFormula(streamSheet, `G${row1}`, { t: "s", v: titleCaseMateriality(s.materiality) });

    // Second table: Tier level, Category, Uncertainty, Fuel stream type,
    // Source of accuracy. Column B is again formula-linked, not written.
    writeIfNotFormula(streamSheet, `C${row2}`, { t: "s", v: calc?.activityDataTier ?? "" });
    writeIfNotFormula(streamSheet, `D${row2}`, { t: "s", v: titleCaseMateriality(s.materiality) });
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

// Task 6: remaining sheets (Emission Sources, Measurement/Fallback
// narratives, Methane, Management & QA, Mitigation Measures). Best-effort
// layer -- see the module-level comment above ILLUSTRATIVE_CELLS for the
// Product -> Emission Source -> Source Stream hierarchy gap this
// approximates (one measurement-tier source stream = one Emission Source
// row, 1:1, rather than EAD's richer many-source-streams-per-source
// grouping).
//
// Every address below was independently re-verified against the real
// template file (`XLSX.readFile(..., { cellFormula: true })`, direct cell
// reads plus `ws["!merges"]` inspection) before use, per the same
// discipline Task 4/5 required after the blankrows-derivation bug. Two
// real, verified defects were found and corrected here relative to the
// task brief as originally drafted (not just re-confirmed, actually
// wrong):
//   1. "4I - Management & QA": the brief's B7/E7 (record 0) and D17/D23/
//      D28/D33 (records 1/2) all target either a blank margin column (B,
//      outside every merge -- verified via ws["!merges"]) or the *label*
//      half of a merged label/value pair (e.g. C17:D17 is one merged
//      "Title of procedure" label cell; the value lives in the separate
//      E17:L17 merge, anchored at E17 -- confirmed by reading E17 back and
//      finding the template's own real value "ETS QA/QC of MI" there, not
//      at D17). Writing to the brief's original addresses would produce
//      cells that are either genuinely blank in the rendered sheet or
//      silently swallowed inside a merge Excel doesn't display (only a
//      merge's top-left anchor cell renders). Corrected to the verified
//      anchor cells: C7/F7, E17/E23, E28/E33.
//   2. "4J - Mitigation Measures": the brief's G/I column assignment
//      doesn't match the sheet's own row-5 header ("Start year" is G,
//      "Status" is H; "Pre-measure reference (tCO2e/yr)" is I, "Reporting
//      year reduction (tCO2e)" is J) -- confirmed by reading row 5 across
//      all columns. Corrected `status` to H and `estimatedReductionTco2e`
//      to J. The brief also capped the fill loop at 20 rows on the
//      reasoning that "no explicit limit was observed in B1:P28" -- that
//      reasoning doesn't hold: row 15 of the same sheet is the start of a
//      *different* narrative sub-section ("J1: Additional information",
//      confirmed by reading C15/C16 and by the C17:L25 merged blank
//      answer cell that follows it), not more measure rows. The real,
//      verified capacity for one-row-per-measure data is rows 7-14 (8
//      rows) before that sub-section begins; capped accordingly below
//      instead of 20 to avoid writing measure data into the "Additional
//      information" section's cells.
// Everything else below (3e1's row numbers/columns, and 3e2/3f/3g/4I's
// row-17/23/28/33 placement, and the semantic field-to-column choices
// throughout) matched the brief exactly on verification and is used
// as-is. 3e2/3f/3g are narrative sections with no labeled data row to
// verify against -- per the task's explicit instruction this is a
// disclosed approximation, not something to "fix": their target cells are
// used verbatim from the brief.
const MITIGATION_MEASURE_ROW_CAPACITY = 8;

export function fillRemainingSheets(
  wb: XLSX.WorkBook,
  streamDetails: SourceStreamDetail[],
  methaneReports: MethaneReport[],
  mitigationMeasures: MitigationMeasure[],
  managementQaRecords: ManagementQaRecord[],
): void {
  // 3e1_Emission Sources (Measured): best-effort, one row per
  // measurement-tier source stream (see module comment above for why this
  // is an approximation, not an exact hierarchy match). Table 1 header row
  // 8, S01 example row 9 -> data rows 9-33 (25-row capacity, verified: row
  // 33 is the last S25 row, row 35 starts table 2's own instructional
  // text). Table 2 header row 39, S01 example row 40 -> data rows 40-64
  // (row 64 is the last S25 row, row 67 is "* End of this worksheet *").
  const measurementStreams = streamDetails.filter((s) => s.approachTier === "measurement").slice(0, 25);
  const emissionSourceSheet = wb.Sheets["3e1_Emission Sources (Measured)"];
  if (emissionSourceSheet) {
    measurementStreams.forEach((s, i) => {
      const row1 = 9 + i;
      const row2 = 40 + i;
      writeIfNotFormula(emissionSourceSheet, `D${row1}`, { t: "n", v: s.measurementApproach?.annualMeasuredQuantity ?? 0 });
      writeIfNotFormula(emissionSourceSheet, `E${row1}`, { t: "s", v: titleCaseMateriality(s.materiality) });
      writeIfNotFormula(emissionSourceSheet, `D${row2}`, { t: "s", v: titleCaseMateriality(s.materiality) });
      writeIfNotFormula(emissionSourceSheet, `F${row2}`, { t: "s", v: s.measurementApproach?.measurementMethod ?? "" });
      writeIfNotFormula(emissionSourceSheet, `G${row2}`, { t: "s", v: s.measurementApproach?.qaqcProcedure ?? "" });
    });
  }

  // 3e2_MeasurementBasedApproaches -- a narrative section, not a labeled
  // table, so unlike the tabular sheets above there is no unambiguous "row
  // N is the data row" marker to verify against. (a) description
  // instructional text sits at row 5-6; the response goes directly below
  // it. This mapping stays approximate by nature of the sheet's own
  // design, disclosed as such rather than presented as precise (per task
  // instruction, used verbatim from the brief -- not "fixed").
  const measureSheet = wb.Sheets["3e2_MeasurementBasedApproaches"];
  if (measureSheet && measurementStreams.length > 0) {
    const first = measurementStreams[0].measurementApproach;
    writeIfNotFormula(measureSheet, "C6", { t: "s", v: first?.measurementMethod ?? "" });
    writeIfNotFormula(measureSheet, "C8", { t: "s", v: first?.monitoringFrequency ?? "" });
  }

  // 3f_Fallback Approach -- one description per workbook (the template has
  // no per-source-stream fallback table, just one narrative section). (a)
  // description instruction at row 7-8; (b) justification instruction at
  // row 19-20. Same narrative-section caveat as above.
  const fallbackStreams = streamDetails.filter((s) => s.approachTier === "fallback");
  const fallbackSheet = wb.Sheets["3f_Fallback Approach"];
  if (fallbackSheet && fallbackStreams.length > 0) {
    writeIfNotFormula(fallbackSheet, "C8", { t: "s", v: fallbackStreams[0].fallbackApproach?.fallbackMethodDescription ?? "" });
    writeIfNotFormula(fallbackSheet, "C20", { t: "s", v: fallbackStreams[0].fallbackApproach?.justification ?? "" });
  }

  // 3g_Methane -- facility-wide, per the schema comment on methaneReports
  // ("EAD treats this as its own sheet, facility-wide rather than per
  // source stream"). Uses the first report if more than one facility has
  // one, since the template's Methane sheet is a single narrative section,
  // not a per-facility table. (a) block spans rows 7-11, (b) block rows
  // 12-14 -- another narrative section, approximate by nature.
  const methaneSheet = wb.Sheets["3g_Methane"];
  if (methaneSheet && methaneReports.length > 0) {
    const m = methaneReports[0];
    writeIfNotFormula(methaneSheet, "C9", { t: "n", v: m.annualMethaneEmissions ? Number(m.annualMethaneEmissions) : 0 });
    writeIfNotFormula(methaneSheet, "C10", { t: "s", v: m.quantificationMethod ?? "" });
    writeIfNotFormula(methaneSheet, "C13", { t: "s", v: m.methaneSourcesDescription ?? "" });
  }

  // 4I - Management & QA -- the template wants three distinct narrative
  // sections (monitoring responsibility, QA procedure, data validation
  // procedure); this platform has one flat managementQaRecords list. Best
  // effort: first record -> Management responsibility table (real tabular
  // row, header at row 6, the one pre-filled example at row 7 -- the
  // actual data row to write, not the header; verified real columns are
  // C="Job title / post" and F="Responsibilities", both merged-cell
  // anchors -- C6:E6/C7:E7 and F6:L6/F7:L7 -- so C/F are the only cells
  // that render, not the brief's original B/E), second (if present) -> QA
  // procedure narrative (title row 17, description rows 20-22 [not
  // written -- only title+department are captured, matching the brief's
  // 2-field-to-3-slot design choice], responsible-department row 23;
  // verified real value column is E, the anchor of the E:L merge -- D is
  // part of the separate C:D label merge and never renders), third (if
  // present) -> Data Validation narrative (title row 28, department row
  // 33, same E-column correction). Any beyond the third are not
  // represented on this sheet -- they remain fully visible in the generic
  // workbook.
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
  // format-guide row at row 6, real data rows 7-14 (verified: row 15 is
  // the start of a *different* sub-section, "J1: Additional information",
  // not more measure rows -- an 8-row capacity, not the originally
  // assumed 20). Columns verified against row 5's own header: C=
  // "Description of measure", H="Status" (not G, which is "Start year"),
  // J="Reporting year reduction (tCO2e)" (not I, which is "Pre-measure
  // reference (tCO2e/yr)").
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
