"""
scripts/exiobase/build_factors.py

Offline, one-time (or per-EXIOBASE-release) computation of real region x
sector GHG multipliers from raw EXIOBASE3 data via pymrio -- NOT a lookup
table, a genuine Leontief inverse. Writes flat JSON that
scripts/manual-migration-010.mjs loads verbatim; this script is never run
by the live app.

EXIOBASE v3.10.2 data. Non-commercial license only as of this migration
(see LICENSE.txt at https://zenodo.org/records/20051562) -- explicitly
excludes "any use by for-profit or commercial entities" and "any use
intended to generate revenue." User's explicit decision (2026-09-02):
build now, pre-revenue/pre-customer; commercial license to be obtained
from exiobase-support@googlegroups.com before this product is sold.
Do not remove this comment until that license is confirmed in hand.

Prerequisite: run `node scripts/manual-migration-011.mjs` first -- it seeds
this app's own gwpValues table with every gas this script needs (including
SF6, added there) and exports scripts/exiobase/gwp_weights.json from that
live table. This script reads that JSON rather than hardcoding GWP-100
weights, so those weights are structurally sourced from gwpValues, not
re-typed here.

Usage: python scripts/exiobase/build_factors.py
"""
import datetime
import json
import time
from pathlib import Path

import pymrio

FACTOR_YEAR = 2022
EXIOBASE_VERSION = "3.10.2"
SOURCE_URL = "https://zenodo.org/records/20051562"
OUTPUT_DIR = Path(__file__).parent / "output"
GWP_WEIGHTS_PATH = Path(__file__).parent / "gwp_weights.json"

FILES = {
    "pxp": Path.home() / "Downloads" / "IOT_2022_pxp.zip",
    "ixi": Path.home() / "Downloads" / "IOT_2022_ixi.zip",
}

