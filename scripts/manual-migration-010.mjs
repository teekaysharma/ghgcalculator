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
  // Split on CRLF or bare LF -- this source file uses CRLF line endings
  // throughout (confirmed: 1,017 "\r\n" sequences, one per line, zero bare
  // "\r"). Splitting on "\n" alone previously left a trailing "\r" on the
  // last field of every row (reference_useeio_code), e.g. "1111A0\r"
  // instead of "1111A0". Bug found by code review 2026-09-02, confirmed
  // live against NAICS 111110's seeded row; fixed here.
  const lines = text.split(/\r\n|\n/).filter((l) => l.trim().length > 0);
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

    // --- correction: strip stray trailing \r from reference_useeio_code ---
    // Bug found by code review 2026-09-02: the source CSV uses CRLF line
    // endings; parseEpaCsv originally split on "\n" only, leaving a
    // trailing "\r" on the last field of every row (reference_useeio_code).
    // Fixed in parseEpaCsv above, but that fix alone doesn't heal rows
    // already seeded into the live DB before the fix landed (the seed step
    // itself is skip-if-populated and won't re-run). This correction runs
    // unconditionally on every execution -- a harmless no-op once the data
    // is clean -- so the fix is baked into the reproducible migration
    // artifact rather than a one-off manual DB edit outside it.
    const correctionRes = await client.query(
      `UPDATE epa_naics_factors SET reference_useeio_code = TRIM(TRAILING E'\r' FROM reference_useeio_code) WHERE reference_useeio_code LIKE '%' || E'\r'`,
    );
    if (correctionRes.rowCount > 0) {
      applied.push(`epa_naics_factors correction: stripped trailing \\r from ${correctionRes.rowCount} rows`);
    } else {
      skipped.push("epa_naics_factors correction (no rows had a trailing \\r)");
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
