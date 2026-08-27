// scripts/manual-migration-001.mjs
//
// drizzle-kit push failed twice in a row against the real Neon database for
// this schema increment, both times with a generic, unhelpful error
// ("column \"id\" is in a primary key", code 42P16) that gave no table or
// column name and occurred before it even printed a proposed statement list
// the second time. This looks like a drizzle-kit push bug/limitation with
// this specific combination of new tables + FK dependencies + column
// additions on a database it's now re-introspecting mid-migration, not a
// data problem (the orphaned-row theory was tested and ruled out).
//
// This script is a one-time, targeted workaround: first deletes orphaned
// rows in reporting_entities/facilities/reporting_boundaries left over from
// the earlier crashed push (rows whose organization_id or reporting_
// entity_id no longer has a valid parent -- the FK constraints that would
// normally prevent/cascade this never got created before the crash), then
// checks information_schema/pg_constraint/pg_indexes for exactly what
// shared/schema.ts expects and is currently missing (2 columns, 5 FKs, 2
// unique constraints, 3 indexes), applies only the gap, in one
// transaction, idempotent. Not a replacement for drizzle-kit push going
// forward -- once this gap is closed, push should have nothing left to
// diff for this increment and should work normally again for future
// schema changes.
//
// Usage: node scripts/manual-migration-001.mjs

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
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return res.rowCount > 0;
}

async function constraintExists(client, name) {
  const res = await client.query(`SELECT 1 FROM pg_constraint WHERE conname = $1`, [name]);
  return res.rowCount > 0;
}

async function indexExists(client, name) {
  const res = await client.query(`SELECT 1 FROM pg_indexes WHERE indexname = $1`, [name]);
  return res.rowCount > 0;
}

async function ensureColumn(client, table, column, ddl) {
  if (await columnExists(client, table, column)) {
    skipped.push(`column ${table}.${column} (already exists)`);
    return;
  }
  await client.query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  applied.push(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

async function ensureConstraint(client, name, table, ddl) {
  if (await constraintExists(client, name)) {
    skipped.push(`constraint ${name} (already exists)`);
    return;
  }
  await client.query(`ALTER TABLE ${table} ADD CONSTRAINT ${name} ${ddl}`);
  applied.push(`ALTER TABLE ${table} ADD CONSTRAINT ${name} ${ddl}`);
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

    // --- cleanup: orphaned rows from the earlier crashed push, in all
    // three ISO tables (not just reporting_boundaries -- that was fixed
    // separately before, this run found the same problem in
    // reporting_entities too, so doing all three together here, in
    // dependency order: facilities/reporting_boundaries reference
    // reporting_entities, so clean those first, then reporting_entities
    // itself, all keyed off organization_id having no matching parent). ---
    const cleanupQueries = [
      { table: "facilities", sql: `DELETE FROM facilities f WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = f.organization_id) RETURNING f.id` },
      { table: "reporting_boundaries", sql: `DELETE FROM reporting_boundaries rb WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = rb.organization_id) RETURNING rb.id` },
      { table: "reporting_entities", sql: `DELETE FROM reporting_entities re WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = re.organization_id) RETURNING re.id` },
      // second pass: facilities/boundaries that point at a reporting_entity
      // which either never existed with a valid org, or was just deleted
      // above in this same transaction
      { table: "facilities", sql: `DELETE FROM facilities f WHERE NOT EXISTS (SELECT 1 FROM reporting_entities re WHERE re.id = f.reporting_entity_id) RETURNING f.id` },
      { table: "reporting_boundaries", sql: `DELETE FROM reporting_boundaries rb WHERE NOT EXISTS (SELECT 1 FROM reporting_entities re WHERE re.id = rb.reporting_entity_id) RETURNING rb.id` },
    ];
    for (const { table, sql } of cleanupQueries) {
      const res = await client.query(sql);
      if (res.rowCount > 0) applied.push(`cleanup: deleted ${res.rowCount} orphaned row(s) from ${table}`);
    }

    // --- columns ---
    await ensureColumn(client, "emission_factors", "year", "year integer");
    await ensureColumn(client, "emission_records", "scope3_category", "scope3_category text");

    // --- foreign keys (all ON DELETE CASCADE, matching shared/schema.ts) ---
    await ensureConstraint(
      client,
      "reporting_entities_organization_id_organizations_id_fk",
      "reporting_entities",
      'FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE',
    );
    await ensureConstraint(
      client,
      "facilities_organization_id_organizations_id_fk",
      "facilities",
      'FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE',
    );
    await ensureConstraint(
      client,
      "facilities_reporting_entity_id_reporting_entities_id_fk",
      "facilities",
      'FOREIGN KEY (reporting_entity_id) REFERENCES reporting_entities(id) ON DELETE CASCADE',
    );
    await ensureConstraint(
      client,
      "reporting_boundaries_organization_id_organizations_id_fk",
      "reporting_boundaries",
      'FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE',
    );
    await ensureConstraint(
      client,
      "reporting_boundaries_reporting_entity_id_reporting_entities_id_fk",
      "reporting_boundaries",
      'FOREIGN KEY (reporting_entity_id) REFERENCES reporting_entities(id) ON DELETE CASCADE',
    );

    // --- unique constraints ---
    await ensureConstraint(
      client,
      "facilities_entity_name_unique",
      "facilities",
      "UNIQUE (reporting_entity_id, name)",
    );
    await ensureConstraint(
      client,
      "reporting_boundaries_entity_year_unique",
      "reporting_boundaries",
      "UNIQUE (reporting_entity_id, reporting_year)",
    );

    // --- indexes ---
    await ensureIndex(client, "reporting_entities_org_idx", "CREATE INDEX reporting_entities_org_idx ON reporting_entities (organization_id)");
    await ensureIndex(client, "facilities_org_idx", "CREATE INDEX facilities_org_idx ON facilities (organization_id)");
    await ensureIndex(client, "reporting_boundaries_org_idx", "CREATE INDEX reporting_boundaries_org_idx ON reporting_boundaries (organization_id)");

    await client.query("COMMIT");

    console.log(`Applied ${applied.length} statement(s):`);
    applied.forEach((s) => console.log(`  + ${s}`));
    console.log(`Skipped ${skipped.length} (already present):`);
    skipped.forEach((s) => console.log(`  = ${s}`));
    console.log("\nDatabase is now in sync with shared/schema.ts for this increment.");
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
