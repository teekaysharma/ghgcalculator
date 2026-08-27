// scripts/manual-migration-002.mjs
//
// Adds the facility-level MRV granularity layer defined in shared/schema.ts
// (12 new tenant-scoped tables plus 2 global reference/seed tables, appended
// after the ISO 14064-1 boundary tables -- see the "Facility-level MRV
// granularity layer" block comment in shared/schema.ts for the full
// rationale and verification status of the field-level detail).
//
// Unlike scripts/manual-migration-001.mjs, this is not patching a partially
// -applied push -- every one of these 14 tables is entirely new, so there is
// no pre-existing partial state to reconcile column-by-column against
// information_schema. All statements use CREATE TABLE IF NOT EXISTS / CREATE
// INDEX IF NOT EXISTS, which Postgres treats natively as idempotent: safe to
// run this script repeatedly, and safe if a previous run got partway through
// before failing. See MIGRATIONS.md for why hand-written scripts are used
// instead of `drizzle-kit push` on this branch (push has repeatedly crashed
// against this database on new-table-plus-FK migrations with an opaque,
// unhelpful error -- root-caused as a drizzle-kit bug, not a data problem).
//
// Tables created (tenant-scoped, all carry organization_id NOT NULL
// REFERENCES organizations(id) ON DELETE CASCADE):
//   facility_identifiers, facility_contacts, facility_products,
//   source_streams, calculation_approaches, measurement_based_approaches,
//   fallback_approaches, methane_reports, data_quality_records,
//   verification_findings, management_qa_records, mitigation_measures
// Tables created (global, not tenant-scoped, seeded with reference data):
//   primary_activity_types, product_benchmarks
//
// Creation order respects FK dependencies: source_streams must exist before
// calculation_approaches / measurement_based_approaches / fallback_approaches
// / data_quality_records (all of which reference it); facilities and
// reporting_boundaries are assumed to already exist from
// manual-migration-001.mjs.
//
// Seed data for primary_activity_types and product_benchmarks is sourced
// from the EAD Deliverable C workbook's "4k - Reference Lists" sheet ("List
// of Primary Activities" and "List of EU Product Benchmarks" columns), read
// directly in the session that authored this script. product_benchmarks.sector
// is left NULL for every seeded row -- the source sheet has no sector column,
// so nothing is invented there.
//
// Usage: node scripts/manual-migration-002.mjs

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

async function indexExists(client, name) {
  const res = await client.query(`SELECT 1 FROM pg_indexes WHERE indexname = $1`, [name]);
  return res.rowCount > 0;
}

async function ensureTable(client, name, ddl) {
  const existedBefore = await tableExists(client, name);
  await client.query(ddl);
  if (existedBefore) {
    skipped.push(`table ${name} (already exists)`);
  } else {
    applied.push(`CREATE TABLE ${name}`);
  }
}

