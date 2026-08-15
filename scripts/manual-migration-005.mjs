// scripts/manual-migration-005.mjs
//
// Additive pass, following the conventions of manual-migration-002/003/004.mjs.
// This migration:
//   1. Creates a new global reference table, ipcc_default_factors -- the
//      global fallback tier of the emission-factor sourcing hierarchy
//      (CLAUDE.md: local/site-specific -> national -> regional -> named
//      global agencies -> IPCC generic defaults). Same "global reference"
//      pattern as isic_divisions/primary_activity_types/product_benchmarks:
//      not tenant-scoped, read by every tenant.
//
//      DELIBERATELY SEEDED WITH ZERO ROWS. This table is meant to hold the
//      actual IPCC 2006 Guidelines for National GHG Inventories / 2019
//      Refinement default emission factors (activity -> CO2e), which is a
//      different IPCC publication from the AR6 GWP-values table already
//      bundled as client/public/gwp-ar6-reference.xlsx (a per-gas
//      multiplier table, not an activity-based emission factor table). No
//      such dataset exists yet in this repo or was available to source
//      from at the time this migration was written -- fabricating specific
//      kg-CO2-per-unit figures without a citable IPCC source would be
//      worse than leaving this table empty. Populating it with real,
//      sourced rows is a separate, explicit follow-up pass.
//   2. Adds three nullable columns to emission_factors: source_url,
//      authority_name, source_tier -- traceability fields for org-uploaded
//      /country-specific factors. Enforced NOT NULL at the API layer
//      (server/routes.ts), not here, matching this project's convention.
//   3. Adds three columns to calculation_approaches:
//      emission_factor_source_url, emission_factor_authority_name
//      (nullable, mirror of the above), and is_ipcc_default (NOT NULL,
//      default false) -- set true whenever a calculation approach's factor
//      came from ipcc_default_factors rather than an org-specific factor.
//
// See shared/schema.ts (ipccDefaultFactors table, emissionFactorsTable and
// calculationApproaches new columns) for the Drizzle-side source of truth
// this migration is bringing the live database in line with.
//
// Idempotent in the same way as manual-migration-001/002/003/004.mjs: every
// helper checks information_schema before doing anything, so this script is
// safe to run repeatedly and safe if a previous run got partway through
// before failing. Wrapped in one transaction (BEGIN/COMMIT, ROLLBACK on
// error), same as prior manual migrations.
//
// Usage: node scripts/manual-migration-005.mjs

import "dotenv/config";
import { Pool } from "pg";

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

async function columnExists(client, table, column) {
  const res = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
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

async function ensureColumn(client, table, column, addColumnDdl) {
  if (await columnExists(client, table, column)) {
    skipped.push(`column ${table}.${column} (already exists)`);
    return;
  }
  await client.query(`ALTER TABLE ${table} ADD COLUMN ${addColumnDdl}`);
  applied.push(`ALTER TABLE ${table} ADD COLUMN ${addColumnDdl}`);
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // -----------------------------------------------------------------
    // ipcc_default_factors -- new global reference table, empty for now
    // -----------------------------------------------------------------
    await ensureTable(
      client,
      "ipcc_default_factors",
      `CREATE TABLE IF NOT EXISTS ipcc_default_factors (
        id SERIAL PRIMARY KEY,
        category TEXT NOT NULL,
        activity_type TEXT NOT NULL,
        unit TEXT NOT NULL,
        factor NUMERIC(20, 8) NOT NULL,
        scope TEXT,
        source_document TEXT NOT NULL,
        source_url TEXT,
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )`,
    );

    // -----------------------------------------------------------------
    // emission_factors -- traceability columns
    // -----------------------------------------------------------------
    await ensureColumn(client, "emission_factors", "source_url", "source_url TEXT");
    await ensureColumn(client, "emission_factors", "authority_name", "authority_name TEXT");
    await ensureColumn(client, "emission_factors", "source_tier", "source_tier TEXT");

    // -----------------------------------------------------------------
    // calculation_approaches -- traceability + IPCC-default flag columns
    // -----------------------------------------------------------------
    await ensureColumn(
      client,
      "calculation_approaches",
      "emission_factor_source_url",
      "emission_factor_source_url TEXT",
    );
    await ensureColumn(
      client,
      "calculation_approaches",
      "emission_factor_authority_name",
      "emission_factor_authority_name TEXT",
    );
    await ensureColumn(
      client,
      "calculation_approaches",
      "is_ipcc_default",
      "is_ipcc_default BOOLEAN NOT NULL DEFAULT FALSE",
    );

    await client.query("COMMIT");

    console.log(`Applied ${applied.length} statement(s):`);
    applied.forEach((s) => console.log(`  + ${s}`));
    console.log(`Skipped ${skipped.length} (already present):`);
    skipped.forEach((s) => console.log(`  = ${s}`));
    console.log(
      "\nipcc_default_factors created with 0 rows (deliberately unseeded -- see file header comment). " +
        "emission_factors and calculation_approaches now have source_url/authority_name traceability columns from shared/schema.ts.",
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
