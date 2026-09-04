// scripts/manual-migration-013.mjs
//
// Platform super-admin panel: adds is_super_admin to users and creates the
// admin_action_log table, then seeds is_super_admin = true for the project
// owner's own account (hardcoded by email -- this is the only way to
// create the FIRST super-admin; any super-admin can promote a verified
// account, or demote another super-admin (never themselves), from the
// /admin panel after that. See
// docs/superpowers/specs/2026-09-04-super-admin-panel-design.md).
//
// Order, all in one transaction:
//   1. ADD COLUMN IF NOT EXISTS users.is_super_admin boolean (defaults false)
//   2. Seed is_super_admin = true for the owner's account, but ONLY if no
//      super-admins currently exist (COUNT WHERE is_super_admin = true == 0).
//      This self-heals: the seed fires as soon as the account exists and
//      re-runs the script. It's still safe against accidental re-promotion
//      of a deliberately demoted account because the panel forbids self-demote,
//      so at least one super-admin always remains after any panel-based demote
//      action. The count only reaches 0 again via direct DB manipulation
//      (e.g. reset/testing), which is an appropriate case to self-heal on.
//      If no user row exists yet for that email, this is skipped with a
//      clear message rather than failing -- register that account first,
//      then re-run this script.
//   3. CREATE TABLE IF NOT EXISTS admin_action_log
//
// Idempotent like every other migration in this project: checks
// information_schema before any DDL change, safe to re-run.
//
// Usage: node scripts/manual-migration-013.mjs

import "dotenv/config";
import { Pool } from "pg";

const SUPER_ADMIN_EMAIL = "teekaysharma@googlemail.com";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL not set. Run this from the project folder with .env filled in.");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const applied = [];
const skipped = [];

// Returns true if the column was just added, false if it already existed.
async function addColumnIfMissing(client, columnName, ddl) {
  const res = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = $1`,
    [columnName],
  );
  if (res.rowCount > 0) {
    skipped.push(`users.${columnName} (already exists)`);
    return false;
  }
  await client.query(ddl);
  applied.push(`ALTER TABLE users ADD COLUMN ${columnName}`);
  return true;
}

async function createTableIfMissing(client, tableName, ddl) {
  const res = await client.query(`SELECT 1 FROM information_schema.tables WHERE table_name = $1`, [tableName]);
  if (res.rowCount > 0) {
    skipped.push(`table ${tableName} (already exists)`);
    return false;
  }
  await client.query(ddl);
  applied.push(`CREATE TABLE ${tableName}`);
  return true;
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await addColumnIfMissing(
      client,
      "is_super_admin",
      `ALTER TABLE users ADD COLUMN is_super_admin boolean NOT NULL DEFAULT false`,
    );

    // Gate on zero current super-admins for self-healing seeding. Safe against
    // accidental re-promotion because the panel forbids self-demote, so at
    // least one super-admin always remains after any panel-based demote.
    // The count only reaches 0 via direct DB manipulation (e.g. reset/testing),
    // which is an appropriate case to self-heal on.
    const superAdminCount = await client.query(`SELECT COUNT(*)::int AS count FROM users WHERE is_super_admin = true`);
    if (superAdminCount.rows[0].count === 0) {
      const owner = await client.query(`SELECT id FROM users WHERE email = $1`, [SUPER_ADMIN_EMAIL]);
      if (owner.rowCount > 0) {
        await client.query(`UPDATE users SET is_super_admin = true WHERE id = $1`, [owner.rows[0].id]);
        applied.push(`seeded is_super_admin = true for ${SUPER_ADMIN_EMAIL}`);
      } else {
        skipped.push(
          `seed super-admin (no user row found for ${SUPER_ADMIN_EMAIL} -- register that account, then re-run this script)`,
        );
      }
    } else {
      skipped.push(`seed super-admin (${superAdminCount.rows[0].count} super-admin(s) already exist, no seed needed)`);
    }

    await createTableIfMissing(
      client,
      "admin_action_log",
      `CREATE TABLE admin_action_log (
        id serial PRIMARY KEY,
        actor_user_id integer NOT NULL REFERENCES users(id),
        action text NOT NULL,
        target_user_id integer,
        target_email text NOT NULL,
        note text,
        created_at timestamp NOT NULL DEFAULT now()
      )`,
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