# ---------------------------------------------------------------------------
# GHG stressor rows in EXIOBASE's air_emissions extension.
#
# Confirmed directly against both IOT_2022_ixi.zip and IOT_2022_pxp.zip this
# session (air_emissions/unit.txt is byte-identical between the two -- same
# 420-row stressor set, same units, in both table types): the extension
# carries 420 total stressor rows, of which exactly 25 are genuine
# GHG-bearing rows (CO2/CH4/N2O/SF6/HFC/PFC per IPCC AR6/GHG Protocol scope)
# -- the remaining ~395 are air-quality pollutants (PM10/PM2.5, NOx, SOx,
# NMVOC, heavy metals, PAHs, etc.), not greenhouse gases, and are correctly
# excluded.
#
# Of those 25 GHG-bearing rows, 2 are explicitly tagged biogenic CO2
# ("CO2_bio - combustion - air", "CO2 - waste - biogenic - air") and stay
# excluded from the summed multiplier, matching this app's existing
# convention (emissionFactorsTable.isBiogenic / ipccDefaultFactors --
# biogenic CO2 is reported separately, not folded into a scope total).
# Biogenic CH4/N2O are GHGs regardless of source and are included at their
# own GWP-100 value, exactly like the original 4-row set already did for
# CH4_bio.
#
# GWP_KEY below maps each summed row to the gas whose weight to apply, read
# from gwp_weights.json (itself exported from this app's live gwpValues
# table by manual-migration-011.mjs -- see that script's header comment).
# Two special cases use weight 1 directly rather than a gwp_values lookup:
#   - "HFC - air" and "PFC - air": confirmed via air_emissions/unit.txt that
#     EXIOBASE reports both already in "kg CO2-eq" (a single pre-aggregated
#     figure across unspecified F-gas species), not a raw mass of one named
#     gas -- there is no single-species "HFC"/"PFC" formula to look up in
#     gwp-ar6-reference.xlsx, and fabricating one would misrepresent what
#     these rows are. They are summed as already-weighted CO2e.
#   - Non-combustion CH4 rows from fossil-fuel extraction/refining (natural
#     gas, crude oil, five coal types, oil refinery) use the "fossil" GWP:
#     the methane itself is fossil-origin carbon. CH4 from agriculture and
#     waste uses the "non-fossil" (biogenic) GWP: it originates from recent
#     biological carbon (enteric fermentation/manure, organic waste
#     decomposition), the same category CH4_bio already represented.
#   - N2O has no fossil/non-fossil split in gwp-ar6-reference.xlsx (a single
#     GWP-100 value covers both) -- N2O_bio reuses the plain "N2O" weight.
#   - "CO2 - agriculture - peat decay - air" is not tagged "_bio" by
#     EXIOBASE's own naming (unlike the two rows that are), consistent with
#     IPCC/GHG Protocol AFOLU treatment of drained-organic-soil CO2 as a
#     reportable (non-biogenic-exempt) anthropogenic emission, not
#     short-cycle biomass CO2 -- included as CO2 (weight 1).
GWP_KEY = {
    # combustion
    "CO2 - combustion - air": "CO2",
    "CH4 - combustion - air": "CH4 (fossil)",
    "CH4_bio - combustion - air": "CH4 (non-fossil)",
    "N2O - combustion - air": "N2O",
    "N2O_bio - combustion - air": "N2O",
    # non-combustion: fugitive CH4 from fossil fuel extraction/refining
    "CH4 - non combustion - Extraction/production of (natural) gas - air": "CH4 (fossil)",
    "CH4 - non combustion - Extraction/production of crude oil - air": "CH4 (fossil)",
    "CH4 - non combustion - Mining of antracite - air": "CH4 (fossil)",
    "CH4 - non combustion - Mining of bituminous coal - air": "CH4 (fossil)",
    "CH4 - non combustion - Mining of coking coal - air": "CH4 (fossil)",
    "CH4 - non combustion - Mining of lignite (brown coal) - air": "CH4 (fossil)",
    "CH4 - non combustion - Mining of sub-bituminous coal - air": "CH4 (fossil)",
    "CH4 - non combustion - Oil refinery - air": "CH4 (fossil)",
    # non-combustion: industrial process CO2
    "CO2 - non combustion - Cement production - air": "CO2",
    "CO2 - non combustion - Lime production - air": "CO2",
    # fluorinated gases
    "SF6 - air": "SF6",
    "HFC - air": None,  # already "kg CO2-eq" per air_emissions/unit.txt -- weight 1, no gwp_values lookup
    "PFC - air": None,  # same
    # agriculture
    "CH4 - agriculture - air": "CH4 (non-fossil)",
    "CO2 - agriculture - peat decay - air": "CO2",
    "N2O - agriculture - air": "N2O",
    # waste
    "CH4 - waste - air": "CH4 (non-fossil)",
    "CO2 - waste - fossil - air": "CO2",
}

# Biogenic CO2 -- GHG-bearing but deliberately excluded from the sum, per
# this app's existing biogenic-CO2 convention. Listed here (not just
# omitted from GWP_KEY) so the 25-row completeness check below can verify
# nothing was silently missed rather than silently dropped.
EXCLUDED_BIOGENIC_CO2_ROWS = {
    "CO2_bio - combustion - air",
    "CO2 - waste - biogenic - air",
}


def load_gwp_weights() -> dict[str, float]:
    if not GWP_WEIGHTS_PATH.exists():
        raise FileNotFoundError(
            f"{GWP_WEIGHTS_PATH} not found -- run `node scripts/manual-migration-011.mjs` first "
            "so GWP-100 weights are exported from this app's live gwpValues table."
        )
    data = json.loads(GWP_WEIGHTS_PATH.read_text())
    needed = {g for g in GWP_KEY.values() if g is not None}
    missing = needed - set(data.keys())
    if missing:
        raise ValueError(f"{GWP_WEIGHTS_PATH} is missing weights for: {sorted(missing)}")
    return {gas: row["gwpValue"] for gas, row in data.items()}


