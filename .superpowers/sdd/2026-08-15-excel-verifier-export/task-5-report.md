# Task 5 report: EAD fill -- core sheets (Source Streams, Calculation Approaches, Data Gaps)

**Status: this report supersedes the original Task 5 report.** The prior
implementer (commit `bd458a7`) wrote real data directly over
`3d2_ Calculation Approaches!D25`/`E25`, which carry a live
`IFERROR(INDEX(...))` formula, on the judgment that leaving the formula
alone would let it surface stale illustrative data. An independent
reviewer agreed the overwrite was necessary. **The product owner overruled
both**, with an absolute rule stated as: "Do not overwrite formula in EAD
sheet" -- no exceptions, ever, even when leaving a formula alone would
otherwise let it leak stale data. This session brings the shipped code
back in line with that rule, per the corrected plan
(`docs/superpowers/plans/2026-08-15-excel-verifier-export.md`, Task 5 and
the writeIfNotFormula section of Task 4, committed as `bca005e`).

## What changed

`server/utils/ead-template-fill.ts`:

1. **Added `writeIfNotFormula(ws, address, cell)`** -- a shared guard used
   by every write in every fill function (Tasks 5 and 6). If the target
   cell already carries a `.f` formula property, the write is skipped
   entirely; otherwise it proceeds exactly as before. No fill function
   anywhere in this feature writes a plain value over a formula cell,
   full stop.

2. **Added two entries to `ILLUSTRATIVE_CELLS`**: `["2c2_Facility
   Description", "G75"]` and `["2c2_Facility Description", "H75"]`. These
   are the fabricated example values (`10000`, `"MWh"`) that
   `3d2!D25`/`E25`'s `IFERROR(INDEX(...))` formula reads via
   `MATCH($B25, '2c2_Facility Description'!$C$75:$C$84, 0)`. Clearing the
   *data the formula reads*, rather than the formula itself, is how the
   "leaked stale data" problem is actually solved without ever touching a
   formula. `C75` (the static row-ID label `"F01"` that a *different*
   live formula, `3d1!B10`, formula-reads) was deliberately **not**
   added -- clearing it would break what that other formula resolves to,
   which the same "never touch a formula" rule equally forbids in the
   sense of never breaking what a formula depends on.

3. **Rewrote every direct `sheet[address] = {...}` assignment** in
   `fillCoreSheets()` and `fillDataGapsSheet()` to route through
   `writeIfNotFormula(sheetVar, address, cellObject)` instead. No
   behavioral change for any cell that was never carrying a formula (the
   overwhelming majority); the only behavioral change is that `3d2!D25`
   and `3d2!E25` are now left alone even when real
   `activityDataValue`/`activityDataUnit` data exists for that row. This
   is a disclosed, accepted gap for that one specific pair of cells in the
   EAD-specific export -- the generic ISO 14064-3 workbook (Task 3) is
   unaffected and always carries the complete data.

4. **Added null guards** matching the existing style in
   `clearIllustrativeRows()`:
   - `fillCoreSheets()`: `if (!streamSheet || !approachSheet) return {
     omittedCount };` right after both sheet lookups.
   - `fillDataGapsSheet()`: `if (!sheet) return { omittedCount: 0 };`
     right after the sheet lookup.

The new code matches the plan document's Task 5 section
(`docs/superpowers/plans/2026-08-15-excel-verifier-export.md` lines
877-985) and the `writeIfNotFormula`/`ILLUSTRATIVE_CELLS` additions in the
Task 4 section (lines 798-857) exactly.

## Verification

### `npm run check`

Ran clean, no errors:

```
> rest-express@1.0.0 check
> tsc
```

(no output after the command -- zero TypeScript errors)

### Live verification (throwaway script, deleted after use)

