// scripts/manual-migration-011.mjs
//
// Fixes two structural problems found by the scope3-data-quality branch's
// whole-branch review (see
// .superpowers/sdd/2026-09-02-scope3-factor-library/progress.md and
// final-review-fix-report.md for the full findings):
//
//   1. exiobase_factors.kg_co2e_per_eur was NOT NULL, forcing every
//      region-sector cell whose EXIOBASE total output is zero (a
//      mathematically undefined 0/0 multiplier, not "zero emissions") to be
//      stored as a computed 0.0 -- indistinguishable from a real low-carbon
//      factor. Drops the NOT NULL constraint so
//      scripts/exiobase/build_factors.py can emit `null` for those cells
//      and scripts/manual-migration-010.mjs can insert it as SQL NULL.
//
//   2. gwp_values only carried the 4 gases Stationary Combustion needed
//      (CO2, CH4 fossil, CH4 non-fossil, N2O). build_factors.py's original
//      EXIOBASE multiplier only summed the 4 corresponding "- combustion -"
//      stressor rows in air_emissions, leaving out ~21 other GHG-bearing
//      rows (non-combustion fugitive CH4, process CO2, N2O_bio, SF6, HFC,
//      PFC, agriculture, waste) -- capturing only ~70% of true GHG mass.
//      Fixing that requires one more gas's GWP-100 weight beyond the
//      original 4: SF6. (HFC and PFC are summed at weight 1 directly, not
//      via a gwp_values row -- EXIOBASE's air_emissions/unit.txt reports
//      both already in "kg CO2-eq", a single pre-aggregated figure across
//      unspecified F-gas species, not a raw mass in kg of one named gas; a
//      gwp_values row implies one chemical species with one GWP-100 value,
//      which would misrepresent what these two rows actually are. N2O_bio
//      reuses the existing "N2O" row -- the source xlsx
//      (client/public/gwp-ar6-reference.xlsx) publishes a single N2O
//      GWP-100 value with no fossil/non-fossil split, unlike CH4.)
//
// Sourced from client/public/gwp-ar6-reference.xlsx, sheet "GWP-100
// (AR4-AR6)", Chemical Formula "SF6" row: AR6 GWP-100 = 24300. Same
// GWP_SOURCE citation already used for the other 4 rows in
// manual-migration-006.mjs.
//
// Also exports scripts/exiobase/gwp_weights.json -- a JSON snapshot of the
// gwp_values rows build_factors.py's GHG-stressor summation needs, read
// FROM the live table (never hand-typed into the Python script) so the
// Global Constraint "GWP weights must be sourced from this app's own
// gwpValues table, not re-typed" is structurally true. Re-derived from a
// live query on every run and only rewritten if its content actually
// differs from what's already on disk (compared byte-for-byte before
// writing) -- so it stays a true no-op on a repeat run against an
// unchanged table, while still self-healing if gwp_values ever changes
// without this file being regenerated.
//
// Idempotent in the same way as every prior manual migration in this
// project: information_schema/pg_constraint checks before any DDL change,
// ON CONFLICT ... DO NOTHING for the seed row. Wrapped in one transaction.
//
// Usage: node scripts/manual-migration-011.mjs

import "dotenv/config";
import { Pool } from "pg";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL not set. Run this from the project folder with .env filled in.");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const applied = [];
const skipped = [];

async function seed(client, label, sql, params) {
  const res = await client.query(sql, params);
  if (res.rowCount > 0) {
    applied.push(`seed: inserted ${label}`);
  } else {
    skipped.push(`seed: ${label} (already present)`);
  }
}

// Same citation manual-migration-006.mjs already uses for the other 4
// gwp_values rows -- not re-derived, same source.
const GWP_SOURCE =
  "GHG Protocol, 'IPCC Global Warming Potential Values', Version 2.0, August 7, 2024 (adapted from IPCC AR6, 2021)";
const GWP_SOURCE_URL =
  "https://ghgprotocol.org/sites/default/files/2024-08/Global-Warming-Potential-Values%20(August%202024).pdf";

