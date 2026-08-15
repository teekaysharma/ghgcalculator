// scripts/manual-migration-004.mjs
//
// Additive pass, following the column-add conventions of
// scripts/manual-migration-003.mjs. This migration:
//   1. Creates a new global reference table, isic_divisions, holding all
//      21 sections / 88 divisions of ISIC Rev.4 (International Standard
//      Industrial Classification, UN Statistics Division), grouped by
//      section. Same "global reference" pattern as primary_activity_types
//      and product_benchmarks (created in manual-migration-002.mjs): not
//      tenant-scoped, seeded once, read by every tenant.
//   2. Adds one new nullable column, facility_identifiers.isic_division_id,
//      an FK to isic_divisions(id). This is the new, much broader
//      "Primary activity" classification field for facility-level MRV,
//      replacing the too-narrow 8-item primary_activity_types dropdown as
//      the *main* primary-activity field. primary_activity_types and
//      facility_identifiers.primary_activity_type_id are NOT touched by
//      this migration -- they stay in place unmodified, kept for a
//      possible future EAD-export mapping.
//   3. Seeds all 88 ISIC Rev.4 divisions into isic_divisions. Source: the
//      official UN Statistics Division ISIC Rev.4 structure file
//      (https://unstats.un.org/unsd/classifications/Econ/Download/In%20Text/ISIC_Rev_4_english_structure.Txt),
//      fetched directly and reproduced verbatim -- section codes A-U,
//      division codes 01-99 (kept as text to preserve leading zeros),
//      section names, and division names all transcribed exactly, nothing
//      invented or paraphrased.
//
// See shared/schema.ts (isicDivisions table, facilityIdentifiers table's
// isicDivisionId column) for the Drizzle-side source of truth this
// migration is bringing the live database in line with.
//
// Idempotent in the same way as manual-migration-001/002/003.mjs: every
// helper checks information_schema / pg_constraint for existing state
// before doing anything, so this script is safe to run repeatedly and safe
// if a previous run got partway through before failing. Wrapped in one
// transaction (BEGIN/COMMIT, ROLLBACK on error), same as prior manual
// migrations.
//
// Usage: node scripts/manual-migration-004.mjs

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

