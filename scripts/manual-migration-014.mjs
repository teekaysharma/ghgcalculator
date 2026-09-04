// scripts/manual-migration-014.mjs
//
// Membership & account lifecycle management: adds is_active to memberships
// and users, adds password_reset_token/password_reset_token_expires_at to
// users, and adds organization_id/organization_name to admin_action_log
// (plus widening its action column's allowed values at the app level only --
// action stays a plain text column, same convention as memberships.role).
// See docs/superpowers/specs/2026-09-04-membership-lifecycle-management-design.md.
//
// All existing rows default to is_active = true (DB-level DEFAULT true on
// the ADD COLUMN), so nothing that currently has access loses it when this
// runs -- there is no backfill step needed, unlike migration 012's
// grandfather backfill.
//
// Idempotent like every other migration in this project: checks
// information_schema before any DDL change, safe to re-run.
//
// Usage: node scripts/manual-migration-014.mjs

import "dotenv/config";
import { Pool } from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL not set. Run this from the project folder with .env filled in.");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const applied = [];
const skipped = [];

async function addColumnIfMissing(client, tableName, columnName, ddl) {
  const res = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [tableName, columnName],
  );
  if (res.rowCount > 0) {
    skipped.push(`${tableName}.${columnName} (already exists)`);
    return false;
  }
  await client.query(ddl);
  applied.push(`ALTER TABLE ${tableName} ADD COLUMN ${columnName}`);
  return true;
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await addColumnIfMissing(
      client,
      "memberships",
      "is_active",
      `ALTER TABLE memberships ADD COLUMN is_active boolean NOT NULL DEFAULT true`,
    );
    await addColumnIfMissing(
      client,
      "users",
      "is_active",
      `ALTER TABLE users ADD COLUMN is_active boolean NOT NULL DEFAULT true`,
    );
    await addColumnIfMissing(
      client,
      "users",
      "password_reset_token",
      `ALTER TABLE users ADD COLUMN password_reset_token text`,
    );
    await addColumnIfMissing(
      client,
      "users",
      "password_reset_token_expires_at",
      `ALTER TABLE users ADD COLUMN password_reset_token_expires_at timestamp`,
    );
    await addColumnIfMissing(
      client,
      "admin_action_log",
      "organization_id",
      `ALTER TABLE admin_action_log ADD COLUMN organization_id integer`,
    );
    await addColumnIfMissing(
      client,
      "admin_action_log",
      "organization_name",
      `ALTER TABLE admin_action_log ADD COLUMN organization_name text`,
    );

    await client.query("COMMIT");

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
