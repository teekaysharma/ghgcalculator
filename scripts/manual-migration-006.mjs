// scripts/manual-migration-006.mjs
//
// Additive pass, following the conventions of manual-migration-002/003/004/005.mjs.
// This migration:
//   1. Adds two columns to ipcc_default_factors: sector (NOT NULL, 'all' for
//      sector-independent factors) and gas_type (NOT NULL, 'CO2'|'CH4'|'N2O').
//      Reason: ISO/TS 14064-4 requires GHG emissions to be quantified PER
//      GAS (quantity_i * GWP_i, summed), with the GWP source/version
//      disclosed as a distinct step -- not silently pre-combined into one
//      opaque CO2e number at the data layer. `factor` therefore always holds
//      the gas-NATIVE default factor (e.g. kg CH4/TJ fuel), never a
//      GWP-weighted value. See shared/schema.ts ipccDefaultFactors comment.
//   2. Creates gwp_values, a small queryable promotion of the AR6 GWP-100
//      figures already verified in client/public/gwp-ar6-reference.xlsx, so
//      the calculation engine applies GWP as a distinct, disclosed step
//      rather than a hardcoded constant. Only the 4 gases Stationary
//      Combustion needs are seeded (CO2, CH4 fossil, CH4 non-fossil, N2O) --
//      the xlsx has all 266 AR6 gases; the rest is a later pass.
//   3. Adds emission_records.gas_breakdown (nullable JSONB) -- the audit
//      trail for calculations built from a per-gas factor bundle, so the
//      ISO/TS 14064-4 per-gas quantification is reconstructable from the
//      stored record itself.
//   4. Seeds ipcc_default_factors with real, sourced Stationary Combustion
//      data for 11 commonly-reported fuels x 4 IPCC sectors (Energy
//      Industries / Manufacturing & Construction / Commercial &
//      Institutional / Residential & Agriculture-Forestry-Fishing):
//        - CO2 factors: 2006 IPCC Guidelines Vol.2 Ch.1 (Introduction),
//          Table 1.4 -- sector-independent, one row per fuel (sector='all').
//        - CH4/N2O factors: 2006 IPCC Guidelines Vol.2 Ch.2 (Stationary
//          Combustion), Tables 2.2/2.3/2.4/2.5 -- one row per fuel per
//          sector per gas.
//      All values transcribed verbatim from the source PDFs (indexed in the
//      project's RAG, content-verified chunk by chunk -- not the "2019
//      Refinement" stub that was initially and mistakenly recommended
//      earlier this session; these are the real 2006-original tables).
//      Deliberately scoped to 11 fuels (natural gas, motor gasoline,
//      jet/other kerosene, gas/diesel oil, residual fuel oil, LPG, and the
//      5 main coal types) rather than the full ~40-fuel IPCC list -- these
//      are the fuels an MVP-stage reporting org is actually likely to use;
//      the rest (biomass, waste, derived/refinery gases, etc.) can be added
//      in a later pass following this exact pattern.
//
// See shared/schema.ts (ipccDefaultFactors, gwpValues, emissionRecordsTable)
// for the Drizzle-side source of truth this migration brings the live
// database in line with.
//
// Idempotent in the same way as prior manual migrations: every helper checks
// information_schema/pg_constraint before doing anything, and every seed
// row is inserted with ON CONFLICT ... DO NOTHING against a real unique
// index, so this script is safe to run repeatedly and safe if a previous
// run got partway through before failing. Wrapped in one transaction
// (BEGIN/COMMIT, ROLLBACK on error), same as prior manual migrations.
//
// Usage: node scripts/manual-migration-006.mjs

import "dotenv/config";
import { Pool } from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL not set. Run this from the project folder with .env filled in.");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const applied = [];
const skipped = [];

async function columnExists(client, table, column) {
  const res = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return res.rowCount > 0;
}

async function tableExists(client, table) {
  const res = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return res.rowCount > 0;
}

async function indexExists(client, name) {
  const res = await client.query(`SELECT 1 FROM pg_class WHERE relname = $1`, [name]);
  return res.rowCount > 0;
}