Wrote `verify-task5-tmp.mts` at the repo root (not committed, deleted
immediately after this run). It called `loadEadTemplate()`,
`clearIllustrativeRows(wb)`, then `fillCoreSheets(wb, streamDetails)` with
3 real `SourceStreamDetail`-shaped records -- the first of which
(`F01`/"Natural gas combustion") carries real, non-empty
`activityDataValue: 55000` and `activityDataUnit: "MWh"`, i.e. exactly the
kind of real data that WOULD have overwritten row 25's `D`/`E` cells if
`writeIfNotFormula` were not guarding them. Then read back the cells
listed in the plan's required formula-preservation check, with
`cellFormula: true` already in effect from `loadEadTemplate()`. Full
actual printed output:

```
=== fillCoreSheets result (3 records) ===
{
  "omittedCount": 0
}

=== 3d2_ Calculation Approaches!D25 (must still carry IFERROR(INDEX(...)) formula) ===
{
  "t": "n",
  "v": 10000,
  "f": "IFERROR(INDEX('2c2_Facility Description'!G$75:G$84,MATCH($B25,'2c2_Facility Description'!$C$75:$C$84,0)),\"\")",
  "w": "10000"
}

=== 3d2_ Calculation Approaches!E25 (must still carry IFERROR(INDEX(...)) formula) ===
{
  "t": "s",
  "v": "MWh",
  "f": "IFERROR(INDEX('2c2_Facility Description'!H$75:H$84,MATCH($B25,'2c2_Facility Description'!$C$75:$C$84,0)),\"\")",
  "h": "MWh",
  "w": "MWh"
}

=== 2c2_Facility Description!G75 (must be empty/undefined -- cleared) ===
undefined

=== 2c2_Facility Description!H75 (must be empty/undefined -- cleared) ===
undefined

=== 2c2_Facility Description!C75 (must still read "F01" -- NOT cleared) ===
{
  "t": "s",
  "v": "F01",
  "r": "<t>F01</t>",
  "h": "F01",
  "w": "F01"
}

=== 3d1_Source Streams (Calculated)!C10 (must contain real value passed in) ===
{
  "t": "s",
  "v": "Boiler natural gas combustion"
}

=== 3d2_ Calculation Approaches!C25 (real value, not formula-protected) ===
{
  "t": "s",
  "v": "Natural gas"
}

=== 3d2_ Calculation Approaches!F25 (real value, not formula-protected) ===
{
  "t": "s",
  "v": "Utility meter readings"
}

=== fillCoreSheets with 30 records (expect omittedCount=5) ===
{
  "omittedCount": 5
}
```

### Interpretation

- `3d2!D25` and `3d2!E25` both retain their full `.f` formula string
  (`IFERROR(INDEX(...))`) after `fillCoreSheets` ran with real,
  non-empty `activityDataValue`/`activityDataUnit` for that exact row --
  proof the write was skipped, not just that no data happened to be
  passed. Their `.v`/`.w` still show the old cached `10000`/`"MWh"`
  because xlsx does not recompute formulas on a Node-side write; that
  cached value is stale until the file is opened in Excel and
  recalculated, at which point `IFERROR(INDEX(...))` will resolve against
  the now-cleared `G75`/`H75` and correctly return blank rather than
  leaking the illustrative example. This is expected and matches the
  plan's design.
- `2c2!G75` and `2c2!H75` both read back as `undefined` -- the
  illustrative-clearing step removed the fabricated `10000`/`"MWh"`
  values as designed.
- `2c2!C75` still reads `"F01"` -- confirming the row-ID scaffold that
  `3d1!B10` depends on was correctly left untouched.
- `3d1!C10` contains the real description text passed in
  (`"Boiler natural gas combustion"`), and `3d2!C25`/`F25` contain the
  real fuel type and source strings passed in -- confirming the fill
  logic still writes real data everywhere a formula isn't present.
- `omittedCount` is `0` for 3 input records and `5` for 30 input records
  against the 25-row capacity, matching the plan's expected behavior.

## Commit

`server/utils/ead-template-fill.ts` committed with message referencing the
formula-overwrite reversal. See commit hash in the calling session's
summary.
