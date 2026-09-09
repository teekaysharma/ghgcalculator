// scripts/manual-migration-015.mjs
//
// Final-review fix wave (2026-09-09), finding C2: adds
// users.has_been_verified, the sticky "this account has been verified at
// least once, ever" flag that both hard-delete paths now gate on instead of
// users.email_verified.
//
// Why: email_verified was doing two incompatible jobs. It meant both "never
// verified, so this is a disposable registration that's safe to hard-delete"
// AND "was verified, but is mid re-verification because an admin changed its
// email" -- storage.setNewEmailPendingVerification legitimately sets it
// false. That dropped live, data-bearing tenant accounts into exactly the
// state DELETE /api/admin/users/:id and the
// deleteExpiredUnverifiedRegistrations cron sweep both read as "disposable",
// making a two-click (or, via the sweep, zero-click) cascade delete of a real
// tenant's facilities/emission records/verification findings reachable.
//
// Order, all in one transaction:
//   1. ADD COLUMN users.has_been_verified boolean NOT NULL DEFAULT false
//   2. ONE-TIME backfill, gated on step 1 having actually just added the
//      column this run: UPDATE users SET has_been_verified = true WHERE
//      email_verified = true. This marks every currently-verified account
//      permanently safe from both delete paths, and correctly leaves
//      currently-unverified rows at false -- those are genuine fresh
//      registrations that have never been verified, and must stay eligible
//      for the sweep. Gating on "just added" is what keeps the backfill
//      one-time: re-running this script after an admin has legitimately
//      change-emailed someone (email_verified = false, has_been_verified =
//      true) must not re-derive the flag from email_verified and undo it.
//
// Idempotent like every other migration in this project: checks
// information_schema before any DDL change, safe to re-run (the second run
// applies 0 steps and skips both).
//
// Usage: node scripts/manual-migration-015.mjs

import "dotenv/config";
import { Pool } from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL not set. Run this from the project folder with .env filled in.");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const applied = [];
const skipped = [];

// Returns true if the column was just added, false if it already existed.
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

    const columnWasJustAdded = await addColumnIfMissing(
      client,
      "users",
      "has_been_verified",
      `ALTER TABLE users ADD COLUMN has_been_verified boolean NOT NULL DEFAULT false`,
    );

    if (columnWasJustAdded) {
      const backfill = await client.query(
        `UPDATE users SET has_been_verified = true WHERE email_verified = true`,
      );
      applied.push(`backfilled has_been_verified = true for ${backfill.rowCount} currently-verified account(s)`);
    } else {
      skipped.push("backfill (column already existed, so it ran on a previous invocation)");
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
