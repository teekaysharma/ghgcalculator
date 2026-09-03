// scripts/manual-migration-012.mjs
//
// Registration hardening: adds email_verified, email_verification_token,
// and email_verification_token_expires_at to users, then grandfathers
// every existing row as already-verified. See
// docs/superpowers/specs/2026-09-03-registration-hardening-design.md.
//
// Order matters and both steps run in one transaction:
//   1. ADD COLUMN IF NOT EXISTS for all three (email_verified defaults to
//      false at the DB level, so it applies to existing rows too until...)
//   2. ...step 2 explicitly sets email_verified = true for every row that
//      was NOT verified yet -- this is what grandfathers pre-existing
//      users. Safe to run against a fresh, empty users table too.
//
// Idempotent like every other migration in this project: checks
// information_schema before any DDL change, safe to re-run.
//
// Usage: node scripts/manual-migration-012.mjs

import "dotenv/config";
import { Pool } from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL not set. Run this from the project folder with .env filled in.");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const applied = [];
const skipped = [];

async function addColumnIfMissing(client, columnName, ddl) {
  const res = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = $1`,
    [columnName],
  );
  if (res.rowCount > 0) {
    skipped.push(`users.${columnName} (already exists)`);
    return;
  }
  await client.query(ddl);
  applied.push(`ALTER TABLE users ADD COLUMN ${columnName}`);
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await addColumnIfMissing(
      client,
      "email_verified",
      `ALTER TABLE users ADD COLUMN email_verified boolean NOT NULL DEFAULT false`,
    );
    await addColumnIfMissing(
      client,
      "email_verification_token",
      `ALTER TABLE users ADD COLUMN email_verification_token text`,
    );
    await addColumnIfMissing(
      client,
      "email_verification_token_expires_at",
      `ALTER TABLE users ADD COLUMN email_verification_token_expires_at timestamp`,
    );

    const backfill = await client.query(`UPDATE users SET email_verified = true WHERE email_verified = false`);
    if (backfill.rowCount > 0) {
      applied.push(`grandfathered ${backfill.rowCount} existing user(s) as email_verified = true`);
    } else {
      skipped.push("grandfather backfill (no unverified rows found)");
    }

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
