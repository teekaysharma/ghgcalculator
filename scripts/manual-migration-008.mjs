// scripts/manual-migration-008.mjs
//
// Additive pass, following the conventions of manual-migration-002 through
// 007.mjs. This migration:
//   1. Adds ipcc_default_factors.net_calorific_value (nullable numeric,
//      TJ/Gg == GJ/tonne) and backfills it on the 12 already-seeded fossil
//      fuels' CO2 rows (sector='all') using the real published values from
//      2006 IPCC Guidelines Vol.2 Ch.1 (Introduction), Table 1.2.
//   2. Seeds 11 real, sourced biogenic fuels into ipcc_default_factors
//      (isBiogenic=true), same category "Stationary Combustion", same
//      4-sector x CO2/CH4/N2O structure as the fossil fuels seeded in
//      manual-migration-006.mjs: Wood/Wood Waste, Charcoal, Biogasoline,
//      Biodiesels, Other Liquid Biofuels, Landfill Gas, Sludge Gas, Other
//      Biogas, Municipal Wastes (biomass fraction), Other Primary Solid
//      Biomass, Sulphite Lyes (Black Liquor). Values transcribed verbatim
//      from the same source PDFs (2006 IPCC Guidelines Vol.2 Ch.1 Table 1.4
//      for CO2, Ch.2 Tables 2.2-2.5 for CH4/N2O), content-verified
//      chunk-by-chunk in the project's RAG, same as manual-migration-006.mjs.
//
//      Peat is deliberately NOT included, despite appearing in the same
//      source tables' biomass section -- 2006 IPCC Guidelines Vol.2 Ch.1
//      (Introduction) explicitly states "peat is treated as a fossil fuel
//      and not a biofuel" (informational-item CO2 accounting note), so
//      marking it isBiogenic would misclassify it.
//
// See shared/schema.ts (ipccDefaultFactors.netCalorificValue) for the
// Drizzle-side source of truth this migration brings the live database in
// line with.
//
// Idempotent: every helper checks information_schema/existing rows before
// doing anything, safe to run repeatedly and safe if a previous run got
// partway through before failing. Wrapped in one transaction (BEGIN/COMMIT,
// ROLLBACK on error).
//
// Usage: node scripts/manual-migration-008.mjs

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

