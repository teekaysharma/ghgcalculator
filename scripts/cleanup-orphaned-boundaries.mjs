// scripts/cleanup-orphaned-boundaries.mjs
//
// One-off fix for a specific incident: an earlier `db:push` run crashed
// partway through, after CREATE TABLE reporting_boundaries and a test row
// insert, but before the organization_id -> organizations(id) ON DELETE
// CASCADE foreign key got added. Deleting the parent organization
// afterward therefore did not cascade-delete this row, and drizzle-kit
// chokes on adding a unique constraint to a table containing an orphaned
// row referencing a since-deleted organization.
//
// This script only ever deletes rows in reporting_boundaries whose
// organization_id does not exist in organizations. It does not touch
// any row with a valid parent. Prints what it finds before deleting.
//
// Usage: node scripts/cleanup-orphaned-boundaries.mjs

import "dotenv/config";
import { Pool } from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL not set. Run this from the project folder with .env filled in.");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  const orphans = await pool.query(`
    SELECT rb.id, rb.organization_id, rb.reporting_entity_id, rb.reporting_year
    FROM reporting_boundaries rb
    LEFT JOIN organizations o ON o.id = rb.organization_id
    WHERE o.id IS NULL
  `);

  if (orphans.rows.length === 0) {
    console.log("No orphaned reporting_boundaries rows found. Nothing to do.");
  } else {
    console.log(`Found ${orphans.rows.length} orphaned row(s):`);
    console.table(orphans.rows);

    const ids = orphans.rows.map((r) => r.id);
    const deleted = await pool.query(`DELETE FROM reporting_boundaries WHERE id = ANY($1) RETURNING id`, [ids]);
    console.log(`Deleted ${deleted.rowCount} orphaned row(s). reporting_boundaries should now be clean.`);
  }
} finally {
  await pool.end();
}
