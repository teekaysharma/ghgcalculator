// scripts/verify-cleanup-cron.mjs
//
// Dedicated test for GET /api/cron/cleanup-unverified-users -- kept
// separate from scripts/verify-branch.mjs on purpose (see
// docs/superpowers/specs/2026-09-03-registration-hardening-design.md,
// "Test impact"): it deletes data, so it isn't something to run on every
// npm run verify pass.
//
// Requires the dev server already running (npm run dev in another
// terminal) -- this script does not start or stop it.
//
// Usage: node scripts/verify-cleanup-cron.mjs

import "dotenv/config";
import { Pool } from "pg";

const PORT = process.env.PORT || "5000";
const BASE_URL = `http://localhost:${PORT}`;
const RUN_TAG = `cleanuptest-${Date.now()}`;

let passed = 0;
let failed = 0;

function ok(step, msg) {
  passed++;
  console.log(`  ✓ ${step}${msg ? " - " + msg : ""}`);
}

function fail(step, msg) {
  failed++;
  console.error(`  ✗ ${step}${msg ? " - " + msg : ""}`);
}

async function registerTestUser(tag) {
  const email = `${tag}@example.invalid`;
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "CleanupTest123", organizationName: tag }),
  });
  if (res.status !== 201) {
    throw new Error(`setup: failed to register ${email}, status ${res.status}`);
  }
  return email;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    fail("setup", "DATABASE_URL not set");
    process.exit(1);
  }
  if (!process.env.CRON_SECRET) {
    fail("setup", "CRON_SECRET not set in .env -- see .env.example");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const expiredEmail = await registerTestUser(`${RUN_TAG}-expired`);
  const freshEmail = await registerTestUser(`${RUN_TAG}-fresh`);

  try {
    // Force the first user's token into the past -- no need to wait 24h.
    await pool.query(
      "UPDATE users SET email_verification_token_expires_at = now() - interval '1 hour' WHERE email = $1",
      [expiredEmail],
    );

    // --- reject a missing/wrong bearer token ---
    {
      const res = await fetch(`${BASE_URL}/api/cron/cleanup-unverified-users`);
      if (res.status === 401) ok("GET .../cleanup-unverified-users (no auth header)", "401");
      else fail("GET .../cleanup-unverified-users (no auth header)", `expected 401, got ${res.status}`);
    }
    {
      const res = await fetch(`${BASE_URL}/api/cron/cleanup-unverified-users`, {
        headers: { Authorization: "Bearer wrong-secret" },
      });
      if (res.status === 401) ok("GET .../cleanup-unverified-users (wrong token)", "401");
      else fail("GET .../cleanup-unverified-users (wrong token)", `expected 401, got ${res.status}`);
    }

    // --- run the real sweep ---
    {
      const res = await fetch(`${BASE_URL}/api/cron/cleanup-unverified-users`, {
        headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 200 && typeof body.deletedCount === "number" && body.deletedCount >= 1) {
        ok("GET .../cleanup-unverified-users (valid token)", `200, deletedCount ${body.deletedCount}`);
      } else {
        fail("GET .../cleanup-unverified-users (valid token)", `status ${res.status}, body ${JSON.stringify(body)}`);
      }
    }

    // --- the expired user is gone ---
    {
      const res = await pool.query("SELECT 1 FROM users WHERE email = $1", [expiredEmail]);
      if (res.rowCount === 0) ok("expired user deleted", expiredEmail);
      else fail("expired user deleted", `still present: ${expiredEmail}`);
    }

    // --- the not-yet-expired user is untouched ---
    {
      const res = await pool.query("SELECT 1 FROM users WHERE email = $1", [freshEmail]);
      if (res.rowCount === 1) ok("fresh (non-expired) user untouched", freshEmail);
      else fail("fresh (non-expired) user untouched", `unexpectedly deleted: ${freshEmail}`);
    }
  } finally {
    // Clean up whatever this run left behind, regardless of pass/fail.
    const remaining = await pool.query("SELECT id, email FROM users WHERE email = ANY($1)", [[expiredEmail, freshEmail]]);
    for (const row of remaining.rows) {
      const m = await pool.query("SELECT organization_id FROM memberships WHERE user_id = $1", [row.id]);
      const orgId = m.rows[0]?.organization_id;
      if (orgId) await pool.query("DELETE FROM organizations WHERE id = $1", [orgId]);
      await pool.query("DELETE FROM users WHERE id = $1", [row.id]);
    }
    await pool.end();
  }

  console.log("");
  console.log(`[verify-cleanup-cron] ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
