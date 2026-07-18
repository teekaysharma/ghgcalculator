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
// Rather than keep guessing at drizzle-kit's internals with no visibility
// into the live database, this script brings the database in line with
// shared/schema.ts directly: it checks information_schema and pg_constraint
// for each expected column/constraint/index and applies only what's
// missing. Every statement is idempotent (safe to run more than once) and
// the whole thing runs in one transaction (all-or-nothing).
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
