// scripts/verify-admin-panel.mjs
//
// Dedicated test for the platform super-admin panel (GET /api/admin/users,
// POST /api/admin/users/:id/verify, DELETE /api/admin/users/:id,
// POST /api/admin/users/:id/promote, POST /api/admin/users/:id/demote,
// GET /api/admin/action-log) -- kept separate from
// scripts/verify-branch.mjs on purpose (see
// docs/superpowers/specs/2026-09-04-super-admin-panel-design.md): it
// deletes data, so it isn't something to run on every npm run verify pass.
//
// Requires the dev server already running (npm run dev in another
// terminal) -- this script does not start or stop it.
//
// The FIRST super-admin only ever comes from the migration's hardcoded
// seed -- this script promotes its own tagged test user directly via SQL
// after registering it through the real HTTP flow, then reuses that
// session's cookie. This works without a fresh login because passport's
// deserializeUser (server/auth.ts) re-fetches the full user row from the
// DB on every request, so an already-established session cookie picks up
// the flag on its very next use.
//
// Usage: node scripts/verify-admin-panel.mjs

import "dotenv/config";
import { Pool } from "pg";

const PORT = process.env.PORT || "5000";
const BASE_URL = `http://localhost:${PORT}`;
const RUN_TAG = `admintest-${Date.now()}`;
const TEST_PASSWORD = "AdminTest12345";

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

