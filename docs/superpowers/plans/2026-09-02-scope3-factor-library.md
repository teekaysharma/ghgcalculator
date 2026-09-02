# Scope 3 Spend-Based Factor Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seed two new global reference tables — EPA NAICS-6 spend-based factors and EXIOBASE region×sector multipliers — plus a country→EXIOBASE-region lookup, so later phases (spend mapping, search, tiering) have real, verified factor data to build on.

**Architecture:** Two independent offline data-prep steps (EPA CSV reshape, EXIOBASE `pymrio` computation) each produce flat JSON files committed to the repo; one idempotent Node migration script loads all of it into three new Postgres tables, following the existing `manual-migration-0XX.mjs` pattern exactly. No new runtime dependencies, no request-time computation.

**Tech Stack:** TypeScript/Drizzle (schema), Python 3 + `pymrio` (offline EXIOBASE computation, already confirmed installed — `pymrio` 0.6.3), Node/`pg` (migration).

## Global Constraints

- Every new table follows the existing `ipccDefaultFactors`/`gwpValues` pattern in `shared/schema.ts`: no `organizationId`, global reference data, not org-scoped.
- `drizzle-kit push` is confirmed broken for this project's schema diffs (`MIGRATIONS.md`) — schema changes ship only via a hand-written idempotent migration script, `scripts/manual-migration-010.mjs` (the next number after the existing 001–009), following the `tableExists`/`ensureTable`/`indexExists`/`ensureIndex` helper pattern in `scripts/manual-migration-009.mjs` exactly, transaction-wrapped (`BEGIN`/`COMMIT`, `ROLLBACK` on error).
- EXIOBASE's `Z`/`Y`/`x` matrices are denominated in **Million EUR** (confirmed both from the zip's own `unit.txt` and programmatically via `pymrio`'s `io.unit`). The pipeline must assert this unit rather than assume it, and divide the `M` matrix by 1,000,000 before storing `kgCo2ePerEur`.
- AR6 GWP-100 weights used for the EXIOBASE GWP-weighting step must match the values already verified and seeded in this app's own `gwpValues` table / `client/public/gwp-ar6-reference.xlsx`: CO2 = 1, CH4 (fossil) = 29.8, CH4 (biogenic) = 27.0, N2O = 273. Do not re-derive or re-type these from a different source.
- EXIOBASE data source: `C:\Users\LENOVO\Downloads\IOT_2022_pxp.zip` (md5 `96f187d8253d4d2363708a07ef3b1c02`, 234,096,377 bytes) and `IOT_2022_ixi.zip` (243,201,144 bytes), both EXIOBASE v3.10.2, year 2022, from `https://zenodo.org/records/20051562` — already downloaded and checksum-verified, do not re-download.
- EPA NAICS-6 source: `C:\Users\LENOVO\Downloads\SupplyChainGHGEmissionFactors_v1.3.0_NAICS_CO2e_USD2022.csv` (the combined-CO2e file, not the per-gas `byGHG` variant — matches this table's deliberate v1 scope: no per-gas breakdown, see spec).
- **Licensing comment required verbatim** in `scripts/exiobase/build_factors.py` and in `scripts/manual-migration-010.mjs` above the EXIOBASE-loading code (not the EPA-loading code — EPA data is U.S. public domain under 17 U.S.C. § 105, confirmed via `https://pasteur.epa.gov/license/sciencehub-license.html`, no licensing gate needed there):

  ```
  // EXIOBASE v3.10.2 data. Non-commercial license only as of this migration
  // (see LICENSE.txt at https://zenodo.org/records/20051562) -- explicitly
  // excludes "any use by for-profit or commercial entities" and "any use
  // intended to generate revenue." User's explicit decision (2026-09-02):
  // build now, pre-revenue/pre-customer; commercial license to be obtained
  // from exiobase-support@googlegroups.com before this product is sold.
  // Do not remove this comment until that license is confirmed in hand.
  ```
- Both `pxp` and `ixi` are seeded (not just one), distinguished by a `tableType` column on `exiobaseFactors`.
- No per-gas breakdown in v1 for either table — combined CO2e only (deliberate scope decision, see spec's "Deliberately excluded from v1").

---

### Task 1: Schema — three new reference tables

**Files:**
- Modify: `shared/schema.ts` (append after the existing `gwpValues` table, following the same file convention as `ipccDefaultFactors`/`gwpValues`)

**Interfaces:**
- Produces: `epaNaicsFactors`, `exiobaseFactors`, `countryExiobaseRegions` (Drizzle `pgTable` exports), plus their inferred row types, for Task 4's migration script and any later phase to import from `@shared/schema`.

- [ ] **Step 1: Add the three table definitions**

Append to `shared/schema.ts`, immediately after the `gwpValues` table:

```ts
// Scope 3 spend-based factor library, phase 1. Two independent global
// reference sources (no organizationId, same shared-seeded-data pattern as
// ipccDefaultFactors/gwpValues above), each computed/reshaped offline and
// loaded via scripts/manual-migration-010.mjs -- see
// docs/superpowers/specs/2026-09-02-scope3-factor-library-design.md for the
// full rationale, including why these are new tables rather than reusing
// emissionFactorsTable (that table's country/source columns would collide
// in meaning, not just name, with these sources' own geography/dataset
// fields).

export const epaNaicsFactors = pgTable(
  "epa_naics_factors",
  {
    id: serial("id").primaryKey(),
    naicsCode: text("naics_code").notNull(), // 6-digit 2017 NAICS
    naicsTitle: text("naics_title").notNull(),
    sefKgCo2ePerUsd: numeric("sef_kg_co2e_per_usd", { precision: 20, scale: 8 }).notNull(), // without margins
    mefKgCo2ePerUsd: numeric("mef_kg_co2e_per_usd", { precision: 20, scale: 8 }), // margins
    sefPlusMefKgCo2ePerUsd: numeric("sef_plus_mef_kg_co2e_per_usd", { precision: 20, scale: 8 }).notNull(), // headline figure
    referenceUseeioCode: text("reference_useeio_code"),
    factorYear: integer("factor_year").notNull(), // 2022
    sourceDataset: text("source_dataset").notNull(),
    sourceUrl: text("source_url").notNull(),
    retrievalDate: timestamp("retrieval_date").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    naicsIdx: index("epa_naics_factors_code_idx").on(table.naicsCode),
  }),
);
export type EpaNaicsFactor = typeof epaNaicsFactors.$inferSelect;

export const exiobaseFactors = pgTable(
  "exiobase_factors",
  {
    id: serial("id").primaryKey(),
    region: text("region").notNull(), // 2-letter EXIOBASE code, e.g. "WM"
    regionLabel: text("region_label").notNull(),
    sector: text("sector").notNull(),
    tableType: text("table_type").notNull(), // "pxp" | "ixi"
    kgCo2ePerEur: numeric("kg_co2e_per_eur", { precision: 20, scale: 10 }).notNull(),
    factorYear: integer("factor_year").notNull(), // 2022
    exiobaseVersion: text("exiobase_version").notNull(), // "3.10.2"
    computedAt: timestamp("computed_at").notNull(),
    sourceUrl: text("source_url").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    regionSectorIdx: index("exiobase_factors_region_sector_idx").on(table.region, table.sector, table.tableType),
    uniqueRow: unique("exiobase_factors_unique").on(table.region, table.sector, table.tableType, table.factorYear),
  }),
);
export type ExiobaseFactor = typeof exiobaseFactors.$inferSelect;

export const countryExiobaseRegions = pgTable("country_exiobase_regions", {
  id: serial("id").primaryKey(),
  countryCode: text("country_code").notNull().unique(), // ISO 3166-1 alpha-2, e.g. "AE"
  countryName: text("country_name").notNull(),
  exiobaseRegion: text("exiobase_region").notNull(), // "WM" for AE, self ("US") for the 44 named countries
  isDirectMatch: boolean("is_direct_match").notNull(), // false for RoW-aggregate mappings
});
export type CountryExiobaseRegion = typeof countryExiobaseRegions.$inferSelect;
```

- [ ] **Step 2: Typecheck**

Run: `npm run check`
Expected: clean, zero errors (this step only adds exported consts/types, nothing consumes them yet).

- [ ] **Step 3: Commit**

```bash
git add shared/schema.ts
git commit -m "schema: add epa_naics_factors, exiobase_factors, country_exiobase_regions"
```

---

### Task 2: EXIOBASE offline pipeline

**Files:**
- Create: `scripts/exiobase/build_factors.py`
- Create (generated by running the script, then committed): `scripts/exiobase/output/exiobase_pxp_2022.json`, `scripts/exiobase/output/exiobase_ixi_2022.json`

**Interfaces:**
- Consumes: `C:\Users\LENOVO\Downloads\IOT_2022_pxp.zip`, `C:\Users\LENOVO\Downloads\IOT_2022_ixi.zip` (already downloaded, checksummed).
- Produces: two JSON files, each an array of `{region, regionLabel, sector, tableType, kgCo2ePerEur, factorYear, exiobaseVersion, sourceUrl}` objects — one object per (region, sector) pair — for Task 4's migration script to load verbatim.

This is a hardened version of the already-validated spike (`exiobase_spike.py`, run this session: parsed `IOT_2022_ixi.zip` in 20.3s, `calc_all()` in 109.7s, produced real multipliers cross-checked against EPA figures). Hardening adds: the unit assertion, both table types, JSON output, and region-label lookup.

- [ ] **Step 1: Write the script**

```python
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
```

- [ ] **Step 2: Run it**

Run: `python scripts/exiobase/build_factors.py`
Expected: two JSON files in `scripts/exiobase/output/`, `pxp` with 49×200=9,800 rows, `ixi` with 49×163=7,987 rows. Both assertions (unit, GHG rows present) must pass — if either fails, stop and investigate before proceeding; do not silently work around an assertion failure here.

- [ ] **Step 3: Spot-check the output against this session's already-validated numbers**

```bash
python -c "
import json
rows = json.load(open('scripts/exiobase/output/exiobase_ixi_2022.json'))
by_key = {(r['region'], r['sector']): r['kgCo2ePerEur'] for r in rows}
print('US / Cultivation of wheat:', by_key[('US', 'Cultivation of wheat')])
print('WM / Cultivation of wheat:', by_key[('WM', 'Cultivation of wheat')])
"
```

Expected: `US / Cultivation of wheat: 0.284177`, `WM / Cultivation of wheat: 0.734812` — matching the values already computed and reported this session (confirms the hardened script reproduces the spike's validated output, not just that it runs).

- [ ] **Step 4: Commit**

```bash
git add scripts/exiobase/build_factors.py scripts/exiobase/output/exiobase_pxp_2022.json scripts/exiobase/output/exiobase_ixi_2022.json
git commit -m "feat: compute real EXIOBASE v3.10.2 region x sector GHG multipliers via pymrio"
```

---

### Task 3: EPA NAICS-6 data prep

**Files:**
- Create: `server/assets/epa-naics-factors-v1.3.0-2022.csv` (copy of the source file, bundled into the repo the same way `server/assets/ead-deliverable-c-template.xlsx` and `client/public/emission-factors-template.xlsx` already are)

**Interfaces:**
- Produces: a stable, in-repo path Task 4's migration script reads from — decoupled from the Downloads folder, which won't exist on another machine or in CI.

- [ ] **Step 1: Copy the file into the repo**

```bash
cp "C:\Users\LENOVO\Downloads\SupplyChainGHGEmissionFactors_v1.3.0_NAICS_CO2e_USD2022.csv" "server\assets\epa-naics-factors-v1.3.0-2022.csv"
```

- [ ] **Step 2: Verify row count and header match what was inspected this session**

```bash
python -c "
import csv
with open('server/assets/epa-naics-factors-v1.3.0-2022.csv', encoding='utf-8-sig') as f:
    rows = list(csv.reader(f))
print('header:', rows[0])
print('data rows:', len(rows) - 1)
print('first row:', rows[1])
"
```

Expected: header `['2017 NAICS Code', '2017 NAICS Title', 'GHG', 'Unit', 'Supply Chain Emission Factors without Margins', 'Margins of Supply Chain Emission Factors', 'Supply Chain Emission Factors with Margins', 'Reference USEEIO Code']`, 1,016 data rows, first row `['111110', 'Soybean Farming', 'All GHGs', 'kg CO2e/2022 USD, purchaser price', '0.488', '0.044', '0.532', '1111A0']` — this is the same figure (0.532) already used as the cross-check reference against the EXIOBASE spike, confirming the bundled copy matches the original exactly.

- [ ] **Step 3: Commit**

```bash
git add server/assets/epa-naics-factors-v1.3.0-2022.csv
git commit -m "feat: bundle the real EPA NAICS-6 v1.3 CO2e-combined factor CSV (public domain, 17 U.S.C. 105)"
```

---

### Task 4: Migration — load all three tables

**Files:**
- Create: `scripts/manual-migration-010.mjs`

**Interfaces:**
- Consumes: `epaNaicsFactors`/`exiobaseFactors`/`countryExiobaseRegions` table shapes from Task 1; `server/assets/epa-naics-factors-v1.3.0-2022.csv` from Task 3; `scripts/exiobase/output/exiobase_{pxp,ixi}_2022.json` from Task 2.
- Produces: populated `epa_naics_factors` (1,016 rows), `exiobase_factors` (17,787 rows), `country_exiobase_regions` (45 rows: 44 named countries + AE) in the live database.

- [ ] **Step 1: Write the migration script**

```js
// scripts/manual-migration-010.mjs
//
// Loads the Scope 3 spend-based factor library: EPA NAICS-6 (public domain,
// 17 U.S.C. 105, no licensing gate) and EXIOBASE v3.10.2 (non-commercial
// license only as of this migration -- see the comment above the EXIOBASE
// loading section below) region x sector multipliers, plus a
// country->EXIOBASE-region lookup covering the 44 individually-modeled
// countries and UAE (the only Rest-of-World mapping needed so far --
// extend on demand, not speculatively, per this project's YAGNI
// convention). See
// docs/superpowers/specs/2026-09-02-scope3-factor-library-design.md.
//
// Idempotent: skips any of the three seed steps if that table already has
// rows. Wrapped in one transaction, same pattern as every prior manual
// migration in this project.
//
// Usage: node scripts/manual-migration-010.mjs

import "dotenv/config";
import { Pool } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL not set. Run this from the project folder with .env filled in.");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const applied = [];
const skipped = [];

async function tableExists(client, table) {
  const res = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return res.rowCount > 0;
}

async function ensureTable(client, table, createDdl) {
  if (await tableExists(client, table)) {
    skipped.push(`table ${table} (already exists)`);
    return;
  }
  await client.query(createDdl);
  applied.push(`CREATE TABLE ${table}`);
}

async function indexExists(client, name) {
  const res = await client.query(`SELECT 1 FROM pg_indexes WHERE indexname = $1`, [name]);
  return res.rowCount > 0;
}

async function ensureIndex(client, name, ddl) {
  if (await indexExists(client, name)) {
    skipped.push(`index ${name} (already exists)`);
    return;
  }
  await client.query(ddl);
  applied.push(ddl);
}

async function tableRowCount(client, table) {
  const res = await client.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
  return res.rows[0].n;
}

// Minimal, correct CSV line parser for this specific file's shape (quoted
// fields only where a title contains a comma, e.g. "Cultivation of
// vegetables, fruit, nuts") -- not a general-purpose CSV library, this
// project has none and doesn't need one for a single well-formed file.
function parseCsvLine(line) {
  const fields = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { cur += c; }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ",") { fields.push(cur); cur = ""; }
      else { cur += c; }
    }
  }
  fields.push(cur);
  return fields;
}

function parseEpaCsv(path) {
  const text = readFileSync(path, "utf-8").replace(/^\uFEFF/, ""); // strip BOM
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const rows = lines.slice(1).map(parseCsvLine);
  return rows.map((r) => ({
    naicsCode: r[0],
    naicsTitle: r[1],
    // r[2] is "GHG" ("All GHGs" for every row in this file -- the
    // combined-CO2e variant, not the per-gas byGHG file), not stored as a
    // separate column since it's constant for this whole file.
    sefKgCo2ePerUsd: r[4],
    mefKgCo2ePerUsd: r[5],
    sefPlusMefKgCo2ePerUsd: r[6],
    referenceUseeioCode: r[7],
  }));
}

async function bulkInsert(client, table, columns, rows, conflictDdl, chunkSize = 500) {
  let insertedTotal = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const values = [];
    const placeholders = chunk.map((row, r) => {
      const base = r * columns.length;
      values.push(...columns.map((c) => row[c]));
      return `(${columns.map((_, c) => `$${base + c + 1}`).join(", ")})`;
    });
    const sql = `INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(", ")}) VALUES ${placeholders.join(", ")} ${conflictDdl}`;
    const res = await client.query(sql, values);
    insertedTotal += res.rowCount;
  }
  return insertedTotal;
}

// Confirmed directly from the parsed EXIOBASE file's own 49-region index
// this session. isDirectMatch=true for the 44 named countries (the region
// code IS the country); false for the one Rest-of-World mapping seeded so
// far (AE -> WM, confirmed via direct research this session: WM = "Rest
// of World - Middle East", covers UAE, Saudi Arabia, Egypt, Israel).
// Extend with more RoW-member countries only when a real client needs one
// not yet listed here -- do not speculatively fill in the remaining ~145
// countries against unverified assumptions.
const NAMED_COUNTRIES = [
  ["AT", "Austria"], ["BE", "Belgium"], ["BG", "Bulgaria"], ["CY", "Cyprus"], ["CZ", "Czechia"],
  ["DE", "Germany"], ["DK", "Denmark"], ["EE", "Estonia"], ["ES", "Spain"], ["FI", "Finland"],
  ["FR", "France"], ["GR", "Greece"], ["HR", "Croatia"], ["HU", "Hungary"], ["IE", "Ireland"],
  ["IT", "Italy"], ["LT", "Lithuania"], ["LU", "Luxembourg"], ["LV", "Latvia"], ["MT", "Malta"],
  ["NL", "Netherlands"], ["PL", "Poland"], ["PT", "Portugal"], ["RO", "Romania"], ["SE", "Sweden"],
  ["SI", "Slovenia"], ["SK", "Slovakia"], ["GB", "United Kingdom"], ["US", "United States"],
  ["JP", "Japan"], ["CN", "China"], ["CA", "Canada"], ["KR", "South Korea"], ["BR", "Brazil"],
  ["IN", "India"], ["MX", "Mexico"], ["RU", "Russia"], ["AU", "Australia"], ["CH", "Switzerland"],
  ["TR", "Turkey"], ["TW", "Taiwan"], ["NO", "Norway"], ["ID", "Indonesia"], ["ZA", "South Africa"],
];

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // --- create the three tables (mirrors Task 1's shared/schema.ts exactly) ---

    await ensureTable(
      client,
      "epa_naics_factors",
      `CREATE TABLE IF NOT EXISTS epa_naics_factors (
        id SERIAL PRIMARY KEY,
        naics_code TEXT NOT NULL,
        naics_title TEXT NOT NULL,
        sef_kg_co2e_per_usd NUMERIC(20, 8) NOT NULL,
        mef_kg_co2e_per_usd NUMERIC(20, 8),
        sef_plus_mef_kg_co2e_per_usd NUMERIC(20, 8) NOT NULL,
        reference_useeio_code TEXT,
        factor_year INTEGER NOT NULL,
        source_dataset TEXT NOT NULL,
        source_url TEXT NOT NULL,
        retrieval_date TIMESTAMP NOT NULL,
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )`,
    );
    await ensureIndex(client, "epa_naics_factors_code_idx", `CREATE INDEX epa_naics_factors_code_idx ON epa_naics_factors (naics_code)`);

    await ensureTable(
      client,
      "exiobase_factors",
      `CREATE TABLE IF NOT EXISTS exiobase_factors (
        id SERIAL PRIMARY KEY,
        region TEXT NOT NULL,
        region_label TEXT NOT NULL,
        sector TEXT NOT NULL,
        table_type TEXT NOT NULL,
        kg_co2e_per_eur NUMERIC(20, 10) NOT NULL,
        factor_year INTEGER NOT NULL,
        exiobase_version TEXT NOT NULL,
        computed_at TIMESTAMP NOT NULL,
        source_url TEXT NOT NULL,
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )`,
    );
    await ensureIndex(client, "exiobase_factors_region_sector_idx", `CREATE INDEX exiobase_factors_region_sector_idx ON exiobase_factors (region, sector, table_type)`);
    await ensureIndex(client, "exiobase_factors_unique", `CREATE UNIQUE INDEX exiobase_factors_unique ON exiobase_factors (region, sector, table_type, factor_year)`);

    await ensureTable(
      client,
      "country_exiobase_regions",
      `CREATE TABLE IF NOT EXISTS country_exiobase_regions (
        id SERIAL PRIMARY KEY,
        country_code TEXT NOT NULL UNIQUE,
        country_name TEXT NOT NULL,
        exiobase_region TEXT NOT NULL,
        is_direct_match BOOLEAN NOT NULL
      )`,
    );

    // --- epa_naics_factors (public domain, no licensing gate) ---
    const epaRows = parseEpaCsv(join(__dirname, "..", "server", "assets", "epa-naics-factors-v1.3.0-2022.csv"));
    if ((await tableRowCount(client, "epa_naics_factors")) > 0) {
      skipped.push(`epa_naics_factors seed (${epaRows.length} rows -- table already populated)`);
    } else {
      const now = new Date().toISOString();
      const inserted = await bulkInsert(
        client,
        "epa_naics_factors",
        ["naics_code", "naics_title", "sef_kg_co2e_per_usd", "mef_kg_co2e_per_usd", "sef_plus_mef_kg_co2e_per_usd", "reference_useeio_code", "factor_year", "source_dataset", "source_url", "retrieval_date"],
        epaRows.map((r) => ({
          naics_code: r.naicsCode,
          naics_title: r.naicsTitle,
          sef_kg_co2e_per_usd: r.sefKgCo2ePerUsd,
          mef_kg_co2e_per_usd: r.mefKgCo2ePerUsd || null,
          sef_plus_mef_kg_co2e_per_usd: r.sefPlusMefKgCo2ePerUsd,
          reference_useeio_code: r.referenceUseeioCode || null,
          factor_year: 2022,
          source_dataset: "U.S. EPA Supply Chain GHG Emission Factors v1.3 by NAICS-6",
          source_url: "https://catalog.data.gov/dataset/supply-chain-greenhouse-gas-emission-factors-v1-3-by-naics-6",
          retrieval_date: now,
        })),
        "ON CONFLICT DO NOTHING",
      );
      applied.push(`epa_naics_factors seed: ${inserted} rows`);
    }

    // EXIOBASE v3.10.2 data. Non-commercial license only as of this
    // migration (see LICENSE.txt at https://zenodo.org/records/20051562)
    // -- explicitly excludes "any use by for-profit or commercial
    // entities" and "any use intended to generate revenue." User's
    // explicit decision (2026-09-02): build now, pre-revenue/
    // pre-customer; commercial license to be obtained from
    // exiobase-support@googlegroups.com before this product is sold.
    // Do not remove this comment until that license is confirmed in hand.
    if ((await tableRowCount(client, "exiobase_factors")) > 0) {
      skipped.push("exiobase_factors seed (table already populated)");
    } else {
      let total = 0;
      for (const tableType of ["pxp", "ixi"]) {
        const rows = JSON.parse(
          readFileSync(join(__dirname, "exiobase", "output", `exiobase_${tableType}_2022.json`), "utf-8"),
        );
        const now = new Date().toISOString();
        total += await bulkInsert(
          client,
          "exiobase_factors",
          ["region", "region_label", "sector", "table_type", "kg_co2e_per_eur", "factor_year", "exiobase_version", "computed_at", "source_url"],
          rows.map((r) => ({
            region: r.region,
            region_label: r.regionLabel,
            sector: r.sector,
            table_type: r.tableType,
            kg_co2e_per_eur: r.kgCo2ePerEur,
            factor_year: r.factorYear,
            exiobase_version: r.exiobaseVersion,
            computed_at: now,
            source_url: r.sourceUrl,
          })),
          "ON CONFLICT (region, sector, table_type, factor_year) DO NOTHING",
        );
      }
      applied.push(`exiobase_factors seed: ${total} rows`);
    }

    // --- country_exiobase_regions ---
    if ((await tableRowCount(client, "country_exiobase_regions")) > 0) {
      skipped.push("country_exiobase_regions seed (table already populated)");
    } else {
      const seedRows = [
        ...NAMED_COUNTRIES.map(([code, name]) => ({
          country_code: code, country_name: name, exiobase_region: code, is_direct_match: true,
        })),
        { country_code: "AE", country_name: "United Arab Emirates", exiobase_region: "WM", is_direct_match: false },
      ];
      const inserted = await bulkInsert(
        client,
        "country_exiobase_regions",
        ["country_code", "country_name", "exiobase_region", "is_direct_match"],
        seedRows,
        "ON CONFLICT (country_code) DO NOTHING",
      );
      applied.push(`country_exiobase_regions seed: ${inserted} rows`);
    }

    await client.query("COMMIT");

    console.log(`Applied ${applied.length} step(s):`);
    applied.forEach((s) => console.log(`  + ${s}`));
    console.log(`Skipped ${skipped.length}:`);
    skipped.forEach((s) => console.log(`  = ${s}`));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed, rolled back. No partial changes were applied.");
    console.error(err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
```

- [ ] **Step 2: Typecheck**

Run: `npm run check`
Expected: clean (this is a plain `.mjs` script, not typechecked directly, but confirms nothing else broke).

- [ ] **Step 3: Run the migration against the live Neon DB**

Run: `node scripts/manual-migration-010.mjs`
Expected: `Applied 9 step(s)` (3 `CREATE TABLE`, 3 index/unique-constraint creations, 3 seeds) on first run, reporting `epa_naics_factors seed: 1016 rows`, `exiobase_factors seed: 17787 rows`, `country_exiobase_regions seed: 45 rows`.

- [ ] **Step 4: Confirm idempotency**

Run: `node scripts/manual-migration-010.mjs` a second time.
Expected: `Applied 0 step(s)`, `Skipped 9` — every table, index, and seed step reports "already exists"/"already populated". This is the same idempotency guarantee every prior migration in this project provides; a second run must never duplicate rows or error.

- [ ] **Step 5: Spot-check real values in the database**

```bash
psql "$DATABASE_URL" -c "
SELECT naics_code, naics_title, sef_plus_mef_kg_co2e_per_usd FROM epa_naics_factors WHERE naics_code = '111110';
SELECT region, sector, table_type, kg_co2e_per_eur FROM exiobase_factors WHERE region = 'WM' AND sector = 'Cultivation of wheat' AND table_type = 'ixi';
SELECT country_code, exiobase_region, is_direct_match FROM country_exiobase_regions WHERE country_code = 'AE';
"
```

Expected: `0.532` for the EPA soybean row, `0.734812` for the WM/wheat/ixi row (matching Task 2 Step 3's already-verified figure), `AE | WM | f` for the UAE row.

- [ ] **Step 6: Commit**

```bash
git add scripts/manual-migration-010.mjs
git commit -m "feat: migrate + seed the Scope 3 factor library (EPA NAICS-6, EXIOBASE, country-region lookup)"
```

---

## Self-Review Notes

- **Spec coverage**: all three tables from the spec's Data Model section are covered (Task 1); the offline pipeline with its unit-assertion and GWP-sourcing constraints is covered (Task 2); the licensing comment requirement is covered verbatim in both Task 2 and Task 4; the EPA public-domain finding (from this session's own research, not in the original spec) is recorded as a Global Constraint rather than silently assumed.
- **Type consistency**: `EpaNaicsFactor`/`ExiobaseFactor`/`CountryExiobaseRegion` types from Task 1 aren't consumed by any code in this plan (no later-phase code exists yet) — they exist for the next spec (spend-mapping workflow) to import, per the spec's explicit phasing.
- **Scope check**: intentionally does not touch the mapping workflow, search tool, calculation/tiering, or any UI — those remain separate specs per the design doc's own "Explicitly out of scope" section.
