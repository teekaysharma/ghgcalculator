// scripts/manual-migration-003.mjs
//
// Additive column-add pass, following the 14-table facility-level MRV
// migration in scripts/manual-migration-002.mjs. That migration created
// whole new tables (source_streams, facility_identifiers, facility_products,
// and 11 others); this migration does not touch table structure at that
// level -- it adds four new nullable columns to three of those already-
// created tables, plus the constraints that go with them. See the
// corresponding column definitions in shared/schema.ts (sourceStreams,
// facilityIdentifiers, facilityProducts) for the Drizzle-side source of
// truth this migration is bringing the live database in line with.
//
// Columns added (all nullable, additive, backward-compatible -- no existing
// or future row is broken by these, no NOT NULL anywhere):
//   source_streams.scope                       text
//   source_streams.scope3_category              integer
//   facility_identifiers.primary_activity_type_id  integer
//   facility_products.product_benchmark_id      integer
//
// Constraints added:
//   - source_streams_scope_check: scope IS NULL OR scope IN ('scope1',
//     'scope2', 'scope3')
//   - source_streams_scope3_category_check: scope3_category IS NULL OR
//     (scope3_category BETWEEN 1 AND 15) -- the GHG Protocol's 15 Scope 3
//     categories
//   - facility_identifiers_primary_activity_type_id_primary_activity_types_id_fk:
//     FOREIGN KEY (primary_activity_type_id) REFERENCES
//     primary_activity_types(id) ON DELETE SET NULL -- deliberately not
//     CASCADE: deleting a row from the primary_activity_types reference
//     list must never cascade-delete facility data, so a reference-row
//     deletion just clears the pointer instead.
//   - facility_products_product_benchmark_id_product_benchmarks_id_fk:
//     FOREIGN KEY (product_benchmark_id) REFERENCES product_benchmarks(id)
//     ON DELETE SET NULL -- same reasoning as above.
//
// Idempotent in the same way as manual-migration-001.mjs and
// manual-migration-002.mjs: every helper checks information_schema /
// pg_constraint for existing state before doing anything, so this script is
// safe to run repeatedly and safe if a previous run got partway through
// before failing. Wrapped in one transaction (BEGIN/COMMIT, ROLLBACK on
// error), same as both prior manual migrations.
//
// Usage: node scripts/manual-migration-003.mjs

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

