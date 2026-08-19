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

import XLSX from "xlsx";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import type { SourceStreamDetail } from "../storage";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMPLATE_PATH = path.join(__dirname, "..", "assets", "ead-deliverable-c-template.xlsx");

export function loadEadTemplate(): XLSX.WorkBook {
  // cellFormula: true preserves existing formulas on read so
  // clearIllustrativeRows/the fill functions can detect and skip them.
  const fileBuffer = fs.readFileSync(TEMPLATE_PATH);
  return XLSX.read(fileBuffer, { cellFormula: true });
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
