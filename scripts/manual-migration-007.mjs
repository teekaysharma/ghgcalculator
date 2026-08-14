// scripts/manual-migration-007.mjs
//
// Additive pass, following the conventions of manual-migration-002 through
// 006.mjs. Adds every column Section 1 of
// docs/superpowers/specs/2026-08-14-verification-ready-multi-facility-inventory-design.md
// requires, across 5 tables. All nullable or safely defaulted -- no
// existing row becomes invalid. See shared/schema.ts for the Drizzle-side
// source of truth this migration brings the live database in line with.
//
// Idempotent: every helper checks information_schema before doing
// anything, safe to run repeatedly and safe if a previous run got partway
// through before failing. Wrapped in one transaction (BEGIN/COMMIT,
// ROLLBACK on error).
//
// Usage: node scripts/manual-migration-007.mjs

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

async function indexExists(client, name) {
  const res = await client.query(`SELECT 1 FROM pg_class WHERE relname = $1`, [name]);
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

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // -----------------------------------------------------------------
    // facilities -- equity-share ownership
    // -----------------------------------------------------------------
    await ensureColumn(
      client,
      "facilities",
      "equity_share_ownership_percent",
      "equity_share_ownership_percent NUMERIC(5, 2)",
    );

    // -----------------------------------------------------------------
    // emission_factors -- country tag + biogenic flag
    // -----------------------------------------------------------------
    await ensureColumn(client, "emission_factors", "country", "country TEXT");
    await ensureColumn(client, "emission_factors", "is_biogenic", "is_biogenic BOOLEAN NOT NULL DEFAULT FALSE");

    // -----------------------------------------------------------------
    // ipcc_default_factors -- biogenic flag + published confidence interval
    // -----------------------------------------------------------------
    await ensureColumn(client, "ipcc_default_factors", "is_biogenic", "is_biogenic BOOLEAN NOT NULL DEFAULT FALSE");
    await ensureColumn(client, "ipcc_default_factors", "factor_lower", "factor_lower NUMERIC(20, 8)");
    await ensureColumn(client, "ipcc_default_factors", "factor_upper", "factor_upper NUMERIC(20, 8)");

    // -----------------------------------------------------------------
    // calculation_approaches -- per-gas breakdown, mirrors emission_records
    // -----------------------------------------------------------------
    await ensureColumn(client, "calculation_approaches", "gas_breakdown", "gas_breakdown JSONB");

    // -----------------------------------------------------------------
    // emission_records -- facility/source-stream/boundary linkage
    // -----------------------------------------------------------------
    await ensureColumn(
      client,
      "emission_records",
      "facility_id",
      "facility_id INTEGER REFERENCES facilities(id) ON DELETE CASCADE",
    );
    await ensureColumn(
      client,
      "emission_records",
      "source_stream_id",
      "source_stream_id INTEGER REFERENCES source_streams(id) ON DELETE CASCADE",
    );
    await ensureColumn(
      client,
      "emission_records",
      "calculation_approach_id",
      "calculation_approach_id INTEGER REFERENCES calculation_approaches(id) ON DELETE SET NULL",
    );
    await ensureColumn(
      client,
      "emission_records",
      "reporting_boundary_id",
      "reporting_boundary_id INTEGER REFERENCES reporting_boundaries(id) ON DELETE CASCADE",
    );
    // 1:1 with calculationApproach, same pattern as calculation_approaches'
    // own unique-on-sourceStreamId constraint. Plain unique index: Postgres
    // excludes NULLs from the uniqueness check by default, so legacy rows
    // (calculation_approach_id IS NULL) never conflict with each other --
    // only real facility-MRV-computed rows (Plan 2) are constrained to one
    // emission_records row per calculation approach.
    await ensureIndex(
      client,
      "emission_records_calc_approach_unique",
      `CREATE UNIQUE INDEX emission_records_calc_approach_unique ON emission_records (calculation_approach_id)`,
    );

    // -----------------------------------------------------------------
    // reporting_entities -- base year
    // -----------------------------------------------------------------
    await ensureColumn(client, "reporting_entities", "base_year", "base_year INTEGER");
    await ensureColumn(client, "reporting_entities", "base_year_rationale", "base_year_rationale TEXT");

    // -----------------------------------------------------------------
    // reporting_boundaries -- intensity denominators + finalize/version snapshot
    // -----------------------------------------------------------------
    await ensureColumn(client, "reporting_boundaries", "revenue_amount", "revenue_amount NUMERIC(20, 2)");
    await ensureColumn(client, "reporting_boundaries", "revenue_currency", "revenue_currency TEXT");
    await ensureColumn(
      client,
      "reporting_boundaries",
      "full_time_equivalent_employees",
      "full_time_equivalent_employees NUMERIC(10, 1)",
    );
    await ensureColumn(client, "reporting_boundaries", "status", "status TEXT NOT NULL DEFAULT 'draft'");
    await ensureColumn(client, "reporting_boundaries", "finalized_at", "finalized_at TIMESTAMP");

    await client.query("COMMIT");

    console.log(`Applied ${applied.length} statement(s):`);
    applied.forEach((s) => console.log(`  + ${s}`));
    console.log(`Skipped ${skipped.length} (already present):`);
    skipped.forEach((s) => console.log(`  = ${s}`));
    console.log(
      "\nAll columns are nullable or safely defaulted -- no existing row is affected. " +
        "See docs/superpowers/specs/2026-08-14-verification-ready-multi-facility-inventory-design.md Section 1.",
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