async function constraintExists(client, name) {
  const res = await client.query(`SELECT 1 FROM pg_constraint WHERE conname = $1`, [name]);
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

async function ensureConstraint(client, name, table, ddl) {
  if (await constraintExists(client, name)) {
    skipped.push(`constraint ${name} (already exists)`);
    return;
  }
  await client.query(`ALTER TABLE ${table} ADD CONSTRAINT ${name} ${ddl}`);
  applied.push(`ALTER TABLE ${table} ADD CONSTRAINT ${name} ${ddl}`);
}

async function fixTypo(client, label, sql, params) {
  const res = await client.query(sql, params);
  if (res.rowCount > 0) {
    applied.push(`fix: ${label}`);
  } else {
    skipped.push(`fix: ${label} (already correct or not found)`);
  }
}

async function seed(client, label, sql, params) {
  const res = await client.query(sql, params);
  if (res.rowCount > 0) {
    applied.push(`seed: inserted ${label}`);
  } else {
    skipped.push(`seed: ${label} (already present)`);
  }
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // -----------------------------------------------------------------
    // source_streams -- scope + scope3_category
    // -----------------------------------------------------------------
    await ensureColumn(client, "source_streams", "scope", "scope text");
    await ensureColumn(client, "source_streams", "scope3_category", "scope3_category integer");

    await ensureConstraint(
      client,
      "source_streams_scope_check",
      "source_streams",
      "CHECK (scope IS NULL OR scope IN ('scope1', 'scope2', 'scope3'))",
    );
    await ensureConstraint(
      client,
      "source_streams_scope3_category_check",
      "source_streams",
      "CHECK (scope3_category IS NULL OR (scope3_category >= 1 AND scope3_category <= 15))",
    );

    // -----------------------------------------------------------------
    // facility_identifiers -- primary_activity_type_id (FK to
    // primary_activity_types, created in manual-migration-002.mjs)
    // -----------------------------------------------------------------
    await ensureColumn(
      client,
      "facility_identifiers",
      "primary_activity_type_id",
      "primary_activity_type_id integer",
    );
    await ensureConstraint(
      client,
      "facility_identifiers_primary_activity_type_id_primary_activity_types_id_fk",
      "facility_identifiers",
      "FOREIGN KEY (primary_activity_type_id) REFERENCES primary_activity_types(id) ON DELETE SET NULL",
    );

    // -----------------------------------------------------------------
    // facility_products -- product_benchmark_id (FK to product_benchmarks,
    // created in manual-migration-002.mjs)
    // -----------------------------------------------------------------
    await ensureColumn(
      client,
      "facility_products",
      "product_benchmark_id",
      "product_benchmark_id integer",
    );
    await ensureConstraint(
      client,
      "facility_products_product_benchmark_id_product_benchmarks_id_fk",
      "facility_products",
      "FOREIGN KEY (product_benchmark_id) REFERENCES product_benchmarks(id) ON DELETE SET NULL",
    );

    // -----------------------------------------------------------------
    // product_benchmarks -- data-quality fix and completion pass.
    //
    // Cross-checking the manual-migration-002.mjs seed against the actual
    // official template (TEMPLATES/Deliverable C Template_v8 1.xlsx,
    // sheet '4k - Reference Lists', column B, rows 13-68) this session
    // found two problems with the 18-row seed from migration-002:
    //   1. Row 'Bottles and jars of colourless' is missing the word
    //      'glass' compared to the actual template cell B28 -- a
    //      typo/truncation in how that seed was transcribed, not an
    //      error in the template itself (the adjacent 'coloured' row,
    //      B29, was transcribed correctly).
    //   2. The seed only captured 18 of the actual 56 entries in that
    //      column -- the list continues past row 30 through row 68 and
    //      was never re-read past the first visible screen. The 38
    //      missing entries are added below, sourced directly from the
    //      template this session, nothing invented.
    // -----------------------------------------------------------------
    await fixTypo(
      client,
      "product_benchmarks.name typo: 'Bottles and jars of colourless' -> 'Bottles and jars of colourless glass'",
      `UPDATE product_benchmarks SET name = 'Bottles and jars of colourless glass' WHERE name = 'Bottles and jars of colourless'`,
      [],
    );

    const missingProductBenchmarkNames = [
      "Facing bricks",
      "Pavers",
      "Roof tiles",
      "Spray dried powder",
      "Mineral wool",
      "Plaster",
      "Dried secondary gypsum",
      "Plasterboard",
      "Short fibre kraft pulp",
      "Long fibre kraft pulp",
      "Sulphite pulp thermo-mechanical",
      "Recovered paper pulp",
      "Newsprint",
      "Uncoated fine paper",
      "Coated fine paper",
      "Tissue",
      "Testliner and fluting",
      "Uncoated carton board",
      "Coated carton board",
      "Carbon black",
      "Nitric acid",
      "Adipic acid",
      "Ammonia",
      "Steam cracking",
      "Aromatics",
      "Styrene",
      "Phenol/ acetone",
      "Ethylenoxid / Ethylenglykol",
      "Vinylchlorid-Monomer (VCM)",
      "S-PVC",
      "E-PVC",
      "Hydrogen",
      "Synthesis gas",
      "Soda ash",
      "Heat Benchmark",
      "Fuel Benchmark",
      "Process Emissions",
      "Other",
    ];
    for (const name of missingProductBenchmarkNames) {
      await seed(
        client,
        `product_benchmarks.name = '${name}'`,
        `INSERT INTO product_benchmarks (name, sector) VALUES ($1, NULL) ON CONFLICT (name) DO NOTHING`,
        [name],
      );
    }

    await client.query("COMMIT");

    console.log(`Applied ${applied.length} statement(s):`);
    applied.forEach((s) => console.log(`  + ${s}`));
    console.log(`Skipped ${skipped.length} (already present):`);
    skipped.forEach((s) => console.log(`  = ${s}`));
    console.log("\nDatabase now has the additive scope/scope3_category/primary_activity_type_id/product_benchmark_id columns from shared/schema.ts.");
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