async function ensureTable(client, table, createDdl) {
  if (await tableExists(client, table)) {
    skipped.push(`table ${table} (already exists)`);
    return;
  }
  await client.query(createDdl);
  applied.push(`CREATE TABLE ${table}`);
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

async function seed(client, label, sql, params) {
  const res = await client.query(sql, params);
  if (res.rowCount > 0) {
    applied.push(`seed: inserted ${label}`);
  } else {
    skipped.push(`seed: ${label} (already present)`);
  }
}

// Full, verified list of all 21 ISIC Rev.4 sections and all 88 divisions,
// transcribed verbatim from the official UN Statistics Division structure
// file. sectionCode/sectionName repeat across the divisions that belong to
// that section (denormalized, same shallow-lookup shape as
// primary_activity_types / product_benchmarks -- no separate isic_sections
// table).
const isicDivisions = [
  // Section A -- Agriculture, forestry and fishing
  { sectionCode: "A", sectionName: "Agriculture, forestry and fishing", divisionCode: "01", divisionName: "Crop and animal production, hunting and related service activities" },
  { sectionCode: "A", sectionName: "Agriculture, forestry and fishing", divisionCode: "02", divisionName: "Forestry and logging" },
  { sectionCode: "A", sectionName: "Agriculture, forestry and fishing", divisionCode: "03", divisionName: "Fishing and aquaculture" },

  // Section B -- Mining and quarrying
  { sectionCode: "B", sectionName: "Mining and quarrying", divisionCode: "05", divisionName: "Mining of coal and lignite" },
  { sectionCode: "B", sectionName: "Mining and quarrying", divisionCode: "06", divisionName: "Extraction of crude petroleum and natural gas" },
  { sectionCode: "B", sectionName: "Mining and quarrying", divisionCode: "07", divisionName: "Mining of metal ores" },
  { sectionCode: "B", sectionName: "Mining and quarrying", divisionCode: "08", divisionName: "Other mining and quarrying" },
  { sectionCode: "B", sectionName: "Mining and quarrying", divisionCode: "09", divisionName: "Mining support service activities" },

  // Section C -- Manufacturing
  { sectionCode: "C", sectionName: "Manufacturing", divisionCode: "10", divisionName: "Manufacture of food products" },
  { sectionCode: "C", sectionName: "Manufacturing", divisionCode: "11", divisionName: "Manufacture of beverages" },
  { sectionCode: "C", sectionName: "Manufacturing", divisionCode: "12", divisionName: "Manufacture of tobacco products" },
  { sectionCode: "C", sectionName: "Manufacturing", divisionCode: "13", divisionName: "Manufacture of textiles" },
  { sectionCode: "C", sectionName: "Manufacturing", divisionCode: "14", divisionName: "Manufacture of wearing apparel" },
  { sectionCode: "C", sectionName: "Manufacturing", divisionCode: "15", divisionName: "Manufacture of leather and related products" },
  { sectionCode: "C", sectionName: "Manufacturing", divisionCode: "16", divisionName: "Manufacture of wood and of products of wood and cork, except furniture; manufacture of articles of straw and plaiting materials" },
  { sectionCode: "C", sectionName: "Manufacturing", divisionCode: "17", divisionName: "Manufacture of paper and paper products" },
  { sectionCode: "C", sectionName: "Manufacturing", divisionCode: "18", divisionName: "Printing and reproduction of recorded media" },
  { sectionCode: "C", sectionName: "Manufacturing", divisionCode: "19", divisionName: "Manufacture of coke and refined petroleum products" },
  { sectionCode: "C", sectionName: "Manufacturing", divisionCode: "20", divisionName: "Manufacture of chemicals and chemical products" },
  { sectionCode: "C", sectionName: "Manufacturing", divisionCode: "21", divisionName: "Manufacture of basic pharmaceutical products and pharmaceutical preparations" },
  { sectionCode: "C", sectionName: "Manufacturing", divisionCode: "22", divisionName: "Manufacture of rubber and plastics products" },
  { sectionCode: "C", sectionName: "Manufacturing", divisionCode: "23", divisionName: "Manufacture of other non-metallic mineral products" },
  { sectionCode: "C", sectionName: "Manufacturing", divisionCode: "24", divisionName: "Manufacture of basic metals" },
  { sectionCode: "C", sectionName: "Manufacturing", divisionCode: "25", divisionName: "Manufacture of fabricated metal products, except machinery and equipment" },
  { sectionCode: "C", sectionName: "Manufacturing", divisionCode: "26", divisionName: "Manufacture of computer, electronic and optical products" },
  { sectionCode: "C", sectionName: "Manufacturing", divisionCode: "27", divisionName: "Manufacture of electrical equipment" },
  { sectionCode: "C", sectionName: "Manufacturing", divisionCode: "28", divisionName: "Manufacture of machinery and equipment n.e.c." },
  { sectionCode: "C", sectionName: "Manufacturing", divisionCode: "29", divisionName: "Manufacture of motor vehicles, trailers and semi-trailers" },
  { sectionCode: "C", sectionName: "Manufacturing", divisionCode: "30", divisionName: "Manufacture of other transport equipment" },
  { sectionCode: "C", sectionName: "Manufacturing", divisionCode: "31", divisionName: "Manufacture of furniture" },
  { sectionCode: "C", sectionName: "Manufacturing", divisionCode: "32", divisionName: "Other manufacturing" },
  { sectionCode: "C", sectionName: "Manufacturing", divisionCode: "33", divisionName: "Repair and installation of machinery and equipment" },

  // Section D -- Electricity, gas, steam and air conditioning supply
  { sectionCode: "D", sectionName: "Electricity, gas, steam and air conditioning supply", divisionCode: "35", divisionName: "Electricity, gas, steam and air conditioning supply" },

  // Section E -- Water supply; sewerage, waste management and remediation activities
  { sectionCode: "E", sectionName: "Water supply; sewerage, waste management and remediation activities", divisionCode: "36", divisionName: "Water collection, treatment and supply" },
  { sectionCode: "E", sectionName: "Water supply; sewerage, waste management and remediation activities", divisionCode: "37", divisionName: "Sewerage" },
  { sectionCode: "E", sectionName: "Water supply; sewerage, waste management and remediation activities", divisionCode: "38", divisionName: "Waste collection, treatment and disposal activities; materials recovery" },
  { sectionCode: "E", sectionName: "Water supply; sewerage, waste management and remediation activities", divisionCode: "39", divisionName: "Remediation activities and other waste management services" },

  // Section F -- Construction
  { sectionCode: "F", sectionName: "Construction", divisionCode: "41", divisionName: "Construction of buildings" },
  { sectionCode: "F", sectionName: "Construction", divisionCode: "42", divisionName: "Civil engineering" },
  { sectionCode: "F", sectionName: "Construction", divisionCode: "43", divisionName: "Specialized construction activities" },

  // Section G -- Wholesale and retail trade; repair of motor vehicles and motorcycles
  { sectionCode: "G", sectionName: "Wholesale and retail trade; repair of motor vehicles and motorcycles", divisionCode: "45", divisionName: "Wholesale and retail trade and repair of motor vehicles and motorcycles" },
  { sectionCode: "G", sectionName: "Wholesale and retail trade; repair of motor vehicles and motorcycles", divisionCode: "46", divisionName: "Wholesale trade, except of motor vehicles and motorcycles" },
  { sectionCode: "G", sectionName: "Wholesale and retail trade; repair of motor vehicles and motorcycles", divisionCode: "47", divisionName: "Retail trade, except of motor vehicles and motorcycles" },

  // Section H -- Transportation and storage
  { sectionCode: "H", sectionName: "Transportation and storage", divisionCode: "49", divisionName: "Land transport and transport via pipelines" },
  { sectionCode: "H", sectionName: "Transportation and storage", divisionCode: "50", divisionName: "Water transport" },
  { sectionCode: "H", sectionName: "Transportation and storage", divisionCode: "51", divisionName: "Air transport" },
  { sectionCode: "H", sectionName: "Transportation and storage", divisionCode: "52", divisionName: "Warehousing and support activities for transportation" },
  { sectionCode: "H", sectionName: "Transportation and storage", divisionCode: "53", divisionName: "Postal and courier activities" },

  // Section I -- Accommodation and food service activities
  { sectionCode: "I", sectionName: "Accommodation and food service activities", divisionCode: "55", divisionName: "Accommodation" },
  { sectionCode: "I", sectionName: "Accommodation and food service activities", divisionCode: "56", divisionName: "Food and beverage service activities" },

  // Section J -- Information and communication
  { sectionCode: "J", sectionName: "Information and communication", divisionCode: "58", divisionName: "Publishing activities" },
  { sectionCode: "J", sectionName: "Information and communication", divisionCode: "59", divisionName: "Motion picture, video and television programme production, sound recording and music publishing activities" },
  { sectionCode: "J", sectionName: "Information and communication", divisionCode: "60", divisionName: "Programming and broadcasting activities" },
  { sectionCode: "J", sectionName: "Information and communication", divisionCode: "61", divisionName: "Telecommunications" },
  { sectionCode: "J", sectionName: "Information and communication", divisionCode: "62", divisionName: "Computer programming, consultancy and related activities" },
  { sectionCode: "J", sectionName: "Information and communication", divisionCode: "63", divisionName: "Information service activities" },

  // Section K -- Financial and insurance activities
  { sectionCode: "K", sectionName: "Financial and insurance activities", divisionCode: "64", divisionName: "Financial service activities, except insurance and pension funding" },
  { sectionCode: "K", sectionName: "Financial and insurance activities", divisionCode: "65", divisionName: "Insurance, reinsurance and pension funding, except compulsory social security" },
  { sectionCode: "K", sectionName: "Financial and insurance activities", divisionCode: "66", divisionName: "Activities auxiliary to financial service and insurance activities" },

  // Section L -- Real estate activities
  { sectionCode: "L", sectionName: "Real estate activities", divisionCode: "68", divisionName: "Real estate activities" },

  // Section M -- Professional, scientific and technical activities
  { sectionCode: "M", sectionName: "Professional, scientific and technical activities", divisionCode: "69", divisionName: "Legal and accounting activities" },
  { sectionCode: "M", sectionName: "Professional, scientific and technical activities", divisionCode: "70", divisionName: "Activities of head offices; management consultancy activities" },
  { sectionCode: "M", sectionName: "Professional, scientific and technical activities", divisionCode: "71", divisionName: "Architectural and engineering activities; technical testing and analysis" },
  { sectionCode: "M", sectionName: "Professional, scientific and technical activities", divisionCode: "72", divisionName: "Scientific research and development" },
  { sectionCode: "M", sectionName: "Professional, scientific and technical activities", divisionCode: "73", divisionName: "Advertising and market research" },
  { sectionCode: "M", sectionName: "Professional, scientific and technical activities", divisionCode: "74", divisionName: "Other professional, scientific and technical activities" },
  { sectionCode: "M", sectionName: "Professional, scientific and technical activities", divisionCode: "75", divisionName: "Veterinary activities" },

  // Section N -- Administrative and support service activities
  { sectionCode: "N", sectionName: "Administrative and support service activities", divisionCode: "77", divisionName: "Rental and leasing activities" },
  { sectionCode: "N", sectionName: "Administrative and support service activities", divisionCode: "78", divisionName: "Employment activities" },
  { sectionCode: "N", sectionName: "Administrative and support service activities", divisionCode: "79", divisionName: "Travel agency, tour operator, reservation service and related activities" },
  { sectionCode: "N", sectionName: "Administrative and support service activities", divisionCode: "80", divisionName: "Security and investigation activities" },
  { sectionCode: "N", sectionName: "Administrative and support service activities", divisionCode: "81", divisionName: "Services to buildings and landscape activities" },
  { sectionCode: "N", sectionName: "Administrative and support service activities", divisionCode: "82", divisionName: "Office administrative, office support and other business support activities" },

  // Section O -- Public administration and defence; compulsory social security
  { sectionCode: "O", sectionName: "Public administration and defence; compulsory social security", divisionCode: "84", divisionName: "Public administration and defence; compulsory social security" },

  // Section P -- Education
  { sectionCode: "P", sectionName: "Education", divisionCode: "85", divisionName: "Education" },

  // Section Q -- Human health and social work activities
  { sectionCode: "Q", sectionName: "Human health and social work activities", divisionCode: "86", divisionName: "Human health activities" },
  { sectionCode: "Q", sectionName: "Human health and social work activities", divisionCode: "87", divisionName: "Residential care activities" },
  { sectionCode: "Q", sectionName: "Human health and social work activities", divisionCode: "88", divisionName: "Social work activities without accommodation" },

  // Section R -- Arts, entertainment and recreation
  { sectionCode: "R", sectionName: "Arts, entertainment and recreation", divisionCode: "90", divisionName: "Creative, arts and entertainment activities" },
  { sectionCode: "R", sectionName: "Arts, entertainment and recreation", divisionCode: "91", divisionName: "Libraries, archives, museums and other cultural activities" },
  { sectionCode: "R", sectionName: "Arts, entertainment and recreation", divisionCode: "92", divisionName: "Gambling and betting activities" },
  { sectionCode: "R", sectionName: "Arts, entertainment and recreation", divisionCode: "93", divisionName: "Sports activities and amusement and recreation activities" },

  // Section S -- Other service activities
  { sectionCode: "S", sectionName: "Other service activities", divisionCode: "94", divisionName: "Activities of membership organizations" },
  { sectionCode: "S", sectionName: "Other service activities", divisionCode: "95", divisionName: "Repair of computers and personal and household goods" },
  { sectionCode: "S", sectionName: "Other service activities", divisionCode: "96", divisionName: "Other personal service activities" },

  // Section T -- Activities of households as employers; undifferentiated goods- and services-producing activities of households for own use
  { sectionCode: "T", sectionName: "Activities of households as employers; undifferentiated goods- and services-producing activities of households for own use", divisionCode: "97", divisionName: "Activities of households as employers of domestic personnel" },
  { sectionCode: "T", sectionName: "Activities of households as employers; undifferentiated goods- and services-producing activities of households for own use", divisionCode: "98", divisionName: "Undifferentiated goods- and services-producing activities of private households for own use" },

  // Section U -- Activities of extraterritorial organizations and bodies
  { sectionCode: "U", sectionName: "Activities of extraterritorial organizations and bodies", divisionCode: "99", divisionName: "Activities of extraterritorial organizations and bodies" },
];

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // -----------------------------------------------------------------
    // isic_divisions -- new global reference table
    // -----------------------------------------------------------------
    await ensureTable(
      client,
      "isic_divisions",
      `CREATE TABLE IF NOT EXISTS isic_divisions (
        id SERIAL PRIMARY KEY,
        section_code TEXT NOT NULL,
        section_name TEXT NOT NULL,
        division_code TEXT NOT NULL,
        division_name TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )`,
    );
    await ensureConstraint(
      client,
      "isic_divisions_division_code_unique",
      "isic_divisions",
      "UNIQUE (division_code)",
    );

    // -----------------------------------------------------------------
    // facility_identifiers -- isic_division_id (FK to isic_divisions)
    // -----------------------------------------------------------------
    await ensureColumn(
      client,
      "facility_identifiers",
      "isic_division_id",
      "isic_division_id integer",
    );
    await ensureConstraint(
      client,
      "facility_identifiers_isic_division_id_isic_divisions_id_fk",
      "facility_identifiers",
      "FOREIGN KEY (isic_division_id) REFERENCES isic_divisions(id) ON DELETE SET NULL",
    );

    // -----------------------------------------------------------------
    // isic_divisions -- seed all 88 ISIC Rev.4 divisions
    // -----------------------------------------------------------------
    for (const division of isicDivisions) {
      await seed(
        client,
        `isic_divisions.division_code = '${division.divisionCode}' (${division.divisionName})`,
        `INSERT INTO isic_divisions (section_code, section_name, division_code, division_name) VALUES ($1, $2, $3, $4) ON CONFLICT (division_code) DO NOTHING`,
        [division.sectionCode, division.sectionName, division.divisionCode, division.divisionName],
      );
    }

    await client.query("COMMIT");

    console.log(`Applied ${applied.length} statement(s):`);
    applied.forEach((s) => console.log(`  + ${s}`));
    console.log(`Skipped ${skipped.length} (already present):`);
    skipped.forEach((s) => console.log(`  = ${s}`));
    console.log(`\nSeeded ${isicDivisions.length} ISIC Rev.4 divisions total (21 sections).`);
    console.log("Database now has the isic_divisions reference table and facility_identifiers.isic_division_id column from shared/schema.ts.");
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