async function ensureColumn(client, table, column, addColumnDdl) {
  if (await columnExists(client, table, column)) {
    skipped.push(`column ${table}.${column} (already exists)`);
    return;
  }
  await client.query(`ALTER TABLE ${table} ADD COLUMN ${addColumnDdl}`);
  applied.push(`ALTER TABLE ${table} ADD COLUMN ${addColumnDdl}`);
}

async function ensureTable(client, table, createDdl) {
  if (await tableExists(client, table)) {
    skipped.push(`table ${table} (already exists)`);
    return;
  }
  await client.query(createDdl);
  applied.push(`CREATE TABLE ${table}`);
}

async function ensureIndex(client, name, ddl) {
  if (await indexExists(client, name)) {
    skipped.push(`index ${name} (already exists)`);
    return;
  }
  await client.query(ddl);
  applied.push(ddl);
}

async function seed(client, label, sql, params) {
  const res = await client.query(sql, params);
  if (res.rowCount > 0) {
    applied.push(`seed: inserted ${label}`);
  } else {
    skipped.push(`seed: ${label} (already present)`);
  }
}

// ---------------------------------------------------------------------------
// GWP-100 AR6 values needed for Stationary Combustion, promoted from
// client/public/gwp-ar6-reference.xlsx (sheet "GWP-100 (AR4-AR6)", verified
// against the official GHG Protocol / IPCC AR6 WG1 Ch.7 SS7.6.1.1 source PDF).
// ---------------------------------------------------------------------------
const GWP_SOURCE =
  "GHG Protocol, 'IPCC Global Warming Potential Values', Version 2.0, August 7, 2024 (adapted from IPCC AR6, 2021)";
const GWP_SOURCE_URL =
  "https://ghgprotocol.org/sites/default/files/2024-08/Global-Warming-Potential-Values%20(August%202024).pdf";

const gwpRows = [
  { gas: "CO2", formula: "CO2", gwpValue: 1, gwpVersion: "AR6" },
  { gas: "CH4 (fossil)", formula: "CH4", gwpValue: 29.8, gwpVersion: "AR6" },
  { gas: "CH4 (non-fossil)", formula: "CH4", gwpValue: 27, gwpVersion: "AR6" },
  { gas: "N2O", formula: "N2O", gwpValue: 273, gwpVersion: "AR6" },
];

// ---------------------------------------------------------------------------
// Stationary Combustion default factors.
//
// co2 (kg CO2/TJ): 2006 IPCC Guidelines Vol.2 Ch.1 (Introduction), Table 1.4.
//   Sector-independent -- same value regardless of which sector burns the
//   fuel (the CO2 factor depends only on fuel carbon content).
//
// class: 'gas' | 'liquid' | 'solid' -- which row-group of Tables 2.2-2.5 this
//   fuel's CH4/N2O factors come from (IPCC groups fuels this way in each
//   sector table, and LPG/Ethane/Refinery Gas are grouped with the GASEOUS
//   rows in those tables despite being liquid-state fuels commercially).
//
// Source URLs (same for every row in a table):
//   Table 1.4: https://www.ipcc-nggip.iges.or.jp/public/2006gl/pdf/2_Volume2/V2_1_Ch1_Introduction.pdf
//   Tables 2.2-2.5: https://www.ipcc-nggip.iges.or.jp/public/2006gl/pdf/2_Volume2/V2_2_Ch2_Stationary_Combustion.pdf
// ---------------------------------------------------------------------------
const CO2_SOURCE_DOC = "2006 IPCC Guidelines for National GHG Inventories, Vol.2 Ch.1 (Introduction), Table 1.4";
const CO2_SOURCE_URL = "https://www.ipcc-nggip.iges.or.jp/public/2006gl/pdf/2_Volume2/V2_1_Ch1_Introduction.pdf";
const STATIONARY_SOURCE_URL =
  "https://www.ipcc-nggip.iges.or.jp/public/2006gl/pdf/2_Volume2/V2_2_Ch2_Stationary_Combustion.pdf";