# Confirmed directly from the parsed file's own 49-region index this
# session -- 44 named countries (label = the real country name, matching
# manual-migration-010.mjs's NAMED_COUNTRIES table exactly, so this script
# and the migration never disagree on a label) plus 5 Rest-of-World
# aggregates.
NAMED_COUNTRIES = {
    "AT": "Austria", "BE": "Belgium", "BG": "Bulgaria", "CY": "Cyprus", "CZ": "Czechia",
    "DE": "Germany", "DK": "Denmark", "EE": "Estonia", "ES": "Spain", "FI": "Finland",
    "FR": "France", "GR": "Greece", "HR": "Croatia", "HU": "Hungary", "IE": "Ireland",
    "IT": "Italy", "LT": "Lithuania", "LU": "Luxembourg", "LV": "Latvia", "MT": "Malta",
    "NL": "Netherlands", "PL": "Poland", "PT": "Portugal", "RO": "Romania", "SE": "Sweden",
    "SI": "Slovenia", "SK": "Slovakia", "GB": "United Kingdom", "US": "United States",
    "JP": "Japan", "CN": "China", "CA": "Canada", "KR": "South Korea", "BR": "Brazil",
    "IN": "India", "MX": "Mexico", "RU": "Russia", "AU": "Australia", "CH": "Switzerland",
    "TR": "Turkey", "TW": "Taiwan", "NO": "Norway", "ID": "Indonesia", "ZA": "South Africa",
}

REGION_LABELS = {
    "WA": "Rest of World - Asia and Pacific",
    "WL": "Rest of World - America",
    "WE": "Rest of World - Europe",
    "WF": "Rest of World - Africa",
    "WM": "Rest of World - Middle East",
}


def region_label(code: str) -> str:
    if code in NAMED_COUNTRIES:
        return NAMED_COUNTRIES[code]
    return REGION_LABELS.get(code, code)


