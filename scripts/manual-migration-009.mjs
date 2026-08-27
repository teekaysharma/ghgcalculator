// scripts/manual-migration-009.mjs
//
// Creates organization_modules -- the entitlement table for future add-on
// report/output modules (CBAM-shaped view, GRI-table view, etc.). See
// docs/superpowers/specs/2026-08-15-report-module-architecture-design.md.
// Deliberately created with zero rows: nothing is entitled to anything by
// default except the always-on "standard" view, which needs no row at all
// (server/modules.ts treats it as always enabled).
//
// Idempotent: checks information_schema before doing anything, safe to run
// repeatedly. Wrapped in one transaction (BEGIN/COMMIT, ROLLBACK on error),
// same as every prior manual migration in this project.
//
// Usage: node scripts/manual-migration-009.mjs

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

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await ensureTable(
      client,
      "organization_modules",
      `CREATE TABLE IF NOT EXISTS organization_modules (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        module_key TEXT NOT NULL,
        enabled_at TIMESTAMP NOT NULL DEFAULT NOW(),
        enabled_by TEXT
      )`,
    );

    await ensureIndex(
      client,
      "organization_modules_org_module_unique",
      `CREATE UNIQUE INDEX organization_modules_org_module_unique ON organization_modules (organization_id, module_key)`,
    );

    await ensureIndex(
      client,
      "organization_modules_org_idx",
      `CREATE INDEX organization_modules_org_idx ON organization_modules (organization_id)`,
    );

    await client.query("COMMIT");

    console.log(`Applied ${applied.length} statement(s):`);
    applied.forEach((s) => console.log(`  + ${s}`));
    console.log(`Skipped ${skipped.length} (already present):`);
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