async function ensureColumn(client, table, column, addColumnDdl) {
  if (await columnExists(client, table, column)) {
    skipped.push(`column ${table}.${column} (already exists)`);
    return;
  }
  await client.query(`ALTER TABLE ${table} ADD COLUMN ${addColumnDdl}`);
  applied.push(`ALTER TABLE ${table} ADD COLUMN ${addColumnDdl}`);
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
// NCV backfill for the 12 fossil fuels already seeded by manual-migration-006.mjs.
// Source: 2006 IPCC Guidelines Vol.2 Ch.1 (Introduction), Table 1.2 (TJ/Gg).
// ---------------------------------------------------------------------------
const NCV_SOURCE_URL = "https://www.ipcc-nggip.iges.or.jp/public/2006gl/pdf/2_Volume2/V2_1_Ch1_Introduction.pdf";

const ncvByFuel = {
  "Natural Gas": 48.0,
  "Motor Gasoline": 44.3,
  "Jet Kerosene": 44.1,
  "Other Kerosene": 43.8,
  "Gas/Diesel Oil": 43.0,
  "Residual Fuel Oil": 40.4,
  "Liquefied Petroleum Gases": 47.3,
  Anthracite: 26.7,
  "Coking Coal": 28.2,
  "Other Bituminous Coal": 25.8,
  "Sub-Bituminous Coal": 18.9,
  Lignite: 11.9,
};

// ---------------------------------------------------------------------------
// Biogenic fuels. co2 (kg CO2/TJ) is sector-independent (matches the source
// tables: identical value in every sector table for a given fuel). CH4/N2O
// (kg/TJ) vary by sector -- transcribed per-fuel per-sector below, since
// (unlike the fossil fuels' clean gas/liquid/solid class pattern) biogenic
// fuels each have their own explicit row in every sector table rather than
// falling into a shared per-class default.
// ---------------------------------------------------------------------------
const CO2_SOURCE_DOC = "2006 IPCC Guidelines for National GHG Inventories, Vol.2 Ch.1 (Introduction), Table 1.4";
const CO2_SOURCE_URL = "https://www.ipcc-nggip.iges.or.jp/public/2006gl/pdf/2_Volume2/V2_1_Ch1_Introduction.pdf";
const STATIONARY_SOURCE_URL =
  "https://www.ipcc-nggip.iges.or.jp/public/2006gl/pdf/2_Volume2/V2_2_Ch2_Stationary_Combustion.pdf";

const biogenicFuels = [
  { activityType: "Wood/Wood Waste", co2: 112000 },
  { activityType: "Charcoal", co2: 112000 },
  { activityType: "Biogasoline", co2: 70800 },
  { activityType: "Biodiesels", co2: 70800 },
  { activityType: "Other Liquid Biofuels", co2: 79600 },
  { activityType: "Landfill Gas", co2: 54600 },
  { activityType: "Sludge Gas", co2: 54600 },
  { activityType: "Other Biogas", co2: 54600 },
  { activityType: "Municipal Wastes (biomass fraction)", co2: 100000 },
  { activityType: "Other Primary Solid Biomass", co2: 100000 },
  { activityType: "Sulphite Lyes (Black Liquor)", co2: 95300 },
];

// Per-sector CH4/N2O (kg/TJ), transcribed per-fuel from Tables 2.2-2.5.
// Sector name strings match manual-migration-006.mjs exactly (reused as the
// consolidated-report rollup's grouping key).
const biogenicSectorFactors = {
  "Energy Industries": {
    "Wood/Wood Waste": { ch4: 30, n2o: 4 },
    Charcoal: { ch4: 200, n2o: 4 },
    Biogasoline: { ch4: 3, n2o: 0.6 },
    Biodiesels: { ch4: 3, n2o: 0.6 },
    "Other Liquid Biofuels": { ch4: 3, n2o: 0.6 },
    "Landfill Gas": { ch4: 1, n2o: 0.1 },
    "Sludge Gas": { ch4: 1, n2o: 0.1 },
    "Other Biogas": { ch4: 1, n2o: 0.1 },
    "Municipal Wastes (biomass fraction)": { ch4: 30, n2o: 4 },
    "Other Primary Solid Biomass": { ch4: 30, n2o: 4 },
    "Sulphite Lyes (Black Liquor)": { ch4: 3, n2o: 2 },
  },
  "Manufacturing Industries and Construction": {
    "Wood/Wood Waste": { ch4: 30, n2o: 4 },
    Charcoal: { ch4: 200, n2o: 4 },
    Biogasoline: { ch4: 3, n2o: 0.6 },
    Biodiesels: { ch4: 3, n2o: 0.6 },
    "Other Liquid Biofuels": { ch4: 3, n2o: 0.6 },
    "Landfill Gas": { ch4: 1, n2o: 0.1 },
    "Sludge Gas": { ch4: 1, n2o: 0.1 },
    "Other Biogas": { ch4: 1, n2o: 0.1 },
    "Municipal Wastes (biomass fraction)": { ch4: 30, n2o: 4 },
    "Other Primary Solid Biomass": { ch4: 30, n2o: 4 },
    "Sulphite Lyes (Black Liquor)": { ch4: 3, n2o: 2 },
  },
  "Commercial/Institutional": {
    "Wood/Wood Waste": { ch4: 300, n2o: 4 },
    Charcoal: { ch4: 200, n2o: 1 },
    Biogasoline: { ch4: 10, n2o: 0.6 },
    Biodiesels: { ch4: 10, n2o: 0.6 },
    "Other Liquid Biofuels": { ch4: 10, n2o: 0.6 },
    "Landfill Gas": { ch4: 5, n2o: 0.1 },
    "Sludge Gas": { ch4: 5, n2o: 0.1 },
    "Other Biogas": { ch4: 5, n2o: 0.1 },
    "Municipal Wastes (biomass fraction)": { ch4: 300, n2o: 4 },
    "Other Primary Solid Biomass": { ch4: 300, n2o: 4 },
    "Sulphite Lyes (Black Liquor)": { ch4: 3, n2o: 2 },
  },
  "Residential and Agriculture/Forestry/Fishing": {
    "Wood/Wood Waste": { ch4: 300, n2o: 4 },
    Charcoal: { ch4: 200, n2o: 1 },
    Biogasoline: { ch4: 10, n2o: 0.6 },
    Biodiesels: { ch4: 10, n2o: 0.6 },
    "Other Liquid Biofuels": { ch4: 10, n2o: 0.6 },
    "Landfill Gas": { ch4: 5, n2o: 0.1 },
    "Sludge Gas": { ch4: 5, n2o: 0.1 },
    "Other Biogas": { ch4: 5, n2o: 0.1 },
    "Municipal Wastes (biomass fraction)": { ch4: 300, n2o: 4 },
    "Other Primary Solid Biomass": { ch4: 300, n2o: 4 },
    "Sulphite Lyes (Black Liquor)": { ch4: 3, n2o: 2 },
  },
};

const sectorTableRefs = {
  "Energy Industries": "Table 2.2",
  "Manufacturing Industries and Construction": "Table 2.3",
  "Commercial/Institutional": "Table 2.4",
  "Residential and Agriculture/Forestry/Fishing": "Table 2.5",
};

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // -----------------------------------------------------------------
    // ipcc_default_factors -- net_calorific_value column
    // -----------------------------------------------------------------
    await ensureColumn(
      client,
      "ipcc_default_factors",
      "net_calorific_value",
      "net_calorific_value NUMERIC(10, 4)",
    );

    // -----------------------------------------------------------------
    // Backfill NCV on the 12 existing fossil fuel CO2 rows
    // -----------------------------------------------------------------
    for (const [activityType, ncv] of Object.entries(ncvByFuel)) {
      const res = await client.query(
        `UPDATE ipcc_default_factors
         SET net_calorific_value = $1
         WHERE category = 'Stationary Combustion' AND activity_type = $2 AND sector = 'all' AND gas_type = 'CO2'
           AND net_calorific_value IS NULL`,
        [ncv, activityType],
      );
      if (res.rowCount > 0) {
        applied.push(`backfill: net_calorific_value = ${ncv} TJ/Gg for ${activityType}`);
      } else {
        skipped.push(`backfill: net_calorific_value for ${activityType} (already set or row not found)`);
      }
    }

    // -----------------------------------------------------------------
    // Seed biogenic fuels -- CO2 (sector-independent)
    // -----------------------------------------------------------------
    const CATEGORY = "Stationary Combustion";

    for (const fuel of biogenicFuels) {
      await seed(
        client,
        `ipcc_default_factors CO2 (biogenic) / ${fuel.activityType} / all`,
        `INSERT INTO ipcc_default_factors
           (category, activity_type, sector, gas_type, unit, factor, scope, source_document, source_url, notes, is_biogenic)
         VALUES ($1, $2, 'all', 'CO2', 'TJ', $3, 'scope1', $4, $5, $6, TRUE)
         ON CONFLICT (category, activity_type, sector, gas_type) DO NOTHING`,
        [
          CATEGORY,
          fuel.activityType,
          fuel.co2,
          CO2_SOURCE_DOC,
          CO2_SOURCE_URL,
          "kg CO2 per TJ fuel (Net Calorific Value basis). Biogenic -- excluded from gross Scope 1/2/3 totals, reported as a separate memo item (GRI 305 / GHG Protocol / IPCC convention).",
        ],
      );
    }

    // -----------------------------------------------------------------
    // Seed biogenic fuels -- CH4/N2O per sector
    // -----------------------------------------------------------------
    for (const [sectorName, fuelFactors] of Object.entries(biogenicSectorFactors)) {
      const tableRef = sectorTableRefs[sectorName];
      const sourceDoc = `2006 IPCC Guidelines for National GHG Inventories, Vol.2 Ch.2 (Stationary Combustion), ${tableRef} (${sectorName})`;

      for (const fuel of biogenicFuels) {
        const { ch4, n2o } = fuelFactors[fuel.activityType];

        await seed(
          client,
          `ipcc_default_factors CH4 (biogenic) / ${fuel.activityType} / ${sectorName}`,
          `INSERT INTO ipcc_default_factors
             (category, activity_type, sector, gas_type, unit, factor, scope, source_document, source_url, notes, is_biogenic)
           VALUES ($1, $2, $3, 'CH4', 'TJ', $4, 'scope1', $5, $6, $7, TRUE)
           ON CONFLICT (category, activity_type, sector, gas_type) DO NOTHING`,
          [
            CATEGORY,
            fuel.activityType,
            sectorName,
            ch4,
            sourceDoc,
            STATIONARY_SOURCE_URL,
            `kg CH4 per TJ fuel (Net Calorific Value basis), ${sectorName} sector. Biogenic fuel -- use with gwp_values 'CH4 (non-fossil)'.`,
          ],
        );

        await seed(
          client,
          `ipcc_default_factors N2O (biogenic) / ${fuel.activityType} / ${sectorName}`,
          `INSERT INTO ipcc_default_factors
             (category, activity_type, sector, gas_type, unit, factor, scope, source_document, source_url, notes, is_biogenic)
           VALUES ($1, $2, $3, 'N2O', 'TJ', $4, 'scope1', $5, $6, $7, TRUE)
           ON CONFLICT (category, activity_type, sector, gas_type) DO NOTHING`,
          [
            CATEGORY,
            fuel.activityType,
            sectorName,
            n2o,
            sourceDoc,
            STATIONARY_SOURCE_URL,
            `kg N2O per TJ fuel (Net Calorific Value basis), ${sectorName} sector. Biogenic fuel.`,
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
      `\nnet_calorific_value backfilled on ${Object.keys(ncvByFuel).length} fossil fuel CO2 rows. ` +
        `${biogenicFuels.length} biogenic fuels seeded (CO2 x ${biogenicFuels.length} + CH4/N2O x ${biogenicFuels.length} x 4 sectors x 2 = ${biogenicFuels.length + biogenicFuels.length * 4 * 2} rows).`,
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