def build_one(table_type: str, path: Path, gwp_weights: dict[str, float], computed_at: str) -> list[dict]:
    print(f"[{table_type}] Parsing {path.name}...")
    t0 = time.time()
    io = pymrio.parse_exiobase3(path=str(path))
    print(f"[{table_type}] Parsed in {time.time() - t0:.1f}s")

    # Fill missing (NaN) raw stressor data with 0 before calc_all(). Found
    # this session while re-adding the fuller GHG stressor set: exactly one
    # cell -- ('WM', 'Extra-territorial organizations and bodies'), an
    # ISIC-style category for embassies/international bodies with no
    # meaningful reported economic activity -- is NaN (not 0) in
    # air_emissions.F for all 18 of the newly-added stressor rows (verified
    # directly against both zips; F_Y carries a similar small number of NaN
    # cells across the wider stressor set). This is "not measured/reported"
    # in the source data, not "zero emissions" -- but left as NaN it does
    # NOT stay a single missing cell: calc_all()'s M = S @ L is a dense
    # matrix product against the Leontief inverse, so one NaN in a
    # stressor's direct-intensity row corrupts nearly the ENTIRE row of M
    # (thousands of region-sector cells, not just the one input cell) once
    # propagated through calc_all(). Confirmed empirically: before this
    # fix, all 18 new rows were >99.9% NaN in M; after it, only the
    # genuinely-undefined (zero-output) cells are null, exactly matching
    # the pre-existing 4-row baseline's data quality. This is orthogonal to
    # the zero-total-output NULL handling below (that's about the
    # denominator, io.x; this is about a missing value in the numerator,
    # io.air_emissions.F) -- both are real, independently-caused data
    # quality issues in different parts of the same pipeline.
    io.air_emissions.F = io.air_emissions.F.fillna(0.0)
    io.air_emissions.F_Y = io.air_emissions.F_Y.fillna(0.0)

    # Check the unit assumption with an explicit raise, not a bare `assert`
    # -- `assert` is stripped entirely under `python -O`, which would
    # silently remove exactly the guard that protects against the
    # 1,000,000x unit-conversion bug this whole pipeline exists to avoid.
    units = io.unit["unit"].unique()
    if list(units) != ["M.EUR"]:
        raise ValueError(
            f"[{table_type}] Unexpected unit(s) {units}, expected only 'M.EUR' -- "
            "do not proceed without re-deriving the conversion factor."
        )

    t1 = time.time()
    io.calc_all()
    print(f"[{table_type}] calc_all() completed in {time.time() - t1:.1f}s")

    M = io.air_emissions.M
    all_ghg_rows = set(GWP_KEY.keys()) | EXCLUDED_BIOGENIC_CO2_ROWS
    missing = [r for r in all_ghg_rows if r not in M.index]
    if missing:
        raise ValueError(f"[{table_type}] Missing expected GHG stressor rows: {sorted(missing)}")
    if len(all_ghg_rows) != 25:
        raise ValueError(f"[{table_type}] Expected exactly 25 GHG-bearing stressor rows, found {len(all_ghg_rows)}")

    co2e_per_meur = None
    for row, gas in GWP_KEY.items():
        weight = 1 if gas is None else gwp_weights[gas]
        term = M.loc[row] * weight
        co2e_per_meur = term if co2e_per_meur is None else co2e_per_meur + term
    co2e_per_eur = co2e_per_meur / 1_000_000  # M.EUR -> EUR, asserted above

    # Total output per region-sector (pymrio's `x` vector). Where this is
    # zero (or NaN), the emissions-per-EUR-of-output multiplier is
    # mathematically undefined (0/0) -- pymrio's own division-by-zero
    # handling silently produces 0.0 for these cells, indistinguishable
    # from a genuine low-carbon factor. Store NULL instead.
    total_output = io.x["indout"]

    rows = []
    unexpected_nan = []
    for region in io.get_regions():
        for sector in io.get_sectors():
            key = (region, sector)
            output = total_output.loc[key]
            is_undefined = bool(output == 0) or (output != output)  # NaN != NaN
            value = None
            if not is_undefined:
                raw = float(co2e_per_eur[key])
                if raw != raw:  # NaN despite a well-defined (non-zero) output -- a real bug, not an undefined cell
                    unexpected_nan.append(key)
                else:
                    value = round(raw, 10)
            rows.append({
                "region": region,
                "regionLabel": region_label(region),
                "sector": sector,
                "tableType": table_type,
                "kgCo2ePerEur": value,
                "factorYear": FACTOR_YEAR,
                "exiobaseVersion": EXIOBASE_VERSION,
                "sourceUrl": SOURCE_URL,
                "computedAt": computed_at,
            })
    if unexpected_nan:
        # Fail loudly rather than silently ship a NaN (which json.dumps
        # would write as the invalid-JSON literal `NaN`) or misclassify it
        # as a legitimate undefined-output NULL. Seen once this session
        # from unfilled NaN in raw air_emissions.F propagating through the
        # Leontief inverse -- see the fillna(0.0) comment above; if this
        # fires again, the raw stressor data has a new gap that needs the
        # same treatment.
        raise ValueError(
            f"[{table_type}] {len(unexpected_nan)} cell(s) have a well-defined (non-zero) total output "
            f"but a NaN summed GHG value -- a real bug, not a legitimate undefined cell. "
            f"First few: {unexpected_nan[:5]}"
        )
    return rows


def main():
    gwp_weights = load_gwp_weights()
    # When this script actually ran (provenance metadata for computedAt --
    # not used in any calculation), captured once and shared by both table
    # types so pxp/ixi carry the same timestamp for this one run.
    computed_at = datetime.datetime.now().astimezone().isoformat()

    OUTPUT_DIR.mkdir(exist_ok=True)
    for table_type, path in FILES.items():
        if not path.exists():
            raise FileNotFoundError(f"{path} not found -- see Global Constraints for the expected download location/checksum.")
        rows = build_one(table_type, path, gwp_weights, computed_at)
        out_path = OUTPUT_DIR / f"exiobase_{table_type}_{FACTOR_YEAR}.json"
        out_path.write_text(json.dumps(rows, indent=None))
        n_null = sum(1 for r in rows if r["kgCo2ePerEur"] is None)
        print(f"[{table_type}] Wrote {len(rows)} rows to {out_path} ({n_null} NULL / undefined-output cells, {n_null / len(rows):.1%})")


if __name__ == "__main__":
    main()
