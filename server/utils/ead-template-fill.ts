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
];

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