// Verified directly against client/public/gwp-ar6-reference.xlsx this
// session: sheet "GWP-100 (AR4-AR6)", row ('Major Greenhouse Gases',
// 'Sulfur hexafluoride', 'SF6', 22800, 23500, 24300) -- AR6 column = 24300.
const newGwpRows = [{ gas: "SF6", formula: "SF6", gwpValue: 24300, gwpVersion: "AR6" }];

// The full set of gwp_values rows build_factors.py's GHG-stressor
// summation needs -- exported to JSON below so the Python script reads
// live-table values rather than a hardcoded dict.
const GASES_FOR_EXIOBASE = ["CO2", "CH4 (fossil)", "CH4 (non-fossil)", "N2O", "SF6"];

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // --- 1. exiobase_factors.kg_co2e_per_eur: drop NOT NULL ---
    const colRes = await client.query(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'exiobase_factors' AND column_name = 'kg_co2e_per_eur'`,
    );
    if (colRes.rowCount === 0) {
      throw new Error("exiobase_factors.kg_co2e_per_eur column not found -- has manual-migration-010.mjs run yet?");
    }
    if (colRes.rows[0].is_nullable === "YES") {
      skipped.push("exiobase_factors.kg_co2e_per_eur (already nullable)");
    } else {
      await client.query(`ALTER TABLE exiobase_factors ALTER COLUMN kg_co2e_per_eur DROP NOT NULL`);
      applied.push("ALTER TABLE exiobase_factors ALTER COLUMN kg_co2e_per_eur DROP NOT NULL");
    }

    // --- 2. gwp_values: seed SF6 ---
    for (const row of newGwpRows) {
      await seed(
        client,
        `gwp_values.gas = '${row.gas}' (${row.gwpVersion})`,
        `INSERT INTO gwp_values (gas, formula, gwp_value, gwp_version, gwp_source)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (gas, gwp_version) DO NOTHING`,
        [row.gas, row.formula, row.gwpValue, row.gwpVersion, `${GWP_SOURCE} -- ${GWP_SOURCE_URL}`],
      );
    }

    await client.query("COMMIT");

    // --- 3. export gwp_weights.json for build_factors.py (unconditional, no side effect on DB) ---
    const gwpRes = await client.query(
      `SELECT gas, formula, gwp_value, gwp_version, gwp_source FROM gwp_values WHERE gas = ANY($1) AND gwp_version = 'AR6'`,
      [GASES_FOR_EXIOBASE],
    );
    const missingGases = GASES_FOR_EXIOBASE.filter((g) => !gwpRes.rows.some((r) => r.gas === g));
    if (missingGases.length > 0) {
      throw new Error(`gwp_values is missing AR6 rows for: ${missingGases.join(", ")} -- cannot export gwp_weights.json`);
    }
    const weights = {};
    for (const row of gwpRes.rows) {
      weights[row.gas] = {
        gwpValue: Number(row.gwp_value),
        formula: row.formula,
        gwpVersion: row.gwp_version,
        gwpSource: row.gwp_source,
      };
    }
    const outPath = join(__dirname, "exiobase", "gwp_weights.json");
    const newContent = JSON.stringify(weights, null, 2);
    const existingContent = existsSync(outPath) ? readFileSync(outPath, "utf-8") : null;
    if (existingContent === newContent) {
      skipped.push(`gwp_weights.json export (${outPath} already matches the live gwp_values table)`);
    } else {
      writeFileSync(outPath, newContent);
      applied.push(`exported ${outPath} (${Object.keys(weights).length} gases, live-queried from gwp_values, not hand-typed)`);
    }

    console.log(`Applied ${applied.length} step(s):`);
    applied.forEach((s) => console.log(`  + ${s}`));
    console.log(`Skipped ${skipped.length}:`);
    skipped.forEach((s) => console.log(`  = ${s}`));
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error("ROLLBACK itself failed:", rollbackErr);
    }
    console.error("Migration failed, rolled back. No partial changes were applied.");
    console.error(err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
