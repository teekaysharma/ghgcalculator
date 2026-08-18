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
const ILLUSTRATIVE_CELLS: [string, string][] = [
  // 3d1_Source Streams (Calculated): F01 example row + its tier/uncertainty row
  ["3d1_Source Streams (Calculated)", "C9"],
  ["3d1_Source Streams (Calculated)", "E9"],
  ["3d1_Source Streams (Calculated)", "F9"],
  ["3d1_Source Streams (Calculated)", "G9"],
  ["3d1_Source Streams (Calculated)", "C38"],
  ["3d1_Source Streams (Calculated)", "D38"],
  ["3d1_Source Streams (Calculated)", "E38"],
  ["3d1_Source Streams (Calculated)", "F38"],
  ["3d1_Source Streams (Calculated)", "G38"],
  ["3d1_Source Streams (Calculated)", "H38"],
  // 3d2_Calculation Approaches: Natural gas / Crude oil / measurement instrument examples
  ["3d2_ Calculation Approaches", "C16"],
  ["3d2_ Calculation Approaches", "D16"],
  ["3d2_ Calculation Approaches", "E16"],
  ["3d2_ Calculation Approaches", "F16"],
  ["3d2_ Calculation Approaches", "G16"],
  ["3d2_ Calculation Approaches", "C44"],
  ["3d2_ Calculation Approaches", "D44"],
  ["3d2_ Calculation Approaches", "E44"],
  ["3d2_ Calculation Approaches", "F44"],
  ["3d2_ Calculation Approaches", "G44"],
  ["3d2_ Calculation Approaches", "H44"],
  ["3d2_ Calculation Approaches", "I44"],
  ["3d2_ Calculation Approaches", "C75"],
  ["3d2_ Calculation Approaches", "E75"],
  ["3d2_ Calculation Approaches", "F75"],
  ["3d2_ Calculation Approaches", "G75"],
  ["3d2_ Calculation Approaches", "H75"],
  ["3d2_ Calculation Approaches", "I75"],
  ["3d2_ Calculation Approaches", "J75"],
  ["3d2_ Calculation Approaches", "K75"],
  ["3d2_ Calculation Approaches", "C77"],
  ["3d2_ Calculation Approaches", "E77"],
  ["3d2_ Calculation Approaches", "F77"],
  ["3d2_ Calculation Approaches", "G77"],
  ["3d2_ Calculation Approaches", "H77"],
  ["3d2_ Calculation Approaches", "I77"],
  ["3d2_ Calculation Approaches", "J77"],
  ["3d2_ Calculation Approaches", "K77"],
  // 3e1_Emission Sources (Measured): S01 example rows
  ["3e1_Emission Sources (Measured)", "C8"],
  ["3e1_Emission Sources (Measured)", "D8"],
  ["3e1_Emission Sources (Measured)", "C37"],
  ["3e1_Emission Sources (Measured)", "D37"],
  ["3e1_Emission Sources (Measured)", "E37"],
  ["3e1_Emission Sources (Measured)", "F37"],
  ["3e1_Emission Sources (Measured)", "G37"],
  // 2c2_Facility Description: example products P01/P02, example emission sources S01-S05
  ["2c2_Facility Description", "C13"],
  ["2c2_Facility Description", "G13"],
  ["2c2_Facility Description", "H13"],
  ["2c2_Facility Description", "C14"],
  ["2c2_Facility Description", "G14"],
  ["2c2_Facility Description", "H14"],
  ["2c2_Facility Description", "C32"],
  ["2c2_Facility Description", "D32"],
  ["2c2_Facility Description", "E32"],
  ["2c2_Facility Description", "G32"],
  ["2c2_Facility Description", "H32"],
  ["2c2_Facility Description", "I32"],
  ["2c2_Facility Description", "C33"],
  ["2c2_Facility Description", "D33"],
  ["2c2_Facility Description", "E33"],
  ["2c2_Facility Description", "I33"],
  ["2c2_Facility Description", "C34"],
  ["2c2_Facility Description", "D34"],
  ["2c2_Facility Description", "E34"],
  ["2c2_Facility Description", "I34"],
  ["2c2_Facility Description", "C35"],
  ["2c2_Facility Description", "D35"],
  ["2c2_Facility Description", "I35"],
  ["2c2_Facility Description", "C36"],
  ["2c2_Facility Description", "D36"],
  ["2c2_Facility Description", "I36"],
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
