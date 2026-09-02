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

Usage: python scripts/exiobase/build_factors.py
"""
import json
import time
from pathlib import Path

import pymrio

FACTOR_YEAR = 2022
EXIOBASE_VERSION = "3.10.2"
SOURCE_URL = "https://zenodo.org/records/20051562"
OUTPUT_DIR = Path(__file__).parent / "output"

FILES = {
    "pxp": Path.home() / "Downloads" / "IOT_2022_pxp.zip",
    "ixi": Path.home() / "Downloads" / "IOT_2022_ixi.zip",
}

# Same verified AR6 GWP-100 values already seeded in this app's gwpValues
# table / client/public/gwp-ar6-reference.xlsx -- do not re-derive.
GWP = {
    "CO2 - combustion - air": 1,
    "CH4 - combustion - air": 29.8,
    "CH4_bio - combustion - air": 27.0,
    "N2O - combustion - air": 273,
}

# Confirmed directly from the parsed file's own 49-region index this
# session -- 44 named countries (label = the country name) plus 5
# Rest-of-World aggregates.
REGION_LABELS = {
    "WA": "Rest of World - Asia and Pacific",
    "WL": "Rest of World - America",
    "WE": "Rest of World - Europe",
    "WF": "Rest of World - Africa",
    "WM": "Rest of World - Middle East",
}


def region_label(code: str) -> str:
    return REGION_LABELS.get(code, code)  # named countries: label = code itself, filled in by the migration's own country table


def build_one(table_type: str, path: Path) -> list[dict]:
    print(f"[{table_type}] Parsing {path.name}...")
    t0 = time.time()
    io = pymrio.parse_exiobase3(path=str(path))
    print(f"[{table_type}] Parsed in {time.time() - t0:.1f}s")

    # Assert the unit assumption rather than trust it silently -- this is
    # exactly the bug caught during this session's validation spike (a
    # missed M.EUR->EUR conversion produced multipliers ~1,000,000x too
    # large).
    units = io.unit["unit"].unique()
    assert list(units) == ["M.EUR"], f"[{table_type}] Unexpected unit(s) {units}, expected only 'M.EUR' -- do not proceed without re-deriving the conversion factor."

    t1 = time.time()
    io.calc_all()
    print(f"[{table_type}] calc_all() completed in {time.time() - t1:.1f}s")

    M = io.air_emissions.M
    missing = [r for r in GWP if r not in M.index]
    assert not missing, f"[{table_type}] Missing expected GHG stressor rows: {missing}"

    co2e_per_meur = sum(M.loc[r] * w for r, w in GWP.items())
    co2e_per_eur = co2e_per_meur / 1_000_000  # M.EUR -> EUR, asserted above

    rows = []
    for region in io.get_regions():
        for sector in io.get_sectors():
            rows.append({
                "region": region,
                "regionLabel": region_label(region),
                "sector": sector,
                "tableType": table_type,
                "kgCo2ePerEur": round(float(co2e_per_eur[(region, sector)]), 10),
                "factorYear": FACTOR_YEAR,
                "exiobaseVersion": EXIOBASE_VERSION,
                "sourceUrl": SOURCE_URL,
            })
    return rows


def main():
    OUTPUT_DIR.mkdir(exist_ok=True)
    for table_type, path in FILES.items():
        if not path.exists():
            raise FileNotFoundError(f"{path} not found -- see Global Constraints for the expected download location/checksum.")
        rows = build_one(table_type, path)
        out_path = OUTPUT_DIR / f"exiobase_{table_type}_{FACTOR_YEAR}.json"
        out_path.write_text(json.dumps(rows, indent=None))
        print(f"[{table_type}] Wrote {len(rows)} rows to {out_path}")


if __name__ == "__main__":
    main()
