// scripts/grant-module.mjs
//
// Vendor-run CLI script: grants an organization an entitlement to a module
// key. Deliberately NOT exposed as an HTTP route -- see
// docs/superpowers/specs/2026-08-15-report-module-architecture-design.md.
// Idempotent (ON CONFLICT DO NOTHING on the org+moduleKey unique index).
//
// Usage: node scripts/grant-module.mjs <organizationSlug> <moduleKey> [enabledByNote]
// Example: node scripts/grant-module.mjs acme-consulting cbam "Invoice #123, 2026-08-15"

import "dotenv/config";
import { Pool } from "pg";

const [, , organizationSlug, moduleKey, enabledByNote] = process.argv;

if (!organizationSlug || !moduleKey) {
  console.error("Usage: node scripts/grant-module.mjs <organizationSlug> <moduleKey> [enabledByNote]");
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
      `INSERT INTO organization_modules (organization_id, module_key, enabled_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, module_key) DO NOTHING
       RETURNING id`,
      [org.id, moduleKey, enabledByNote ?? null],
    );

    if (res.rowCount > 0) {
      console.log(`Granted "${moduleKey}" to organization "${org.name}" (id ${org.id}).`);
    } else {
      console.log(`Organization "${org.name}" (id ${org.id}) already has "${moduleKey}" -- no change.`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main();
