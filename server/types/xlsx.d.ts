import "xlsx";

// The installed `xlsx` package's own .d.ts (node_modules/xlsx/types/index.d.ts)
// omits `CalcPr` from `WBProps`, even though the library's runtime parser
// (xlsx.js's parse_wb) does read/produce a `CalcPr` object on the workbook-
// level structure -- it is a real, documented SheetJS field (18.2.2 CT_CalcPr
// in the OOXML spec, e.g. `fullCalcOnLoad`), just missing from the shipped
// type declarations. Augment it here so `wb.Workbook.CalcPr` type-checks
// (server/routes.ts's export-ead.xlsx handler sets `fullCalcOnLoad` as a
// belt-and-suspenders recalc hint for Excel -- see Task 8's report for the
// empirical finding on whether the writer actually serializes it back out).
declare module "xlsx" {
  interface WBProps {
    CalcPr?: { fullCalcOnLoad?: 0 | 1 } & Record<string, unknown>;
  }
}