const fuels = [
  { activityType: "Natural Gas", class: "gas", co2: 56100 },
  { activityType: "Motor Gasoline", class: "liquid", co2: 69300 },
  { activityType: "Jet Kerosene", class: "liquid", co2: 71500 },
  { activityType: "Other Kerosene", class: "liquid", co2: 71900 },
  { activityType: "Gas/Diesel Oil", class: "liquid", co2: 74100 },
  { activityType: "Residual Fuel Oil", class: "liquid", co2: 77400 },
  { activityType: "Liquefied Petroleum Gases", class: "gas", co2: 63100 },
  { activityType: "Anthracite", class: "solid", co2: 98300 },
  { activityType: "Coking Coal", class: "solid", co2: 94600 },
  { activityType: "Other Bituminous Coal", class: "solid", co2: 94600 },
  { activityType: "Sub-Bituminous Coal", class: "solid", co2: 96100 },
  { activityType: "Lignite", class: "solid", co2: 101000 },
];

// Per-sector CH4/N2O (kg/TJ) by fuel class, transcribed from Tables 2.2-2.5.
const sectors = [
  {
    name: "Energy Industries",
    tableRef: "Table 2.2",
    factors: {
      gas: { ch4: 1, n2o: 0.1 },
      liquid: { ch4: 3, n2o: 0.6 },
      solid: { ch4: 1, n2o: 1.5 },
    },
  },
  {
    name: "Manufacturing Industries and Construction",
    tableRef: "Table 2.3",
    factors: {
      gas: { ch4: 1, n2o: 0.1 },
      liquid: { ch4: 3, n2o: 0.6 },
      solid: { ch4: 10, n2o: 1.5 },
    },
  },
  {
    name: "Commercial/Institutional",
    tableRef: "Table 2.4",
    factors: {
      gas: { ch4: 5, n2o: 0.1 },
      liquid: { ch4: 10, n2o: 0.6 },
      solid: { ch4: 10, n2o: 1.5 },
    },
  },
  {
    name: "Residential and Agriculture/Forestry/Fishing",
    tableRef: "Table 2.5",
    factors: {
      gas: { ch4: 5, n2o: 0.1 },
      liquid: { ch4: 10, n2o: 0.6 },
      solid: { ch4: 300, n2o: 1.5 },
    },
  },
];

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // -----------------------------------------------------------------
    // ipcc_default_factors -- sector + gas_type columns
    // -----------------------------------------------------------------
    await ensureColumn(client, "ipcc_default_factors", "sector", "sector TEXT NOT NULL DEFAULT 'all'");
    await ensureColumn(client, "ipcc_default_factors", "gas_type", "gas_type TEXT NOT NULL DEFAULT 'CO2'");
    // Defaults above exist only so the ALTER succeeds against a table that
    // may already have rows from a prior partial run; every row this
    // migration inserts sets both explicitly. Drop the defaults so future
    // inserts (app-level) are forced to be explicit too, matching
    // shared/schema.ts (no default there).
    await client.query(`ALTER TABLE ipcc_default_factors ALTER COLUMN sector DROP DEFAULT`);
    await client.query(`ALTER TABLE ipcc_default_factors ALTER COLUMN gas_type DROP DEFAULT`);

    await ensureIndex(
      client,
      "ipcc_default_factors_category_activity_sector_gas_idx",
      `CREATE UNIQUE INDEX ipcc_default_factors_category_activity_sector_gas_idx
       ON ipcc_default_factors (category, activity_type, sector, gas_type)`,
    );

    // -----------------------------------------------------------------
    // gwp_values -- new global reference table
    // -----------------------------------------------------------------
    await ensureTable(
      client,
      "gwp_values",
      `CREATE TABLE IF NOT EXISTS gwp_values (
        id SERIAL PRIMARY KEY,
        gas TEXT NOT NULL,
        formula TEXT,
        gwp_value NUMERIC(12, 4) NOT NULL,
        gwp_version TEXT NOT NULL,
        gwp_source TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )`,
    );
    await ensureIndex(
      client,
      "gwp_values_gas_version_idx",
      `CREATE UNIQUE INDEX gwp_values_gas_version_idx ON gwp_values (gas, gwp_version)`,
    );

    // -----------------------------------------------------------------
    // emission_records -- per-gas audit trail column
    // -----------------------------------------------------------------
    await ensureColumn(client, "emission_records", "gas_breakdown", "gas_breakdown JSONB");

    // -----------------------------------------------------------------
    // Seed gwp_values
    // -----------------------------------------------------------------
    for (const row of gwpRows) {
      await seed(
        client,
        `gwp_values.gas = '${row.gas}' (${row.gwpVersion})`,
        `INSERT INTO gwp_values (gas, formula, gwp_value, gwp_version, gwp_source)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (gas, gwp_version) DO NOTHING`,
        [row.gas, row.formula, row.gwpValue, row.gwpVersion, `${GWP_SOURCE} -- ${GWP_SOURCE_URL}`],
      );
    }

    // -----------------------------------------------------------------
    // Seed ipcc_default_factors -- Stationary Combustion
    // -----------------------------------------------------------------
    const CATEGORY = "Stationary Combustion";

    // CO2 -- one row per fuel, sector-independent
    for (const fuel of fuels) {
      await seed(
        client,
        `ipcc_default_factors CO2 / ${fuel.activityType} / all`,
        `INSERT INTO ipcc_default_factors
           (category, activity_type, sector, gas_type, unit, factor, scope, source_document, source_url, notes)
         VALUES ($1, $2, 'all', 'CO2', 'TJ', $3, 'scope1', $4, $5, $6)
         ON CONFLICT (category, activity_type, sector, gas_type) DO NOTHING`,
        [
          CATEGORY,
          fuel.activityType,
          fuel.co2,
          CO2_SOURCE_DOC,
          CO2_SOURCE_URL,
          "kg CO2 per TJ fuel (Net Calorific Value basis). Sector-independent -- Table 1.4 applies regardless of which sector burns the fuel.",
        ],
      );
    }

    // CH4 / N2O -- one row per fuel per sector
    for (const sector of sectors) {
      for (const fuel of fuels) {
        const { ch4, n2o } = sector.factors[fuel.class];
        const sourceDoc = `2006 IPCC Guidelines for National GHG Inventories, Vol.2 Ch.2 (Stationary Combustion), ${sector.tableRef} (${sector.name})`;

        await seed(
          client,
          `ipcc_default_factors CH4 / ${fuel.activityType} / ${sector.name}`,
          `INSERT INTO ipcc_default_factors
             (category, activity_type, sector, gas_type, unit, factor, scope, source_document, source_url, notes)
           VALUES ($1, $2, $3, 'CH4', 'TJ', $4, 'scope1', $5, $6, $7)
           ON CONFLICT (category, activity_type, sector, gas_type) DO NOTHING`,
          [
            CATEGORY,
            fuel.activityType,
            sector.name,
            ch4,
            sourceDoc,
            STATIONARY_SOURCE_URL,
            `kg CH4 per TJ fuel (Net Calorific Value basis), ${sector.name} sector. Use with gwp_values 'CH4 (fossil)' for these fossil fuels.`,
          ],
        );

        await seed(
          client,
          `ipcc_default_factors N2O / ${fuel.activityType} / ${sector.name}`,
          `INSERT INTO ipcc_default_factors
             (category, activity_type, sector, gas_type, unit, factor, scope, source_document, source_url, notes)
           VALUES ($1, $2, $3, 'N2O', 'TJ', $4, 'scope1', $5, $6, $7)
           ON CONFLICT (category, activity_type, sector, gas_type) DO NOTHING`,
          [
            CATEGORY,
            fuel.activityType,
            sector.name,
            n2o,
            sourceDoc,
            STATIONARY_SOURCE_URL,
            `kg N2O per TJ fuel (Net Calorific Value basis), ${sector.name} sector.`,
          ],
        );
      }
    }

    await client.query("COMMIT");

    console.log(`Applied ${applied.length} statement(s):`);
    applied.forEach((s) => console.log(`  + ${s}`));
    console.log(`Skipped ${skipped.length} (already present):`);
    skipped.forEach((s) => console.log(`  = ${s}`));
    console.log(
      `\ngwp_values seeded with ${gwpRows.length} rows. ipcc_default_factors seeded with real Stationary Combustion data: ` +
        `${fuels.length} CO2 rows + ${fuels.length * sectors.length * 2} CH4/N2O rows (${fuels.length} fuels x ${sectors.length} sectors x 2 gases).`,
    );
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
