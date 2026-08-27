// scripts/revoke-module.mjs
//
// Vendor-run CLI script: removes an organization's entitlement to a module
// key. Companion to scripts/grant-module.mjs -- same access model (no HTTP
// route, run directly against the live DB).
//
// Usage: node scripts/revoke-module.mjs <organizationSlug> <moduleKey>

import "dotenv/config";
import { Pool } from "pg";

const [, , organizationSlug, moduleKey] = process.argv;

if (!organizationSlug || !moduleKey) {
  console.error("Usage: node scripts/revoke-module.mjs <organizationSlug> <moduleKey>");
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL not set. Run this from the project folder with .env filled in.");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const client = await pool.connect();
  try {
    const orgRes = await client.query(`SELECT id, name FROM organizations WHERE slug = $1`, [organizationSlug]);
    if (orgRes.rowCount === 0) {
      console.error(`No organization found with slug "${organizationSlug}"`);
      process.exitCode = 1;
      return;
    }
    const org = orgRes.rows[0];

    const res = await client.query(
      `DELETE FROM organization_modules WHERE organization_id = $1 AND module_key = $2 RETURNING id`,
      [org.id, moduleKey],
    );

    if (res.rowCount > 0) {
      console.log(`Revoked "${moduleKey}" from organization "${org.name}" (id ${org.id}).`);
    } else {
      console.log(`Organization "${org.name}" (id ${org.id}) did not have "${moduleKey}" -- no change.`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main();