async function ensureIndex(client, name, ddl) {
  if (await indexExists(client, name)) {
    skipped.push(`index ${name} (already exists)`);
    return;
  }
  await client.query(ddl);
  applied.push(ddl);
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
    // facility_identifiers -- 1:1 with facilities (per 2c1_Identifiers)
    // -----------------------------------------------------------------
    await ensureTable(
      client,
      "facility_identifiers",
      `CREATE TABLE IF NOT EXISTS facility_identifiers (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        facility_id INTEGER NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
        group_parent_entity TEXT,
        economic_licence_number TEXT,
        environmental_permit_number TEXT,
        address TEXT,
        coordinates_lat NUMERIC(10,6),
        coordinates_lng NUMERIC(10,6),
        primary_business_sector TEXT,
        primary_activity TEXT,
        activity_description TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT facility_identifiers_facility_id_unique UNIQUE (facility_id)
      )`,
    );
    await ensureIndex(
      client,
      "facility_identifiers_org_idx",
      "CREATE INDEX facility_identifiers_org_idx ON facility_identifiers (organization_id)",
    );

    // -----------------------------------------------------------------
    // facility_contacts -- primary/alternative contacts (per 2c1_Identifiers)
    // -----------------------------------------------------------------
    await ensureTable(
      client,
      "facility_contacts",
      `CREATE TABLE IF NOT EXISTS facility_contacts (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        facility_id INTEGER NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
        contact_type TEXT NOT NULL DEFAULT 'primary',
        title TEXT,
        first_name TEXT,
        surname TEXT,
        job_title TEXT,
        organisation_name TEXT,
        phone TEXT,
        email TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )`,
    );
    await ensureIndex(
      client,
      "facility_contacts_org_idx",
      "CREATE INDEX facility_contacts_org_idx ON facility_contacts (organization_id)",
    );
    await ensureIndex(
      client,
      "facility_contacts_facility_idx",
      "CREATE INDEX facility_contacts_facility_idx ON facility_contacts (facility_id)",
    );

    // -----------------------------------------------------------------
    // facility_products -- product classification (per 2c2_Facility Description)
    // -----------------------------------------------------------------
    await ensureTable(
      client,
      "facility_products",
      `CREATE TABLE IF NOT EXISTS facility_products (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        facility_id INTEGER NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
        product_code TEXT,
        product_category TEXT,
        production_technology TEXT,
        energy_related_emissions BOOLEAN DEFAULT false,
        process_emissions BOOLEAN DEFAULT false,
        production_capacity NUMERIC(20,4),
        production_capacity_unit TEXT,
        actual_production NUMERIC(20,4),
        actual_production_unit TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )`,
    );
    await ensureIndex(
      client,
      "facility_products_org_idx",
      "CREATE INDEX facility_products_org_idx ON facility_products (organization_id)",
    );
    await ensureIndex(
      client,
      "facility_products_facility_idx",
      "CREATE INDEX facility_products_facility_idx ON facility_products (facility_id)",
    );

    // -----------------------------------------------------------------
    // source_streams -- core new concept: one row per emission source
    // stream at a facility, for a given reporting boundary (year)
    // -----------------------------------------------------------------
    await ensureTable(
      client,
      "source_streams",
      `CREATE TABLE IF NOT EXISTS source_streams (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        facility_id INTEGER NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
        reporting_boundary_id INTEGER NOT NULL REFERENCES reporting_boundaries(id) ON DELETE CASCADE,
        stream_code TEXT,
        name TEXT NOT NULL,
        description TEXT,
        ghg_source_category TEXT,
        materiality TEXT,
        estimated_annual_emissions_tco2e NUMERIC(20,4),
        quantification_approach TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )`,
    );
    await ensureIndex(
      client,
      "source_streams_org_idx",
      "CREATE INDEX source_streams_org_idx ON source_streams (organization_id)",
    );
    await ensureIndex(
      client,
      "source_streams_facility_idx",
      "CREATE INDEX source_streams_facility_idx ON source_streams (facility_id)",
    );
    await ensureIndex(
      client,
      "source_streams_boundary_idx",
      "CREATE INDEX source_streams_boundary_idx ON source_streams (reporting_boundary_id)",
    );

    // -----------------------------------------------------------------
    // calculation_approaches -- 1:1 with source_streams using the
    // calculation-based quantification approach
    // -----------------------------------------------------------------
    await ensureTable(
      client,
      "calculation_approaches",
      `CREATE TABLE IF NOT EXISTS calculation_approaches (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        source_stream_id INTEGER NOT NULL REFERENCES source_streams(id) ON DELETE CASCADE,
        fuel_or_material_type TEXT,
        activity_data_value NUMERIC(20,6),
        activity_data_unit TEXT,
        activity_data_source TEXT,
        activity_data_tier TEXT,
        emission_factor_value NUMERIC(20,8),
        emission_factor_unit TEXT,
        emission_factor_source TEXT,
        emission_factor_tier TEXT,
        oxidation_or_carbonation_factor NUMERIC(6,4),
        oxidation_factor_tier TEXT,
        net_calorific_value NUMERIC(20,6),
        calculated_emissions_tco2e NUMERIC(20,4),
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT calculation_approaches_source_stream_id_unique UNIQUE (source_stream_id)
      )`,
    );
    await ensureIndex(
      client,
      "calculation_approaches_org_idx",
      "CREATE INDEX calculation_approaches_org_idx ON calculation_approaches (organization_id)",
    );

    // -----------------------------------------------------------------
    // measurement_based_approaches -- 1:1 with source_streams using a
    // measurement-based quantification approach (e.g. CEMS)
    // -----------------------------------------------------------------
    await ensureTable(
      client,
      "measurement_based_approaches",
      `CREATE TABLE IF NOT EXISTS measurement_based_approaches (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        source_stream_id INTEGER NOT NULL REFERENCES source_streams(id) ON DELETE CASCADE,
        measurement_method TEXT,
        monitoring_frequency TEXT,
        measurement_unit TEXT,
        annual_measured_quantity NUMERIC(20,6),
        qaqc_procedure TEXT,
        calibration_frequency TEXT,
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT measurement_based_approaches_source_stream_id_unique UNIQUE (source_stream_id)
      )`,
    );
    await ensureIndex(
      client,
      "measurement_based_approaches_org_idx",
      "CREATE INDEX measurement_based_approaches_org_idx ON measurement_based_approaches (organization_id)",
    );

    // -----------------------------------------------------------------
    // fallback_approaches -- 1:1 with source_streams using the fallback
    // quantification approach
    // -----------------------------------------------------------------
    await ensureTable(
      client,
      "fallback_approaches",
      `CREATE TABLE IF NOT EXISTS fallback_approaches (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        source_stream_id INTEGER NOT NULL REFERENCES source_streams(id) ON DELETE CASCADE,
        justification TEXT,
        fallback_method_description TEXT,
        estimated_emissions_tco2e NUMERIC(20,4),
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT fallback_approaches_source_stream_id_unique UNIQUE (source_stream_id)
      )`,
    );
    await ensureIndex(
      client,
      "fallback_approaches_org_idx",
      "CREATE INDEX fallback_approaches_org_idx ON fallback_approaches (organization_id)",
    );

    // -----------------------------------------------------------------
    // methane_reports -- facility-wide, per reporting boundary (year)
    // -----------------------------------------------------------------
    await ensureTable(
      client,
      "methane_reports",
      `CREATE TABLE IF NOT EXISTS methane_reports (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        facility_id INTEGER NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
        reporting_boundary_id INTEGER NOT NULL REFERENCES reporting_boundaries(id) ON DELETE CASCADE,
        methane_sources_description TEXT,
        quantification_method TEXT,
        annual_methane_emissions NUMERIC(20,6),
        annual_methane_emissions_unit TEXT,
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT methane_reports_facility_boundary_unique UNIQUE (facility_id, reporting_boundary_id)
      )`,
    );
    await ensureIndex(
      client,
      "methane_reports_org_idx",
      "CREATE INDEX methane_reports_org_idx ON methane_reports (organization_id)",
    );

    // -----------------------------------------------------------------
    // data_quality_records -- 1:1 with source_streams, uncertainty and
    // IPCC-default-factor-substitution tracking
    // -----------------------------------------------------------------
    await ensureTable(
      client,
      "data_quality_records",
      `CREATE TABLE IF NOT EXISTS data_quality_records (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        source_stream_id INTEGER NOT NULL REFERENCES source_streams(id) ON DELETE CASCADE,
        data_quality_tier TEXT,
        uncertainty_percent NUMERIC(6,2),
        uncertainty_justification TEXT,
        used_ipcc_default_factor BOOLEAN DEFAULT false,
        ipcc_default_substitution_reason TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT data_quality_records_source_stream_id_unique UNIQUE (source_stream_id)
      )`,
    );
    await ensureIndex(
      client,
      "data_quality_records_org_idx",
      "CREATE INDEX data_quality_records_org_idx ON data_quality_records (organization_id)",
    );

    // -----------------------------------------------------------------
    // verification_findings -- per reporting boundary (a verification
    // engagement covers one reporting period)
    // -----------------------------------------------------------------
    await ensureTable(
      client,
      "verification_findings",
      `CREATE TABLE IF NOT EXISTS verification_findings (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        reporting_boundary_id INTEGER NOT NULL REFERENCES reporting_boundaries(id) ON DELETE CASCADE,
        finding_type TEXT NOT NULL,
        description TEXT NOT NULL,
        severity TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        resolution_notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )`,
    );
    await ensureIndex(
      client,
      "verification_findings_org_idx",
      "CREATE INDEX verification_findings_org_idx ON verification_findings (organization_id)",
    );
    await ensureIndex(
      client,
      "verification_findings_boundary_idx",
      "CREATE INDEX verification_findings_boundary_idx ON verification_findings (reporting_boundary_id)",
    );

    // -----------------------------------------------------------------
    // management_qa_records -- per reporting boundary
    // -----------------------------------------------------------------
    await ensureTable(
      client,
      "management_qa_records",
      `CREATE TABLE IF NOT EXISTS management_qa_records (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        reporting_boundary_id INTEGER NOT NULL REFERENCES reporting_boundaries(id) ON DELETE CASCADE,
        qa_procedure_description TEXT,
        responsible_person TEXT,
        review_frequency TEXT,
        last_review_date TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )`,
    );
    await ensureIndex(
      client,
      "management_qa_records_org_idx",
      "CREATE INDEX management_qa_records_org_idx ON management_qa_records (organization_id)",
    );

    // -----------------------------------------------------------------
    // mitigation_measures -- per facility
    // -----------------------------------------------------------------
    await ensureTable(
      client,
      "mitigation_measures",
      `CREATE TABLE IF NOT EXISTS mitigation_measures (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        facility_id INTEGER NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
        measure_description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'planned',
        estimated_reduction_tco2e NUMERIC(20,4),
        target_date TIMESTAMP,
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )`,
    );
    await ensureIndex(
      client,
      "mitigation_measures_org_idx",
      "CREATE INDEX mitigation_measures_org_idx ON mitigation_measures (organization_id)",
    );
    await ensureIndex(
      client,
      "mitigation_measures_facility_idx",
      "CREATE INDEX mitigation_measures_facility_idx ON mitigation_measures (facility_id)",
    );

    // -----------------------------------------------------------------
    // primary_activity_types -- global reference table, seeded below
    // -----------------------------------------------------------------
    await ensureTable(
      client,
      "primary_activity_types",
      `CREATE TABLE IF NOT EXISTS primary_activity_types (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT primary_activity_types_name_unique UNIQUE (name)
      )`,
    );

    // -----------------------------------------------------------------
    // product_benchmarks -- global reference table, seeded below
    // -----------------------------------------------------------------
    await ensureTable(
      client,
      "product_benchmarks",
      `CREATE TABLE IF NOT EXISTS product_benchmarks (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        sector TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT product_benchmarks_name_unique UNIQUE (name)
      )`,
    );

    // -----------------------------------------------------------------
    // Seed data -- primary_activity_types
    //
    // Source: EAD Deliverable C workbook, "4k - Reference Lists" sheet,
    // "List of Primary Activities" column, read directly in the session
    // that authored this script. Exact list, nothing added or invented.
    // -----------------------------------------------------------------
    const primaryActivityTypeNames = [
      "Combustion of fuels",
      "Production of coke",
      "Metal ore roasting or sintering",
      "Production of iron or steel",
      "Production of aluminium",
      "Production of cement clinker",
      "Production of glass",
      "Other",
    ];
    for (const name of primaryActivityTypeNames) {
      await seed(
        client,
        `primary_activity_types.name = '${name}'`,
        `INSERT INTO primary_activity_types (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
        [name],
      );
    }

    // -----------------------------------------------------------------
    // Seed data -- product_benchmarks
    //
    // Source: same workbook/sheet, "List of EU Product Benchmarks" column,
    // read directly in the session that authored this script. Exact list,
    // nothing added or invented. sector is left NULL for all rows -- the
    // source sheet has no sector column.
    // -----------------------------------------------------------------
    const productBenchmarkNames = [
      "Refinery products",
      "Coke",
      "Sintered ore",
      "Hot metal",
      "EAF carbon steel",
      "EAF high alloy steel",
      "Iron casting",
      "Pre-bake anode",
      "[Primary] Aluminium",
      "Grey cement clinker",
      "White cement clinker",
      "Lime",
      "Dolime",
      "Sintered dolime",
      "Float glass",
      "Bottles and jars of colourless glass",
      "Bottles and jars of coloured glass",
      "Continuous filament glass fibre",
    ];
    for (const name of productBenchmarkNames) {
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
    console.log("\nDatabase now has the facility-level MRV granularity layer from shared/schema.ts.");
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