async function registerAndVerify(pool, tag) {
  const email = `${tag}@example.invalid`;
  const registerRes = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: TEST_PASSWORD, organizationName: tag }),
  });
  if (registerRes.status !== 201) {
    throw new Error(`setup: failed to register ${email}, status ${registerRes.status}`);
  }
  const tokenRes = await pool.query("SELECT email_verification_token FROM users WHERE email = $1", [email]);
  const token = tokenRes.rows[0]?.email_verification_token;
  if (!token) throw new Error(`setup: no verification token found for ${email}`);
  const verifyRes = await fetch(`${BASE_URL}/api/auth/verify-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (verifyRes.status !== 204) {
    throw new Error(`setup: failed to verify ${email}, status ${verifyRes.status}`);
  }
  return email;
}

async function registerOnly(tag) {
  const email = `${tag}@example.invalid`;
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: TEST_PASSWORD, organizationName: tag }),
  });
  if (res.status !== 201) throw new Error(`setup: failed to register ${email}, status ${res.status}`);
  return email;
}

async function login(email) {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: TEST_PASSWORD }),
  });
  if (res.status !== 200) throw new Error(`setup: login failed for ${email}, status ${res.status}`);
  const setCookie = res.headers.get("set-cookie");
  const cookie = setCookie ? setCookie.split(";")[0] : "";
  if (!cookie) throw new Error(`setup: no session cookie returned for ${email}`);
  return cookie;
}

async function getUserId(pool, email) {
  const res = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
  return res.rows[0]?.id;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    fail("setup", "DATABASE_URL not set");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const createdEmails = [];

  try {
    // --- set up: one admin-actor (promoted to super-admin), one plain
    // authenticated non-admin user ---
    const adminEmail = await registerAndVerify(pool, `${RUN_TAG}-admin`);
    createdEmails.push(adminEmail);
    await pool.query("UPDATE users SET is_super_admin = true WHERE email = $1", [adminEmail]);
    const adminId = await getUserId(pool, adminEmail);
    const adminCookie = await login(adminEmail);

    const plainEmail = await registerAndVerify(pool, `${RUN_TAG}-plain`);
    createdEmails.push(plainEmail);
    const plainCookie = await login(plainEmail);

    // --- scenario 1: non-admin gets 403 on all routes ---
    {
      const res = await fetch(`${BASE_URL}/api/admin/users`, { headers: { Cookie: plainCookie } });
      if (res.status === 403) ok("GET /api/admin/users (non-admin)", "403");
      else fail("GET /api/admin/users (non-admin)", `expected 403, got ${res.status}`);
    }
    {
      const res = await fetch(`${BASE_URL}/api/admin/users/1/verify`, {
        method: "POST",
        headers: { Cookie: plainCookie },
      });
      if (res.status === 403) ok("POST /api/admin/users/:id/verify (non-admin)", "403");
      else fail("POST /api/admin/users/:id/verify (non-admin)", `expected 403, got ${res.status}`);
    }
    {
      const res = await fetch(`${BASE_URL}/api/admin/users/1`, { method: "DELETE", headers: { Cookie: plainCookie } });
      if (res.status === 403) ok("DELETE /api/admin/users/:id (non-admin)", "403");
      else fail("DELETE /api/admin/users/:id (non-admin)", `expected 403, got ${res.status}`);
    }
    {
      const res = await fetch(`${BASE_URL}/api/admin/users/1/promote`, {
        method: "POST",
        headers: { Cookie: plainCookie },
      });
      if (res.status === 403) ok("POST /api/admin/users/:id/promote (non-admin)", "403");
      else fail("POST /api/admin/users/:id/promote (non-admin)", `expected 403, got ${res.status}`);
    }
    {
      const res = await fetch(`${BASE_URL}/api/admin/users/1/demote`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: plainCookie },
        body: JSON.stringify({ note: "irrelevant" }),
      });
      if (res.status === 403) ok("POST /api/admin/users/:id/demote (non-admin)", "403");
      else fail("POST /api/admin/users/:id/demote (non-admin)", `expected 403, got ${res.status}`);
    }
    {
      const res = await fetch(`${BASE_URL}/api/admin/action-log`, { headers: { Cookie: plainCookie } });
      if (res.status === 403) ok("GET /api/admin/action-log (non-admin)", "403");
      else fail("GET /api/admin/action-log (non-admin)", `expected 403, got ${res.status}`);
    }

    // --- scenario 2: admin's list includes its own row ---
    {
      const res = await fetch(`${BASE_URL}/api/admin/users`, { headers: { Cookie: adminCookie } });
      const body = await res.json().catch(() => ({}));
      const found = Array.isArray(body.users) && body.users.some((u) => u.email === adminEmail);
      if (res.status === 200 && found && typeof body.total === "number") {
        ok("GET /api/admin/users (admin)", `200, total ${body.total}, includes self`);
      } else {
        fail("GET /api/admin/users (admin)", `status ${res.status}, body ${JSON.stringify(body)}`);
      }
    }

    // --- scenario 3: search actually filters ---
    {
      const res = await fetch(`${BASE_URL}/api/admin/users?search=${encodeURIComponent(adminEmail)}`, {
        headers: { Cookie: adminCookie },
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 200 && body.total === 1 && body.users?.[0]?.email === adminEmail) {
        ok("GET /api/admin/users?search=", `200, total 1, matches ${adminEmail}`);
      } else {
        fail("GET /api/admin/users?search=", `status ${res.status}, body ${JSON.stringify(body)}`);
      }
    }

    // --- scenario 4: verify flips DB state and logs an action ---
    const pendingEmail1 = `${RUN_TAG}-pending1@example.invalid`;
    let pendingId1;
    {
      const registerRes = await fetch(`${BASE_URL}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: pendingEmail1, password: TEST_PASSWORD, organizationName: `${RUN_TAG}-pending1` }),
      });
      if (registerRes.status !== 201) {
        fail("POST /api/auth/register (pending1 setup)", `expected 201, got ${registerRes.status}`);
      } else {
        createdEmails.push(pendingEmail1);
        pendingId1 = await getUserId(pool, pendingEmail1);
        const res = await fetch(`${BASE_URL}/api/admin/users/${pendingId1}/verify`, {
          method: "POST",
          headers: { Cookie: adminCookie },
        });
        const dbRow = await pool.query(
          "SELECT email_verified, email_verification_token FROM users WHERE id = $1",
          [pendingId1],
        );
        const verified = dbRow.rows[0]?.email_verified === true && dbRow.rows[0]?.email_verification_token === null;
        if (res.status === 200 && verified) {
          ok("POST /api/admin/users/:id/verify", "200, email_verified=true, token cleared");
        } else {
          fail("POST /api/admin/users/:id/verify", `status ${res.status}, db row ${JSON.stringify(dbRow.rows[0])}`);
        }

        const logRow = await pool.query(
          `SELECT action, target_user_id, target_email FROM admin_action_log
           WHERE actor_user_id = $1 AND action = 'verify' AND target_email = $2`,
          [adminId, pendingEmail1],
        );
        if (logRow.rowCount >= 1) ok("admin_action_log (verify)", "row written with correct actor/target");
        else fail("admin_action_log (verify)", "no matching row found");
      }
    }

    // --- scenario 5: promoting the now-verified user succeeds and logs it ---
    if (pendingId1) {
      const res = await fetch(`${BASE_URL}/api/admin/users/${pendingId1}/promote`, {
        method: "POST",
        headers: { Cookie: adminCookie },
      });
      const dbRow = await pool.query("SELECT is_super_admin FROM users WHERE id = $1", [pendingId1]);
      if (res.status === 200 && dbRow.rows[0]?.is_super_admin === true) {
        ok("POST /api/admin/users/:id/promote (verified)", "200, is_super_admin=true");
      } else {
        fail("POST /api/admin/users/:id/promote (verified)", `status ${res.status}, db row ${JSON.stringify(dbRow.rows[0])}`);
      }

      const logRow = await pool.query(
        `SELECT action FROM admin_action_log WHERE actor_user_id = $1 AND action = 'promote' AND target_email = $2`,
        [adminId, pendingEmail1],
      );
      if (logRow.rowCount >= 1) ok("admin_action_log (promote)", "row written with correct actor/target");
      else fail("admin_action_log (promote)", "no matching row found");
    }

    // --- scenario 6: promoting an UNVERIFIED user is rejected ---
    let unverifiedId;
    const unverifiedEmail = `${RUN_TAG}-unverified@example.invalid`;
    {
      await registerOnly(`${RUN_TAG}-unverified`);
      createdEmails.push(unverifiedEmail);
      unverifiedId = await getUserId(pool, unverifiedEmail);
      const res = await fetch(`${BASE_URL}/api/admin/users/${unverifiedId}/promote`, {
        method: "POST",
        headers: { Cookie: adminCookie },
      });
      const dbRow = await pool.query("SELECT is_super_admin FROM users WHERE id = $1", [unverifiedId]);
      if (res.status === 400 && dbRow.rows[0]?.is_super_admin === false) {
        ok("POST /api/admin/users/:id/promote (unverified)", "400, is_super_admin unchanged");
      } else {
        fail(
          "POST /api/admin/users/:id/promote (unverified)",
          `status ${res.status}, db row ${JSON.stringify(dbRow.rows[0])}`,
        );
      }
    }

    // --- scenario 7: demote without a note is rejected ---
    if (pendingId1) {
      const res = await fetch(`${BASE_URL}/api/admin/users/${pendingId1}/demote`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({}),
      });
      const dbRow = await pool.query("SELECT is_super_admin FROM users WHERE id = $1", [pendingId1]);
      if (res.status === 400 && dbRow.rows[0]?.is_super_admin === true) {
        ok("POST /api/admin/users/:id/demote (no note)", "400, is_super_admin unchanged");
      } else {
        fail("POST /api/admin/users/:id/demote (no note)", `status ${res.status}, db row ${JSON.stringify(dbRow.rows[0])}`);
      }
    }

    // --- scenario 8: self-demote is rejected ---
    {
      const res = await fetch(`${BASE_URL}/api/admin/users/${adminId}/demote`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ note: "trying to demote myself" }),
      });
      const dbRow = await pool.query("SELECT is_super_admin FROM users WHERE id = $1", [adminId]);
      if (res.status === 400 && dbRow.rows[0]?.is_super_admin === true) {
        ok("POST /api/admin/users/:id/demote (self)", "400, actor still a super-admin");
      } else {
        fail("POST /api/admin/users/:id/demote (self)", `status ${res.status}, db row ${JSON.stringify(dbRow.rows[0])}`);
      }
    }

    // --- scenario 9: demoting a non-super-admin is rejected ---
    {
      const targetId = await getUserId(pool, plainEmail);
      const res = await fetch(`${BASE_URL}/api/admin/users/${targetId}/demote`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ note: "not actually an admin" }),
      });
      if (res.status === 400) ok("POST /api/admin/users/:id/demote (not an admin)", "400");
      else fail("POST /api/admin/users/:id/demote (not an admin)", `expected 400, got ${res.status}`);
    }

    // --- scenario 10: a valid demote succeeds, flips state, and logs the note ---
    const demoteNoteText = "Verification testing: revoking scratch super-admin access";
    if (pendingId1) {
      const res = await fetch(`${BASE_URL}/api/admin/users/${pendingId1}/demote`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ note: demoteNoteText }),
      });
      const dbRow = await pool.query("SELECT is_super_admin FROM users WHERE id = $1", [pendingId1]);
      if (res.status === 200 && dbRow.rows[0]?.is_super_admin === false) {
        ok("POST /api/admin/users/:id/demote (valid)", "200, is_super_admin=false");
      } else {
        fail("POST /api/admin/users/:id/demote (valid)", `status ${res.status}, db row ${JSON.stringify(dbRow.rows[0])}`);
      }

      const logRow = await pool.query(
        `SELECT note FROM admin_action_log WHERE actor_user_id = $1 AND action = 'demote' AND target_email = $2`,
        [adminId, pendingEmail1],
      );
      if (logRow.rowCount >= 1 && logRow.rows[0].note === demoteNoteText) {
        ok("admin_action_log (demote)", "row written with matching note");
      } else {
        fail("admin_action_log (demote)", `expected note ${JSON.stringify(demoteNoteText)}, got ${JSON.stringify(logRow.rows[0])}`);
      }
    }

    // --- scenario 11: delete removes a pending user, log row survives ---
    const pendingEmail2 = `${RUN_TAG}-pending2@example.invalid`;
    {
      const registerRes = await fetch(`${BASE_URL}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: pendingEmail2, password: TEST_PASSWORD, organizationName: `${RUN_TAG}-pending2` }),
      });
      if (registerRes.status !== 201) {
        fail("POST /api/auth/register (pending2 setup)", `expected 201, got ${registerRes.status}`);
      } else {
        const targetId = await getUserId(pool, pendingEmail2);
        const res = await fetch(`${BASE_URL}/api/admin/users/${targetId}`, {
          method: "DELETE",
          headers: { Cookie: adminCookie },
        });
        const gone = await pool.query("SELECT 1 FROM users WHERE id = $1", [targetId]);
        if (res.status === 204 && gone.rowCount === 0) {
          ok("DELETE /api/admin/users/:id (pending)", "204, user row removed");
        } else {
          fail("DELETE /api/admin/users/:id (pending)", `status ${res.status}, still present: ${gone.rowCount > 0}`);
        }

        const logRow = await pool.query(
          `SELECT action, target_user_id, target_email FROM admin_action_log
           WHERE actor_user_id = $1 AND action = 'delete' AND target_email = $2`,
          [adminId, pendingEmail2],
        );
        if (logRow.rowCount >= 1) {
          ok("admin_action_log (delete)", "row survives target deletion (target_user_id not an FK)");
        } else {
          fail("admin_action_log (delete)", "no matching row found");
        }
      }
    }

    // --- scenario 12: deleting a VERIFIED user is rejected, nothing changes ---
    {
      const targetId = await getUserId(pool, plainEmail); // plainEmail was verified during setup
      const res = await fetch(`${BASE_URL}/api/admin/users/${targetId}`, {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      });
      const body = await res.json().catch(() => ({}));
      const stillThere = await pool.query("SELECT 1 FROM users WHERE id = $1", [targetId]);
      if (res.status === 409 && body.reason === "already_verified" && stillThere.rowCount === 1) {
        ok("DELETE /api/admin/users/:id (verified)", "409, reason already_verified, row untouched");
      } else {
        fail(
          "DELETE /api/admin/users/:id (verified)",
          `status ${res.status}, body ${JSON.stringify(body)}, stillThere ${stillThere.rowCount === 1}`,
        );
      }
    }

    // --- scenario 13: 404s on a nonexistent id ---
    {
      const res = await fetch(`${BASE_URL}/api/admin/users/999999999/verify`, {
        method: "POST",
        headers: { Cookie: adminCookie },
      });
      if (res.status === 404) ok("POST /api/admin/users/:id/verify (unknown id)", "404");
      else fail("POST /api/admin/users/:id/verify (unknown id)", `expected 404, got ${res.status}`);
    }
    {
      const res = await fetch(`${BASE_URL}/api/admin/users/999999999`, {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      });
      if (res.status === 404) ok("DELETE /api/admin/users/:id (unknown id)", "404");
      else fail("DELETE /api/admin/users/:id (unknown id)", `expected 404, got ${res.status}`);
    }
    {
      const res = await fetch(`${BASE_URL}/api/admin/users/999999999/promote`, {
        method: "POST",
        headers: { Cookie: adminCookie },
      });
      if (res.status === 404) ok("POST /api/admin/users/:id/promote (unknown id)", "404");
      else fail("POST /api/admin/users/:id/promote (unknown id)", `expected 404, got ${res.status}`);
    }
    {
      const res = await fetch(`${BASE_URL}/api/admin/users/999999999/demote`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ note: "n/a" }),
      });
      if (res.status === 404) ok("POST /api/admin/users/:id/demote (unknown id)", "404");
      else fail("POST /api/admin/users/:id/demote (unknown id)", `expected 404, got ${res.status}`);
    }

    // --- scenario 14: action-log endpoint returns what was just written ---
    {
      const res = await fetch(`${BASE_URL}/api/admin/action-log`, { headers: { Cookie: adminCookie } });
      const body = await res.json().catch(() => ({}));
      const hasVerify = Array.isArray(body.entries) && body.entries.some((e) => e.targetEmail === pendingEmail1 && e.action === "verify");
      const hasPromote = Array.isArray(body.entries) && body.entries.some((e) => e.targetEmail === pendingEmail1 && e.action === "promote");
      const hasDemote = Array.isArray(body.entries) && body.entries.some((e) => e.targetEmail === pendingEmail1 && e.action === "demote" && e.note === demoteNoteText);
      const hasDelete = Array.isArray(body.entries) && body.entries.some((e) => e.targetEmail === pendingEmail2 && e.action === "delete");
      if (res.status === 200 && hasVerify && hasPromote && hasDemote && hasDelete) {
        ok("GET /api/admin/action-log", "200, contains this run's verify/promote/demote/delete entries, demote note matches");
      } else {
        fail("GET /api/admin/action-log", `status ${res.status}, entries ${JSON.stringify(body.entries?.slice(0, 5))}`);
      }
    }
  } finally {
    // Cleanup. Order matters: admin_action_log.actor_user_id is a real FK
    // with no cascade (same class of constraint as
    // emission_factors.uploaded_by) -- the admin-actor's own log rows must
    // be deleted before that actor's users row, or this cleanup would hit
    // the exact FK failure the feature's delete-scope decision was
    // designed around. Target-side log rows from scenarios 4, 5, 10, and
    // 12 also need direct cleanup (their users weren't deleted by the
    // endpoints under test). Scenario 11's target user is already gone --
    // only its now-orphaned log row remains, caught by the same LIKE query
    // below. pendingEmail1 was promoted to super-admin during the run
    // (then demoted back), so it also needs its own admin_action_log rows
    // cleared before it can be deleted (it was briefly an actor-eligible
    // account, not just a target).
    try {
      const emailsToClean = [...createdEmails];
      const pendingId1Email = `${RUN_TAG}-pending1@example.invalid`;
      if (!emailsToClean.includes(pendingId1Email)) emailsToClean.push(pendingId1Email);
      const remaining = await pool.query("SELECT id, email FROM users WHERE email = ANY($1)", [emailsToClean]);
      const remainingIds = remaining.rows.map((r) => r.id);
      if (remainingIds.length > 0) {
        await pool.query("DELETE FROM admin_action_log WHERE actor_user_id = ANY($1)", [remainingIds]);
      }
      await pool.query("DELETE FROM admin_action_log WHERE target_email LIKE $1", [`${RUN_TAG}%`]);
      for (const row of remaining.rows) {
        const m = await pool.query("SELECT organization_id FROM memberships WHERE user_id = $1", [row.id]);
        const orgId = m.rows[0]?.organization_id;
        if (orgId) await pool.query("DELETE FROM organizations WHERE id = $1", [orgId]);
        await pool.query("DELETE FROM users WHERE id = $1", [row.id]);
      }
    } catch (cleanupErr) {
      console.error("cleanup failed:", cleanupErr);
    }
    await pool.end();
  }

  console.log("");
  console.log(`[verify-admin-panel] ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
