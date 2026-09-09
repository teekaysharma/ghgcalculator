// scripts/verify-admin-panel.mjs
//
// Dedicated test for the platform super-admin panel (GET /api/admin/users,
// POST /api/admin/users/:id/verify, DELETE /api/admin/users/:id,
// POST /api/admin/users/:id/promote, POST /api/admin/users/:id/demote,
// GET /api/admin/action-log) AND, as of the 2026-09-04
// membership-lifecycle-management plan, the membership/account lifecycle
// routes layered on top of it: POST /api/admin/memberships/:id/deactivate|
// activate, POST /api/admin/users/:id/deactivate|reactivate|change-email|
// reset-password, POST /api/auth/forgot-password, POST /api/auth/reset-password,
// the org-admin self-service equivalents under /api/team/..., and
// GET /api/team/action-log. The 2026-09-09 final-review fix wave added
// coverage of GET /api/cron/cleanup-unverified-users on top (the daily
// unverified-registration sweep, which one of the fixed findings made
// reachable against live tenant data) -- kept separate from scripts/verify-branch.mjs
// on purpose (see docs/superpowers/specs/2026-09-04-super-admin-panel-design.md
// and docs/superpowers/specs/2026-09-04-membership-lifecycle-management-design.md):
// it deletes data, so it isn't something to run on every npm run verify pass.
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
import bcrypt from "bcryptjs";

const PORT = process.env.PORT || "5000";
const BASE_URL = `http://localhost:${PORT}`;
const RUN_TAG = `admintest-${Date.now()}`;
const TEST_PASSWORD = "AdminTest12345";
// Used only by the membership-lifecycle scenarios below, after a
// deactivate/change-email/reset-password flow has replaced TEST_PASSWORD.
const NEW_PASSWORD = "AdminTestReset67890";
// Matches server/auth.ts's SALT_ROUNDS -- seedOwner (below) hashes its own
// fixture passwords the same way a real register does.
const SALT_ROUNDS = 12;

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

// POST /api/auth/register is capped at 5 requests/hour per IP
// (registerLimiter in server/routes.ts), shared across every register call
// this dev server sees regardless of which script or test made it. This
// file's original 15 scenarios already spend that entire budget on their
// own five registrations (see the comment on scenario 15 below) -- so the
// membership-lifecycle scenarios added after them need another way to get
// scratch accounts. seedOwner creates one directly via SQL instead of
// through the rate-limited endpoint: same bcrypt hashing (SALT_ROUNDS,
// matching server/auth.ts's hashPassword), same
// users+organizations+memberships(role: owner) shape a real register
// produces, just without the HTTP round trip or the token-based
// verify-email step. Every actual scenario step below (login, deactivate,
// invite, etc.) still exercises the real HTTP routes -- only this initial
// fixture creation is seeded.
//
// has_been_verified is seeded to match `verified`, not left at its column
// default: the invariant the app maintains is that has_been_verified is true
// wherever email_verified has EVER been true (storage.verifyUserEmail and
// storage.resetPassword both set the pair together), and only
// setNewEmailPendingVerification ever splits them. A verified fixture left at
// has_been_verified = false would be a state the app cannot produce, and would
// make itself wrongly eligible for both hard-delete paths -- exactly the
// distinction the C2 scenarios below exist to test.
async function seedOwner(pool, tag, { verified = true } = {}) {
  const email = `${tag}@example.invalid`;
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, SALT_ROUNDS);
  const userRes = await pool.query(
    "INSERT INTO users (email, password_hash, email_verified, has_been_verified) VALUES ($1, $2, $3, $3) RETURNING id",
    [email, passwordHash, verified],
  );
  const userId = userRes.rows[0].id;
  const orgRes = await pool.query(
    "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
    [tag, tag],
  );
  const organizationId = orgRes.rows[0].id;
  await pool.query(
    "INSERT INTO memberships (user_id, organization_id, role) VALUES ($1, $2, 'owner')",
    [userId, organizationId],
  );
  return { email, userId, organizationId };
}

// seedOwner's sibling for the rank-ceiling scenarios (27-28): seeds an
// account whose ONLY membership is in an organization that already exists,
// rather than standing up an org of its own. That distinction is the whole
// point for those scenarios -- storage.isUsersSoleOrganization must resolve
// to the acting org-admin's org (so the boundary check passes and the new
// rank check is what actually rejects), which a seedOwner account never
// does. Because there's no org of its own to delete, the cleanup block at
// the end of this file strips this membership row explicitly rather than
// letting the per-user loop infer an org to remove.
async function seedMemberInOrg(pool, tag, organizationId, role = "member", { verified = true } = {}) {
  const email = `${tag}@example.invalid`;
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, SALT_ROUNDS);
  const userRes = await pool.query(
    "INSERT INTO users (email, password_hash, email_verified, has_been_verified) VALUES ($1, $2, $3, $3) RETURNING id",
    [email, passwordHash, verified],
  );
  const userId = userRes.rows[0].id;
  await pool.query(
    "INSERT INTO memberships (user_id, organization_id, role) VALUES ($1, $2, $3)",
    [userId, organizationId, role],
  );
  return { email, userId, organizationId };
}

// Fires all four org-admin account-wide routes at one target and returns each
// one's status plus the message it rejected with. Shaped like scenario 24's
// own local attemptAllFour (which predates this and stays as-is), but hoisted
// to module scope because the rank-ceiling scenarios below need it twice, and
// it returns the messages too so those scenarios can prove WHICH guard
// rejected -- a 403 from the sole-organization boundary rule and a 403 from
// the rank ceiling are different findings and must not be confused.
async function attemptAllAccountActions({ cookie, organizationId, targetUserId, newEmail }) {
  const headers = {
    "Content-Type": "application/json",
    Cookie: cookie,
    ...(organizationId ? { "X-Organization-Id": String(organizationId) } : {}),
  };
  const responses = [
    [
      "deactivate",
      await fetch(`${BASE_URL}/api/team/members/${targetUserId}/deactivate`, {
        method: "POST",
        headers,
        body: JSON.stringify({ note: "rank ceiling probe" }),
      }),
    ],
    ["reactivate", await fetch(`${BASE_URL}/api/team/members/${targetUserId}/reactivate`, { method: "POST", headers })],
    [
      "changeEmail",
      await fetch(`${BASE_URL}/api/team/members/${targetUserId}/change-email`, {
        method: "POST",
        headers,
        body: JSON.stringify({ newEmail, note: "rank ceiling probe" }),
      }),
    ],
    [
      "resetPassword",
      await fetch(`${BASE_URL}/api/team/members/${targetUserId}/reset-password`, {
        method: "POST",
        headers,
        body: JSON.stringify({ note: "rank ceiling probe" }),
      }),
    ],
  ];
  const results = {};
  for (const [label, res] of responses) {
    const body = await res.json().catch(() => ({}));
    results[label] = { status: res.status, message: body.message || "" };
  }
  return results;
}

// Runs the real daily sweep (storage.deleteExpiredUnverifiedRegistrations, via
// GET /api/cron/cleanup-unverified-users) without turning it into collateral
// damage. That sweep is global by design -- it matches every never-verified
// account on the platform whose verification token has expired -- and the
// shared dev database carries hand-registered scratch accounts from earlier
// sessions that would qualify. So every unverified row that is NOT this run's
// own fixture has its token expiry parked far in the future for the duration of
// the call and restored to its exact previous value afterward (including NULL),
// leaving that data exactly as it was found. Rows whose expiry is already NULL
// can never match the sweep's `expires_at < now()` predicate and are left
// alone entirely.
async function runCleanupSweepScopedToThisRun(pool, runTag) {
  const protectedRows = await pool.query(
    `SELECT id, email_verification_token_expires_at AS exp FROM users
      WHERE has_been_verified = false
        AND email_verification_token_expires_at IS NOT NULL
        AND email NOT LIKE $1`,
    [`${runTag}%`],
  );
  if (protectedRows.rowCount > 0) {
    await pool.query(
      `UPDATE users SET email_verification_token_expires_at = now() + interval '100 years'
        WHERE id = ANY($1)`,
      [protectedRows.rows.map((r) => r.id)],
    );
  }
  try {
    const res = await fetch(`${BASE_URL}/api/cron/cleanup-unverified-users`, {
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body, protectedCount: protectedRows.rowCount };
  } finally {
    for (const row of protectedRows.rows) {
      await pool.query("UPDATE users SET email_verification_token_expires_at = $1 WHERE id = $2", [row.exp, row.id]);
    }
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    fail("setup", "DATABASE_URL not set");
    process.exit(1);
  }
  if (!process.env.CRON_SECRET) {
    fail("setup", "CRON_SECRET not set in .env -- needed by the C2 sweep scenarios");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const createdEmails = [];
  // Declared here (rather than inside the try block below, where the rest
  // of this file's scenario-scoped `let`s live) because the cleanup step in
  // `finally` needs to read s8OrgAOwner/s9Boundary's ids -- a `let` inside
  // `try { ... }` is not visible from a sibling `finally { ... }` block.
  let s8OrgAOwner;
  let s9Boundary;
  // Scenario 27's fixture: seeded via seedMemberInOrg, so its only membership
  // is org A's -- it has no org of its own for the cleanup loop to infer, and
  // that membership row has to be stripped explicitly in `finally` below.
  let c1SuperAdminInOrgA;

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
        createdEmails.push(pendingEmail2);
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

    // --- scenario 15: deleting a user who ALSO holds a membership in a
    // different, live organization must never touch that live org
    // (regression test for the deleteUnverifiedUserById fix -- the old
    // arbitrary userMemberships[0] pick could select the invited-into org
    // instead of the target's own, and hard-delete an unrelated tenant).
    // Reuses unverifiedId/unverifiedEmail from scenario 6 above (instead of
    // registering a fresh account) to stay within POST /api/auth/register's
    // 5-per-hour rate limit -- this script's other five registrations
    // already use up that budget in a single run. ---
    if (unverifiedId) {
      // plainEmail invites the still-UNVERIFIED account into its own org --
      // POST /api/team/invite has no emailVerified check (the real-world
      // hole this scenario reproduces), so this succeeds and unverifiedId
      // ends up with two memberships: owner of its own solo org (from
      // scenario 6's registration), and member of plainEmail's separate,
      // live org.
      const inviteRes = await fetch(`${BASE_URL}/api/team/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: plainCookie },
        body: JSON.stringify({ email: unverifiedEmail }),
      });
      if (inviteRes.status === 201) {
        ok("POST /api/team/invite (unverified user into a different live org)", "201");
      } else {
        fail("POST /api/team/invite (unverified user into a different live org)", `expected 201, got ${inviteRes.status}`);
      }

      const plainId = await getUserId(pool, plainEmail);
      const plainOrgRow = await pool.query(
        "SELECT organization_id FROM memberships WHERE user_id = $1 AND role = 'owner'",
        [plainId],
      );
      const plainOrgId = plainOrgRow.rows[0]?.organization_id;

      const deleteRes = await fetch(`${BASE_URL}/api/admin/users/${unverifiedId}`, {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      });
      const targetGone = await pool.query("SELECT 1 FROM users WHERE id = $1", [unverifiedId]);
      const targetOrgGone = await pool.query("SELECT 1 FROM organizations WHERE name = $1", [`${RUN_TAG}-unverified`]);
      if (deleteRes.status === 204 && targetGone.rowCount === 0 && targetOrgGone.rowCount === 0) {
        ok("DELETE /api/admin/users/:id (cross-membership target)", "204, target row and its own solo-owned org both gone");
      } else {
        fail(
          "DELETE /api/admin/users/:id (cross-membership target)",
          `status ${deleteRes.status}, target row gone: ${targetGone.rowCount === 0}, target org gone: ${targetOrgGone.rowCount === 0}`,
        );
      }

      const plainOrgStill = plainOrgId
        ? await pool.query("SELECT 1 FROM organizations WHERE id = $1", [plainOrgId])
        : { rowCount: 0 };
      const plainUserStill = await pool.query("SELECT 1 FROM users WHERE id = $1", [plainId]);
      if (plainOrgId && plainOrgStill.rowCount === 1 && plainUserStill.rowCount === 1) {
        ok(
          "deleteUnverifiedUserById leaves the invited-into live org untouched",
          `org ${plainOrgId} and plainEmail's user row both still present`,
        );
      } else {
        fail(
          "deleteUnverifiedUserById leaves the invited-into live org untouched",
          `plainOrgId ${plainOrgId}, org present: ${plainOrgStill.rowCount === 1}, plainEmail user present: ${plainUserStill.rowCount === 1}`,
        );
      }
    }

    // =========================================================================
    // Membership/account lifecycle (2026-09-04 membership-lifecycle-management
    // plan, Task 8). Scenarios 16-26 below. New scratch accounts are seeded
    // via seedOwner (direct SQL) rather than registerAndVerify/registerOnly,
    // for the rate-limit reason documented on that helper above -- but every
    // scenario STEP itself still exercises the real HTTP routes.
    // =========================================================================

    // --- scenario 16: membership deactivate blocks requireOrg access (which
    // re-resolves fresh on every request, never trusting anything cached on
    // the session), reactivate restores it ---
    // s1Cookie outlives this block: scenario 31 (I1) reuses this exact
    // already-issued cookie to prove the ACCOUNT-level equivalent of what this
    // scenario proves for a membership, without spending another of POST
    // /api/auth/login's 10-per-15-minutes budget.
    let s1, s1MembershipId, s1Cookie;
    {
      s1 = await seedOwner(pool, `${RUN_TAG}-s1`);
      createdEmails.push(s1.email);
      s1Cookie = await login(s1.email);
      const membershipRow = await pool.query("SELECT id FROM memberships WHERE user_id = $1", [s1.userId]);
      s1MembershipId = membershipRow.rows[0]?.id;

      const before = await fetch(`${BASE_URL}/api/setup-status`, { headers: { Cookie: s1Cookie } });
      if (before.status === 200) ok("GET /api/setup-status (active membership)", "200");
      else fail("GET /api/setup-status (active membership)", `expected 200, got ${before.status}`);

      const deactivateRes = await fetch(`${BASE_URL}/api/admin/memberships/${s1MembershipId}/deactivate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ note: "Verification testing: membership deactivate" }),
      });
      if (deactivateRes.status === 200) ok("POST /api/admin/memberships/:id/deactivate", "200");
      else fail("POST /api/admin/memberships/:id/deactivate", `expected 200, got ${deactivateRes.status}`);

      // Same already-issued session cookie, no fresh login -- proves
      // requireOrg re-resolves membership state per request rather than
      // trusting anything set at login time.
      const afterDeactivate = await fetch(`${BASE_URL}/api/setup-status`, { headers: { Cookie: s1Cookie } });
      const afterDeactivateBody = await afterDeactivate.json().catch(() => ({}));
      if (afterDeactivate.status === 403 && /No organization membership found/.test(afterDeactivateBody.message || "")) {
        ok("GET /api/setup-status (deactivated membership, same cookie)", "403, No organization membership found");
      } else {
        fail(
          "GET /api/setup-status (deactivated membership, same cookie)",
          `expected 403 + message, got ${afterDeactivate.status}, body ${JSON.stringify(afterDeactivateBody)}`,
        );
      }

      const activateRes = await fetch(`${BASE_URL}/api/admin/memberships/${s1MembershipId}/activate`, {
        method: "POST",
        headers: { Cookie: adminCookie },
      });
      if (activateRes.status === 200) ok("POST /api/admin/memberships/:id/activate", "200");
      else fail("POST /api/admin/memberships/:id/activate", `expected 200, got ${activateRes.status}`);

      const afterActivate = await fetch(`${BASE_URL}/api/setup-status`, { headers: { Cookie: s1Cookie } });
      if (afterActivate.status === 200) ok("GET /api/setup-status (reactivated membership, same cookie)", "200");
      else fail("GET /api/setup-status (reactivated membership, same cookie)", `expected 200, got ${afterActivate.status}`);
    }

    // --- scenario 17: account deactivate blocks login (401, reason
    // deactivated), reactivate restores it ---
    let s2;
    {
      s2 = await seedOwner(pool, `${RUN_TAG}-s2`);
      createdEmails.push(s2.email);

      const deactivateRes = await fetch(`${BASE_URL}/api/admin/users/${s2.userId}/deactivate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ note: "Verification testing: account deactivate" }),
      });
      const deactivateBody = await deactivateRes.json().catch(() => ({}));
      if (deactivateRes.status === 200 && deactivateBody.user?.isActive === false) {
        ok("POST /api/admin/users/:id/deactivate", "200, isActive false");
      } else {
        fail("POST /api/admin/users/:id/deactivate", `status ${deactivateRes.status}, body ${JSON.stringify(deactivateBody)}`);
      }

      const loginBlocked = await fetch(`${BASE_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: s2.email, password: TEST_PASSWORD }),
      });
      const loginBlockedBody = await loginBlocked.json().catch(() => ({}));
      if (loginBlocked.status === 401 && loginBlockedBody.reason === "deactivated") {
        ok("POST /api/auth/login (deactivated account)", "401, reason: deactivated");
      } else {
        fail(
          "POST /api/auth/login (deactivated account)",
          `expected 401 + reason deactivated, got ${loginBlocked.status}, body ${JSON.stringify(loginBlockedBody)}`,
        );
      }

      const reactivateRes = await fetch(`${BASE_URL}/api/admin/users/${s2.userId}/reactivate`, {
        method: "POST",
        headers: { Cookie: adminCookie },
      });
      const reactivateBody = await reactivateRes.json().catch(() => ({}));
      if (reactivateRes.status === 200 && reactivateBody.user?.isActive === true) {
        ok("POST /api/admin/users/:id/reactivate", "200, isActive true");
      } else {
        fail("POST /api/admin/users/:id/reactivate", `status ${reactivateRes.status}, body ${JSON.stringify(reactivateBody)}`);
      }

      const loginRestored = await fetch(`${BASE_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: s2.email, password: TEST_PASSWORD }),
      });
      if (loginRestored.status === 200) ok("POST /api/auth/login (reactivated account)", "200");
      else fail("POST /api/auth/login (reactivated account)", `expected 200, got ${loginRestored.status}`);
    }

    // --- scenario 18: deactivating an UNVERIFIED account is rejected ---
    let s3;
    {
      s3 = await seedOwner(pool, `${RUN_TAG}-s3`, { verified: false });
      createdEmails.push(s3.email);
      const res = await fetch(`${BASE_URL}/api/admin/users/${s3.userId}/deactivate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ note: "should be rejected" }),
      });
      if (res.status === 400) ok("POST /api/admin/users/:id/deactivate (unverified)", "400");
      else fail("POST /api/admin/users/:id/deactivate (unverified)", `expected 400, got ${res.status}`);
    }

    // --- scenario 19: change-email end to end -- admin sets a new email, the
    // new address claims it via the same reset-password token mechanism
    // forgot-password uses, and the old password stops working while the new
    // one works. The "old password no longer authenticates" half is checked
    // by comparing directly against the stored hash (bcrypt.compare) rather
    // than a live login call, to stay within POST /api/auth/login's own
    // 10-per-15-minutes rate limit alongside every other login in this file. ---
    {
      const s4 = await seedOwner(pool, `${RUN_TAG}-s4`);
      const s4NewEmail = `${RUN_TAG}-s4-new@example.invalid`;
      createdEmails.push(s4NewEmail);

      const changeRes = await fetch(`${BASE_URL}/api/admin/users/${s4.userId}/change-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ newEmail: s4NewEmail, note: "Verification testing: change-email" }),
      });
      const changeBody = await changeRes.json().catch(() => ({}));
      if (changeRes.status === 200 && changeBody.user?.email === s4NewEmail) {
        ok("POST /api/admin/users/:id/change-email", `200, email now ${s4NewEmail}`);
      } else {
        fail("POST /api/admin/users/:id/change-email", `status ${changeRes.status}, body ${JSON.stringify(changeBody)}`);
      }

      const tokenRow = await pool.query("SELECT password_reset_token FROM users WHERE email = $1", [s4NewEmail]);
      const token = tokenRow.rows[0]?.password_reset_token;
      if (!token) fail("change-email token", "no password_reset_token found for the new email");

      const resetRes = await fetch(`${BASE_URL}/api/auth/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword: NEW_PASSWORD }),
      });
      if (resetRes.status === 200) ok("POST /api/auth/reset-password (after change-email)", "200");
      else fail("POST /api/auth/reset-password (after change-email)", `expected 200, got ${resetRes.status}`);

      const dbRow = await pool.query("SELECT email_verified, password_hash FROM users WHERE id = $1", [s4.userId]);
      const emailVerified = dbRow.rows[0]?.email_verified;
      const newHash = dbRow.rows[0]?.password_hash;
      const oldStillMatches = newHash ? await bcrypt.compare(TEST_PASSWORD, newHash) : true;
      const newMatches = newHash ? await bcrypt.compare(NEW_PASSWORD, newHash) : false;
      if (emailVerified === true && !oldStillMatches && newMatches) {
        ok("change-email + reset-password DB state", "email_verified=true, old password hash no longer matches, new one does");
      } else {
        fail(
          "change-email + reset-password DB state",
          `email_verified ${emailVerified}, old still matches ${oldStillMatches}, new matches ${newMatches}`,
        );
      }

      const loginNew = await fetch(`${BASE_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: s4NewEmail, password: NEW_PASSWORD }),
      });
      if (loginNew.status === 200) ok("POST /api/auth/login (new email + new password)", "200");
      else fail("POST /api/auth/login (new email + new password)", `expected 200, got ${loginNew.status}`);
    }

    // --- scenario 20: admin-triggered reset-password end to end -- same
    // token mechanism as change-email (scenario 19), but the email itself
    // never changes ---
    {
      const s5 = await seedOwner(pool, `${RUN_TAG}-s5`);
      createdEmails.push(s5.email);

      const resetTriggerRes = await fetch(`${BASE_URL}/api/admin/users/${s5.userId}/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ note: "Verification testing: admin reset-password" }),
      });
      if (resetTriggerRes.status === 200) ok("POST /api/admin/users/:id/reset-password", "200");
      else fail("POST /api/admin/users/:id/reset-password", `expected 200, got ${resetTriggerRes.status}`);

      const tokenRow = await pool.query("SELECT password_reset_token FROM users WHERE email = $1", [s5.email]);
      const token = tokenRow.rows[0]?.password_reset_token;
      if (!token) fail("admin reset-password token", "no password_reset_token found");

      const resetRes = await fetch(`${BASE_URL}/api/auth/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword: NEW_PASSWORD }),
      });
      if (resetRes.status === 200) ok("POST /api/auth/reset-password (after admin trigger)", "200");
      else fail("POST /api/auth/reset-password (after admin trigger)", `expected 200, got ${resetRes.status}`);

      const dbRow = await pool.query("SELECT password_hash FROM users WHERE id = $1", [s5.userId]);
      const newHash = dbRow.rows[0]?.password_hash;
      const oldStillMatches = newHash ? await bcrypt.compare(TEST_PASSWORD, newHash) : true;
      if (!oldStillMatches) ok("admin reset-password DB state", "old password hash no longer matches");
      else fail("admin reset-password DB state", "old password still matches after reset");

      const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: s5.email, password: NEW_PASSWORD }),
      });
      if (loginRes.status === 200) ok("POST /api/auth/login (after admin reset-password)", "200");
      else fail("POST /api/auth/login (after admin reset-password)", `expected 200, got ${loginRes.status}`);
    }

    // --- scenario 21: self-service forgot-password end to end ---
    {
      const s6 = await seedOwner(pool, `${RUN_TAG}-s6`);
      createdEmails.push(s6.email);

      const forgotRes = await fetch(`${BASE_URL}/api/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: s6.email }),
      });
      if (forgotRes.status === 200) ok("POST /api/auth/forgot-password (verified account)", "200");
      else fail("POST /api/auth/forgot-password (verified account)", `expected 200, got ${forgotRes.status}`);

      const tokenRow = await pool.query("SELECT password_reset_token FROM users WHERE email = $1", [s6.email]);
      const token = tokenRow.rows[0]?.password_reset_token;
      if (!token) fail("forgot-password token", "no password_reset_token found");

      const resetRes = await fetch(`${BASE_URL}/api/auth/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword: NEW_PASSWORD }),
      });
      if (resetRes.status === 200) ok("POST /api/auth/reset-password (self-service)", "200");
      else fail("POST /api/auth/reset-password (self-service)", `expected 200, got ${resetRes.status}`);

      const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: s6.email, password: NEW_PASSWORD }),
      });
      if (loginRes.status === 200) ok("POST /api/auth/login (after self-service reset)", "200");
      else fail("POST /api/auth/login (after self-service reset)", `expected 200, got ${loginRes.status}`);
    }

    // --- scenario 22: forgot-password's response is byte-identical whether
    // the account doesn't exist, is unverified, or is verified -- and only
    // the verified case actually writes a token. Reuses s3 (unverified, from
    // scenario 18) and s2 (verified + reactivated, from scenario 17) rather
    // than registering fresh accounts, to stay within forgot-password's own
    // 5-per-hour rate limit alongside scenario 21's call above (nonexistent +
    // unverified + verified + scenario 21's own call = 4 of the 5). ---
    {
      const nonexistentEmail = `${RUN_TAG}-nonexistent@example.invalid`;
      const responses = {};
      for (const [label, email] of [
        ["nonexistent", nonexistentEmail],
        ["unverified", s3.email],
        ["verified", s2.email],
      ]) {
        const res = await fetch(`${BASE_URL}/api/auth/forgot-password`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });
        const body = await res.json().catch(() => ({}));
        responses[label] = { status: res.status, body };
      }
      const allSameShape =
        responses.nonexistent.status === 200 &&
        responses.unverified.status === 200 &&
        responses.verified.status === 200 &&
        responses.nonexistent.body.message === responses.unverified.body.message &&
        responses.unverified.body.message === responses.verified.body.message;
      if (allSameShape) {
        ok("POST /api/auth/forgot-password (identical response shape)", `200, "${responses.verified.body.message}" for all three`);
      } else {
        fail("POST /api/auth/forgot-password (identical response shape)", JSON.stringify(responses));
      }

      const unverifiedToken = await pool.query("SELECT password_reset_token FROM users WHERE email = $1", [s3.email]);
      const verifiedToken = await pool.query("SELECT password_reset_token FROM users WHERE email = $1", [s2.email]);
      if (unverifiedToken.rows[0]?.password_reset_token === null && verifiedToken.rows[0]?.password_reset_token) {
        ok("forgot-password token issuance", "unverified account got no token, verified account did");
      } else {
        fail(
          "forgot-password token issuance",
          `unverified token ${JSON.stringify(unverifiedToken.rows[0])}, verified token present: ${!!verifiedToken.rows[0]?.password_reset_token}`,
        );
      }
    }

    // --- scenario 23: org-admin membership deactivate/activate is scoped to
    // their own org. plainEmail is invited into a fresh second org (org A)
    // here and reused as scenario 25's non-owner/admin session too, rather
    // than registering yet another fresh account. ---
    // s8OrgAOwner itself is declared above main()'s try block (needed by
    // the finally-block cleanup); s8OrgAOwnerCookie/plainMembershipInOrgAId
    // are only needed within this try block's later scenarios.
    let s8OrgAOwnerCookie, plainMembershipInOrgAId;
    {
      s8OrgAOwner = await seedOwner(pool, `${RUN_TAG}-s8orga`);
      createdEmails.push(s8OrgAOwner.email);
      s8OrgAOwnerCookie = await login(s8OrgAOwner.email);

      const inviteRes = await fetch(`${BASE_URL}/api/team/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: s8OrgAOwnerCookie },
        body: JSON.stringify({ email: plainEmail }),
      });
      if (inviteRes.status === 201) ok("POST /api/team/invite (plainEmail into org A)", "201");
      else fail("POST /api/team/invite (plainEmail into org A)", `expected 201, got ${inviteRes.status}`);

      const plainIdForInvite = await getUserId(pool, plainEmail);
      const membershipRow = await pool.query(
        "SELECT id FROM memberships WHERE user_id = $1 AND organization_id = $2",
        [plainIdForInvite, s8OrgAOwner.organizationId],
      );
      plainMembershipInOrgAId = membershipRow.rows[0]?.id;

      const deactivateRes = await fetch(`${BASE_URL}/api/team/memberships/${plainMembershipInOrgAId}/deactivate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: s8OrgAOwnerCookie },
        body: JSON.stringify({ note: "Verification testing: org-admin membership deactivate" }),
      });
      const deactivateBody = await deactivateRes.json().catch(() => ({}));
      if (deactivateRes.status === 200 && deactivateBody.membership?.isActive === false) {
        ok("POST /api/team/memberships/:id/deactivate (own org)", "200, isActive false");
      } else {
        fail("POST /api/team/memberships/:id/deactivate (own org)", `status ${deactivateRes.status}, body ${JSON.stringify(deactivateBody)}`);
      }

      const activateRes = await fetch(`${BASE_URL}/api/team/memberships/${plainMembershipInOrgAId}/activate`, {
        method: "POST",
        headers: { Cookie: s8OrgAOwnerCookie },
      });
      const activateBody = await activateRes.json().catch(() => ({}));
      if (activateRes.status === 200 && activateBody.membership?.isActive === true) {
        ok("POST /api/team/memberships/:id/activate (own org)", "200, isActive true");
      } else {
        fail("POST /api/team/memberships/:id/activate (own org)", `status ${activateRes.status}, body ${JSON.stringify(activateBody)}`);
      }

      // A membership in a DIFFERENT org (s1's, from scenario 16) must be out
      // of scope for s8OrgAOwner: 404 (not found), not 403 -- the org-admin
      // route scopes its DB update by organization id, so a cross-org id
      // simply never matches a row.
      const crossOrgRes = await fetch(`${BASE_URL}/api/team/memberships/${s1MembershipId}/deactivate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: s8OrgAOwnerCookie },
        body: JSON.stringify({ note: "should be out of scope" }),
      });
      if (crossOrgRes.status === 404) ok("POST /api/team/memberships/:id/deactivate (different org)", "404");
      else fail("POST /api/team/memberships/:id/deactivate (different org)", `expected 404, got ${crossOrgRes.status}`);
    }

    // --- scenario 24: org-admin account-wide boundary rule. An org-admin may
    // only deactivate/reactivate/change-email/reset-password a member's
    // ACCOUNT (as opposed to just one membership) when that account's
    // memberships resolve to exactly this one org
    // (storage.isUsersSoleOrganization). s9Boundary is invited into org A on
    // top of its own separate org, giving it two memberships, to exercise
    // this. ---
    // s9Boundary is declared above main()'s try block (needed by the
    // finally-block cleanup).
    {
      s9Boundary = await seedOwner(pool, `${RUN_TAG}-s9boundary`);
      createdEmails.push(s9Boundary.email);

      const inviteRes = await fetch(`${BASE_URL}/api/team/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: s8OrgAOwnerCookie },
        body: JSON.stringify({ email: s9Boundary.email }),
      });
      if (inviteRes.status === 201) ok("POST /api/team/invite (s9Boundary into org A)", "201");
      else fail("POST /api/team/invite (s9Boundary into org A)", `expected 201, got ${inviteRes.status}`);

      const membershipRow = await pool.query(
        "SELECT id FROM memberships WHERE user_id = $1 AND organization_id = $2",
        [s9Boundary.userId, s8OrgAOwner.organizationId],
      );
      const s9MembershipInOrgAId = membershipRow.rows[0]?.id;

      const attemptAllFour = async (label) => {
        const deactivate = await fetch(`${BASE_URL}/api/team/members/${s9Boundary.userId}/deactivate`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: s8OrgAOwnerCookie },
          body: JSON.stringify({ note: "boundary rule probe" }),
        });
        const reactivate = await fetch(`${BASE_URL}/api/team/members/${s9Boundary.userId}/reactivate`, {
          method: "POST",
          headers: { Cookie: s8OrgAOwnerCookie },
        });
        const changeEmail = await fetch(`${BASE_URL}/api/team/members/${s9Boundary.userId}/change-email`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: s8OrgAOwnerCookie },
          body: JSON.stringify({ newEmail: `${RUN_TAG}-s9boundary-blocked@example.invalid`, note: "boundary rule probe" }),
        });
        const resetPassword = await fetch(`${BASE_URL}/api/team/members/${s9Boundary.userId}/reset-password`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: s8OrgAOwnerCookie },
          body: JSON.stringify({ note: "boundary rule probe" }),
        });
        const statuses = {
          deactivate: deactivate.status,
          reactivate: reactivate.status,
          changeEmail: changeEmail.status,
          resetPassword: resetPassword.status,
        };
        const all403 = Object.values(statuses).every((s) => s === 403);
        if (all403) ok(`account-wide actions blocked (${label})`, "403 for deactivate/reactivate/change-email/reset-password");
        else fail(`account-wide actions blocked (${label})`, JSON.stringify(statuses));
      };

      await attemptAllFour("two orgs");

      const deactivateMembershipRes = await fetch(`${BASE_URL}/api/team/memberships/${s9MembershipInOrgAId}/deactivate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: s8OrgAOwnerCookie },
        body: JSON.stringify({ note: "Verification testing: deactivate one of two memberships" }),
      });
      if (deactivateMembershipRes.status === 200) {
        ok("POST /api/team/memberships/:id/deactivate (s9Boundary's org-A membership)", "200");
      } else {
        fail(
          "POST /api/team/memberships/:id/deactivate (s9Boundary's org-A membership)",
          `expected 200, got ${deactivateMembershipRes.status}`,
        );
      }

      // This does NOT flip to success, and that is correct: storage.
      // isUsersSoleOrganization (server/storage.ts) deliberately counts ALL
      // of a user's membership rows, active or not -- "even a deactivated
      // membership represents a relationship with that org the acting
      // org-admin has no authority over" per its own doc comment there.
      // There is no delete-membership route (only deactivate), so a user who
      // has ever touched a second org can never be brought back under a
      // single org-admin's authority this way -- only a super-admin can act
      // on them from here on. Verified live against the running server
      // before writing this assertion: task-8-brief.md's scenario 9
      // describes this transition as "assert they now succeed", but that
      // does not match the actual (and, on inspection, more conservative and
      // clearly deliberate) shipped behavior, which stays fail-closed rather
      // than reopening. This assertion locks in the real, more secure
      // invariant instead -- see task-8-report.md for the full writeup.
      await attemptAllFour("two orgs, one membership deactivated (still blocked by design)");
    }

    // --- scenario 25: a "member"-role org member (not owner/admin) is
    // rejected from every /api/team/... lifecycle route. Reuses plainCookie
    // -- plainEmail is a member (not owner) of org A since scenario 23's
    // invite -- with an explicit X-Organization-Id header, since plainEmail
    // also owns its own separate org and requireOrg otherwise defaults to
    // the first membership it finds. ---
    {
      const headers = {
        "Content-Type": "application/json",
        Cookie: plainCookie,
        "X-Organization-Id": String(s8OrgAOwner.organizationId),
      };
      const deactivateMembership = await fetch(`${BASE_URL}/api/team/memberships/${plainMembershipInOrgAId}/deactivate`, {
        method: "POST",
        headers,
        body: JSON.stringify({ note: "should be rejected" }),
      });
      const deactivateAccount = await fetch(`${BASE_URL}/api/team/members/${s8OrgAOwner.userId}/deactivate`, {
        method: "POST",
        headers,
        body: JSON.stringify({ note: "should be rejected" }),
      });
      const viewActionLog = await fetch(`${BASE_URL}/api/team/action-log`, { headers });
      const statuses = {
        deactivateMembership: deactivateMembership.status,
        deactivateAccount: deactivateAccount.status,
        viewActionLog: viewActionLog.status,
      };
      const all403 = Object.values(statuses).every((s) => s === 403);
      if (all403) {
        ok("member-role session rejected from /api/team/... lifecycle routes", "403 across membership/account/action-log routes");
      } else {
        fail("member-role session rejected from /api/team/... lifecycle routes", JSON.stringify(statuses));
      }
    }

    // --- scenario 26: GET /api/team/action-log is org-scoped; GET
    // /api/admin/action-log sees everything ---
    {
      const orgActionLogRes = await fetch(`${BASE_URL}/api/team/action-log`, { headers: { Cookie: s8OrgAOwnerCookie } });
      const orgActionLogBody = await orgActionLogRes.json().catch(() => ({}));
      const orgEntries = orgActionLogBody.entries || [];
      const hasOwnOrgEntry = orgEntries.some((e) => e.targetEmail === plainEmail && e.action === "deactivate_membership");
      // s1's membership deactivate (scenario 16) was a super-admin action
      // scoped to s1's own org -- a different tenant than org A -- so it must
      // be absent from org A's own action-log view.
      const hasCrossTenantEntry = orgEntries.some((e) => e.targetEmail === s1.email);
      if (orgActionLogRes.status === 200 && hasOwnOrgEntry && !hasCrossTenantEntry) {
        ok("GET /api/team/action-log (org-scoped)", "200, contains own-org entries, cross-tenant entry absent");
      } else {
        fail(
          "GET /api/team/action-log (org-scoped)",
          `status ${orgActionLogRes.status}, hasOwnOrgEntry ${hasOwnOrgEntry}, hasCrossTenantEntry ${hasCrossTenantEntry}`,
        );
      }

      const adminActionLogRes = await fetch(`${BASE_URL}/api/admin/action-log`, { headers: { Cookie: adminCookie } });
      const adminActionLogBody = await adminActionLogRes.json().catch(() => ({}));
      const adminEntries = adminActionLogBody.entries || [];
      const seesOrgA = adminEntries.some((e) => e.targetEmail === plainEmail && e.action === "deactivate_membership");
      const seesOtherOrg = adminEntries.some((e) => e.targetEmail === s1.email);
      if (adminActionLogRes.status === 200 && seesOrgA && seesOtherOrg) {
        ok("GET /api/admin/action-log (sees everything)", "200, contains entries from multiple different orgs");
      } else {
        fail(
          "GET /api/admin/action-log (sees everything)",
          `status ${adminActionLogRes.status}, seesOrgA ${seesOrgA}, seesOtherOrg ${seesOtherOrg}`,
        );
      }
    }

    // =========================================================================
    // Final-review fix wave (2026-09-09). Scenarios 27+ below cover the cross-
    // feature findings the per-task reviews couldn't see. Every fixture here is
    // seeded via seedOwner/seedMemberInOrg and every session reuses a cookie
    // obtained earlier in this run -- POST /api/auth/register (5/hour) and
    // POST /api/auth/login (10/15min) are both already at their per-run budget
    // by this point, so these scenarios add zero calls to either.
    // =========================================================================

    // --- scenario 27 (C1): an org owner/admin cannot take account-wide action
    // on a PLATFORM SUPER-ADMIN who happens to sit in their org. The exploit
    // this closes: a super-admin has exactly one membership like everybody
    // else, so isUsersSoleOrganization passes for them, and change-email would
    // have mailed the password-set link to an address the org-admin controls --
    // handing them a login with cross-tenant access to every org on the
    // platform. The actor here is org A's OWNER (the highest org role there
    // is), which isolates the is-super-admin check specifically: the
    // owner-vs-owner branch of the guard is skipped for an owner actor. ---
    {
      c1SuperAdminInOrgA = await seedMemberInOrg(pool, `${RUN_TAG}-c1super`, s8OrgAOwner.organizationId);
      createdEmails.push(c1SuperAdminInOrgA.email);
      await pool.query("UPDATE users SET is_super_admin = true WHERE id = $1", [c1SuperAdminInOrgA.userId]);

      // Sanity-check the fixture itself: if this account were NOT sole-org in
      // org A, the boundary rule would 403 first and this scenario would pass
      // for the wrong reason.
      const membershipCount = await pool.query("SELECT COUNT(*)::int AS c FROM memberships WHERE user_id = $1", [
        c1SuperAdminInOrgA.userId,
      ]);
      if (membershipCount.rows[0].c === 1) {
        ok("scenario 27 fixture (super-admin sole-org in org A)", "1 membership, so the boundary rule passes");
      } else {
        fail("scenario 27 fixture (super-admin sole-org in org A)", `expected 1 membership, got ${membershipCount.rows[0].c}`);
      }

      const results = await attemptAllAccountActions({
        cookie: s8OrgAOwnerCookie,
        organizationId: s8OrgAOwner.organizationId,
        targetUserId: c1SuperAdminInOrgA.userId,
        newEmail: `${RUN_TAG}-c1super-hijacked@example.invalid`,
      });
      const all403 = Object.values(results).every((r) => r.status === 403);
      const allRankMessage = Object.values(results).every((r) => /super-admin can act on a super-admin/i.test(r.message));
      if (all403 && allRankMessage) {
        ok("org-admin account-wide actions on a super-admin (C1)", "403 on all four, rejected by the super-admin rank check");
      } else {
        fail("org-admin account-wide actions on a super-admin (C1)", JSON.stringify(results));
      }

      const after = await pool.query("SELECT email, is_active, password_reset_token FROM users WHERE id = $1", [
        c1SuperAdminInOrgA.userId,
      ]);
      const untouched =
        after.rows[0]?.email === c1SuperAdminInOrgA.email &&
        after.rows[0]?.is_active === true &&
        after.rows[0]?.password_reset_token === null;
      if (untouched) {
        ok("super-admin target row untouched (C1)", "email, is_active and password_reset_token all unchanged");
      } else {
        fail("super-admin target row untouched (C1)", JSON.stringify(after.rows[0]));
      }
    }

    // --- scenario 28 (C1): an org `admin` cannot take account-wide action on
    // their own org's `owner`. Those routes' role gate treats admin and owner
    // as peers, so before this fix an admin invited via /api/team/invite could
    // deactivate, change the email of, or reset the password of the owner of
    // the org they were invited into. plainEmail's org-A membership is promoted
    // from member to admin via SQL here rather than through a route -- there is
    // no change-role endpoint, and scenario 25 above still needs it to have
    // been a plain `member` when it ran. ---
    {
      const plainIdForRank = await getUserId(pool, plainEmail);
      await pool.query("UPDATE memberships SET role = 'admin' WHERE user_id = $1 AND organization_id = $2", [
        plainIdForRank,
        s8OrgAOwner.organizationId,
      ]);
      const roleRow = await pool.query("SELECT role FROM memberships WHERE user_id = $1 AND organization_id = $2", [
        plainIdForRank,
        s8OrgAOwner.organizationId,
      ]);
      if (roleRow.rows[0]?.role === "admin") {
        ok("scenario 28 fixture (plainEmail promoted to org-A admin)", "role=admin");
      } else {
        fail("scenario 28 fixture (plainEmail promoted to org-A admin)", `role is ${roleRow.rows[0]?.role}`);
      }

      const results = await attemptAllAccountActions({
        cookie: plainCookie,
        organizationId: s8OrgAOwner.organizationId,
        targetUserId: s8OrgAOwner.userId,
        newEmail: `${RUN_TAG}-s8orga-hijacked@example.invalid`,
      });
      const all403 = Object.values(results).every((r) => r.status === 403);
      const allRankMessage = Object.values(results).every((r) => /Only an owner can act on another owner/i.test(r.message));
      if (all403 && allRankMessage) {
        ok("org-admin account-wide actions on their org's owner (C1)", "403 on all four, rejected by the owner rank check");
      } else {
        fail("org-admin account-wide actions on their org's owner (C1)", JSON.stringify(results));
      }

      const after = await pool.query("SELECT email, is_active, password_reset_token FROM users WHERE id = $1", [
        s8OrgAOwner.userId,
      ]);
      const untouched =
        after.rows[0]?.email === s8OrgAOwner.email &&
        after.rows[0]?.is_active === true &&
        after.rows[0]?.password_reset_token === null;
      if (untouched) {
        ok("owner target row untouched (C1)", "email, is_active and password_reset_token all unchanged");
      } else {
        fail("owner target row untouched (C1)", JSON.stringify(after.rows[0]));
      }

      // The same actor, against an ordinary `member` of the same org, must
      // still succeed -- proving the guard blocks by RANK and hasn't just
      // disabled these routes for admins wholesale. s9Boundary can't serve as
      // that member (two memberships), so this uses a freshly seeded one.
      const c1Member = await seedMemberInOrg(pool, `${RUN_TAG}-c1member`, s8OrgAOwner.organizationId);
      createdEmails.push(c1Member.email);
      const allowed = await fetch(`${BASE_URL}/api/team/members/${c1Member.userId}/reset-password`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: plainCookie,
          "X-Organization-Id": String(s8OrgAOwner.organizationId),
        },
        body: JSON.stringify({ note: "Verification testing: admin acting on a member is still allowed" }),
      });
      const tokenRow = await pool.query("SELECT password_reset_token FROM users WHERE id = $1", [c1Member.userId]);
      if (allowed.status === 200 && tokenRow.rows[0]?.password_reset_token) {
        ok("org-admin account-wide action on a plain member still allowed (C1)", "200, reset token issued");
      } else {
        fail(
          "org-admin account-wide action on a plain member still allowed (C1)",
          `status ${allowed.status}, token present ${!!tokenRow.rows[0]?.password_reset_token}`,
        );
      }
    }

    // --- scenario 29 (C2): a live account whose email an admin changed must be
    // off-limits to BOTH hard-delete paths. change-email legitimately sets
    // email_verified = false so the new address can be re-verified, which used
    // to make a years-old data-bearing tenant indistinguishable from a
    // disposable spam registration: two clicks from a cascade delete via
    // DELETE /api/admin/users/:id, or zero clicks via the daily sweep once the
    // affected user clicked "resend verification email" and armed the 24-hour
    // countdown themselves. Both paths now gate on users.has_been_verified,
    // which change-email leaves alone. ---
    let c2Live, c2LiveNewEmail;
    {
      c2Live = await seedOwner(pool, `${RUN_TAG}-c2live`);
      createdEmails.push(c2Live.email);
      c2LiveNewEmail = `${RUN_TAG}-c2live-new@example.invalid`;
      createdEmails.push(c2LiveNewEmail);

      const changeRes = await fetch(`${BASE_URL}/api/admin/users/${c2Live.userId}/change-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ newEmail: c2LiveNewEmail, note: "Verification testing: C2 change-email" }),
      });
      const stateRow = await pool.query(
        "SELECT email, email_verified, has_been_verified FROM users WHERE id = $1",
        [c2Live.userId],
      );
      const state = stateRow.rows[0] || {};
      if (
        changeRes.status === 200 &&
        state.email === c2LiveNewEmail &&
        state.email_verified === false &&
        state.has_been_verified === true
      ) {
        ok("change-email leaves has_been_verified intact (C2)", "email_verified=false, has_been_verified=true");
      } else {
        fail("change-email leaves has_been_verified intact (C2)", `status ${changeRes.status}, row ${JSON.stringify(state)}`);
      }

      // (a) the admin panel's delete must refuse it, and refuse it without
      // touching anything -- the user row AND the organization behind it.
      const deleteRes = await fetch(`${BASE_URL}/api/admin/users/${c2Live.userId}`, {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      });
      const deleteBody = await deleteRes.json().catch(() => ({}));
      const userStill = await pool.query("SELECT 1 FROM users WHERE id = $1", [c2Live.userId]);
      const orgStill = await pool.query("SELECT 1 FROM organizations WHERE id = $1", [c2Live.organizationId]);
      if (
        deleteRes.status === 409 &&
        deleteBody.reason === "already_verified" &&
        userStill.rowCount === 1 &&
        orgStill.rowCount === 1
      ) {
        ok("DELETE /api/admin/users/:id (change-emailed live account) (C2)", "409, user row and organization both untouched");
      } else {
        fail(
          "DELETE /api/admin/users/:id (change-emailed live account) (C2)",
          `status ${deleteRes.status}, body ${JSON.stringify(deleteBody)}, user present ${userStill.rowCount === 1}, org present ${orgStill.rowCount === 1}`,
        );
      }

      // The Admin page decides which badge and which buttons to render off
      // this pair of fields, so the list endpoint has to actually carry both.
      const listRes = await fetch(`${BASE_URL}/api/admin/users?search=${encodeURIComponent(c2LiveNewEmail)}`, {
        headers: { Cookie: adminCookie },
      });
      const listBody = await listRes.json().catch(() => ({}));
      const listed = listBody.users?.find((u) => u.email === c2LiveNewEmail);
      if (listRes.status === 200 && listed && listed.emailVerified === false && listed.hasBeenVerified === true) {
        ok("GET /api/admin/users exposes hasBeenVerified (C2)", "emailVerified=false, hasBeenVerified=true on the changed row");
      } else {
        fail("GET /api/admin/users exposes hasBeenVerified (C2)", `status ${listRes.status}, row ${JSON.stringify(listed)}`);
      }
    }

    // --- scenario 30 (C2): one real sweep, three fixtures. (b) the
    // change-emailed account from scenario 29 survives it even with an expired
    // token; (c) two genuinely never-verified registrations are still swept, so
    // the fix isn't over-restrictive -- one owning its solo org (whose org must
    // go with it) and one holding its only membership in someone else's live
    // org (whose org must NOT go with it, the scoping this finding added to
    // deleteExpiredUnverifiedRegistrations). ---
    {
      // Arm the sweep against the change-emailed account exactly the way a real
      // affected user does: they're told to verify their email, click the
      // public "resend verification email" endpoint, and that sets a fresh
      // 24-hour expiry which then lapses. Set it straight to the past here.
      await pool.query(
        "UPDATE users SET email_verification_token = $1, email_verification_token_expires_at = now() - interval '1 hour' WHERE id = $2",
        [`c2-armed-${Date.now()}`, c2Live.userId],
      );

      const c2FreshOwner = await seedOwner(pool, `${RUN_TAG}-c2freshowner`, { verified: false });
      createdEmails.push(c2FreshOwner.email);
      const c2FreshGuest = await seedMemberInOrg(pool, `${RUN_TAG}-c2freshguest`, s8OrgAOwner.organizationId, "member", {
        verified: false,
      });
      createdEmails.push(c2FreshGuest.email);
      await pool.query(
        `UPDATE users SET email_verification_token = 'c2-fresh', email_verification_token_expires_at = now() - interval '1 hour'
          WHERE id = ANY($1)`,
        [[c2FreshOwner.userId, c2FreshGuest.userId]],
      );

      const sweep = await runCleanupSweepScopedToThisRun(pool, RUN_TAG);
      if (sweep.status === 200 && typeof sweep.body.deletedCount === "number") {
        ok("GET /api/cron/cleanup-unverified-users (C2)", `200, deletedCount ${sweep.body.deletedCount}, ${sweep.protectedCount} unrelated row(s) parked and restored`);
      } else {
        fail("GET /api/cron/cleanup-unverified-users (C2)", `status ${sweep.status}, body ${JSON.stringify(sweep.body)}`);
      }

      const liveUserStill = await pool.query("SELECT 1 FROM users WHERE id = $1", [c2Live.userId]);
      const liveOrgStill = await pool.query("SELECT 1 FROM organizations WHERE id = $1", [c2Live.organizationId]);
      if (liveUserStill.rowCount === 1 && liveOrgStill.rowCount === 1) {
        ok("sweep skips a change-emailed live account (C2)", "user row and its organization both survived an expired token");
      } else {
        fail(
          "sweep skips a change-emailed live account (C2)",
          `user present ${liveUserStill.rowCount === 1}, org present ${liveOrgStill.rowCount === 1}`,
        );
      }

      const freshOwnerGone = await pool.query("SELECT 1 FROM users WHERE id = $1", [c2FreshOwner.userId]);
      const freshOwnerOrgGone = await pool.query("SELECT 1 FROM organizations WHERE id = $1", [c2FreshOwner.organizationId]);
      if (freshOwnerGone.rowCount === 0 && freshOwnerOrgGone.rowCount === 0) {
        ok("sweep still deletes a never-verified registration (C2)", "user row and its solo-owned organization both removed");
      } else {
        fail(
          "sweep still deletes a never-verified registration (C2)",
          `user present ${freshOwnerGone.rowCount === 1}, org present ${freshOwnerOrgGone.rowCount === 1}`,
        );
      }

      const freshGuestGone = await pool.query("SELECT 1 FROM users WHERE id = $1", [c2FreshGuest.userId]);
      const orgAStill = await pool.query("SELECT 1 FROM organizations WHERE id = $1", [s8OrgAOwner.organizationId]);
      if (freshGuestGone.rowCount === 0 && orgAStill.rowCount === 1) {
        ok("sweep's org deletion is owner-and-solo scoped (C2)", "swept guest removed, the live org it was invited into untouched");
      } else {
        fail(
          "sweep's org deletion is owner-and-solo scoped (C2)",
          `guest present ${freshGuestGone.rowCount === 1}, org A present ${orgAStill.rowCount === 1}`,
        );
      }

      // (c), route half: the same never-verified state must still be deletable
      // through DELETE /api/admin/users/:id, not just by the sweep.
      const c2FreshRoute = await seedOwner(pool, `${RUN_TAG}-c2freshroute`, { verified: false });
      createdEmails.push(c2FreshRoute.email);
      const routeDelete = await fetch(`${BASE_URL}/api/admin/users/${c2FreshRoute.userId}`, {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      });
      const routeUserGone = await pool.query("SELECT 1 FROM users WHERE id = $1", [c2FreshRoute.userId]);
      const routeOrgGone = await pool.query("SELECT 1 FROM organizations WHERE id = $1", [c2FreshRoute.organizationId]);
      if (routeDelete.status === 204 && routeUserGone.rowCount === 0 && routeOrgGone.rowCount === 0) {
        ok("DELETE /api/admin/users/:id (never-verified registration) (C2)", "204, user row and solo-owned org both removed");
      } else {
        fail(
          "DELETE /api/admin/users/:id (never-verified registration) (C2)",
          `status ${routeDelete.status}, user present ${routeUserGone.rowCount === 1}, org present ${routeOrgGone.rowCount === 1}`,
        );
      }
    }

    // --- scenario 31 (I1): account-level deactivation must bite on the very
    // next request of an ALREADY-ISSUED session, exactly like scenario 16 proves
    // for membership deactivation. Login was already blocked before this fix,
    // but nothing re-checked users.is_active for a live session, so a 7-day
    // cookie kept full access after the account was deactivated -- /admin
    // included, if that account happened to be a super-admin. Reuses s1's
    // cookie from scenario 16 (same account, still active at the end of it), so
    // this adds no login calls. ---
    {
      const beforeRes = await fetch(`${BASE_URL}/api/setup-status`, { headers: { Cookie: s1Cookie } });
      if (beforeRes.status === 200) ok("GET /api/setup-status (active account, existing cookie)", "200");
      else fail("GET /api/setup-status (active account, existing cookie)", `expected 200, got ${beforeRes.status}`);

      const deactivateRes = await fetch(`${BASE_URL}/api/admin/users/${s1.userId}/deactivate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ note: "Verification testing: I1 session eviction" }),
      });
      if (deactivateRes.status === 200) ok("POST /api/admin/users/:id/deactivate (I1 setup)", "200");
      else fail("POST /api/admin/users/:id/deactivate (I1 setup)", `expected 200, got ${deactivateRes.status}`);

      // Same cookie, no re-login: 401 here is passport's deserializeUser
      // refusing to hydrate a deactivated account, which makes
      // req.isAuthenticated() false and lets requireAuth reject normally. A 403
      // instead would mean the session still authenticated and only requireOrg
      // stopped it, which is NOT what this finding is about.
      const afterRes = await fetch(`${BASE_URL}/api/setup-status`, { headers: { Cookie: s1Cookie } });
      const afterBody = await afterRes.json().catch(() => ({}));
      if (afterRes.status === 401 && /Authentication required/.test(afterBody.message || "")) {
        ok("GET /api/setup-status (deactivated account, same cookie) (I1)", "401 Authentication required");
      } else {
        fail(
          "GET /api/setup-status (deactivated account, same cookie) (I1)",
          `expected 401 + Authentication required, got ${afterRes.status}, body ${JSON.stringify(afterBody)}`,
        );
      }

      // /api/auth/me is the other thing a live session leans on, and it is what
      // the client polls to decide whether it is logged in at all.
      const meRes = await fetch(`${BASE_URL}/api/auth/me`, { headers: { Cookie: s1Cookie } });
      if (meRes.status === 401) ok("GET /api/auth/me (deactivated account, same cookie) (I1)", "401");
      else fail("GET /api/auth/me (deactivated account, same cookie) (I1)", `expected 401, got ${meRes.status}`);

      const reactivateRes = await fetch(`${BASE_URL}/api/admin/users/${s1.userId}/reactivate`, {
        method: "POST",
        headers: { Cookie: adminCookie },
      });
      if (reactivateRes.status === 200) ok("POST /api/admin/users/:id/reactivate (I1 teardown)", "200");
      else fail("POST /api/admin/users/:id/reactivate (I1 teardown)", `expected 200, got ${reactivateRes.status}`);

      // The old cookie stays dead even after reactivation, and that is correct
      // rather than a bug in the fix. passport's session strategy
      // (node_modules/passport/lib/strategies/session.js) does
      // `delete req.session[key].user` whenever deserializeUser yields no user,
      // so the first request the deactivated account made stripped its own
      // session record's user id -- there is nothing left in that session to
      // re-hydrate. The fix is therefore a real logout, stronger than the
      // "access withheld until reactivated" that final-review-fix-brief.md's I1
      // test sketch expected ("reactivate, retry, assert success again"); this
      // assertion locks in the actual, more secure behaviour instead, the same
      // way scenario 24 above does for its own brief's mismatched expectation.
      // The account can of course log in again -- scenario 17 already proves
      // POST /api/auth/login goes 401-then-200 across a
      // deactivate/reactivate pair, and re-proving it here would spend the last
      // slot of that endpoint's 10-per-15-minutes budget for no new coverage.
      const restoredRes = await fetch(`${BASE_URL}/api/setup-status`, { headers: { Cookie: s1Cookie } });
      if (restoredRes.status === 401) {
        ok("GET /api/setup-status (reactivated account, OLD cookie) (I1)", "401, the evicted session is not revived by reactivation");
      } else {
        fail(
          "GET /api/setup-status (reactivated account, OLD cookie) (I1)",
          `expected 401 (session already stripped by passport), got ${restoredRes.status}`,
        );
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
    // endpoints under test). Scenario 11's and scenario 15's target users
    // are already gone -- only their now-orphaned log rows remain, caught
    // by the same LIKE query below. pendingEmail1 was promoted to
    // super-admin during the run (then demoted back), so it also needs its
    // own admin_action_log rows cleared before it can be deleted (it was
    // briefly an actor-eligible account, not just a target).
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

      // Task 8 additions: plainEmail and s9Boundary each picked up a SECOND
      // membership (in org A, alongside their own original org) via
      // scenarios 23/24's /api/team/invite calls. The per-user loop below
      // assumes exactly one membership row per user (true for every other
      // scratch account in this file, and for these two before this task) --
      // for plainEmail in particular that would otherwise risk deleting org
      // A (which s8OrgAOwner still owns) instead of plainEmail's own
      // original org, depending on which row the unordered SELECT in that
      // loop happens to return first, and leaving whichever org it didn't
      // pick permanently dangling. Stripping these org-A membership rows
      // first restores the one-membership-per-user assumption before that
      // loop runs; org A itself is still cleaned up normally afterward, via
      // s8OrgAOwner's own (by then sole) membership row.
      if (s8OrgAOwner) {
        // plainEmail itself (the try block's local const) isn't visible from
        // this finally block, same reason s8OrgAOwner/s9Boundary had to be
        // hoisted above try -- reconstruct it the same deterministic way
        // pendingId1Email is reconstructed just above (registerAndVerify
        // always builds `${tag}@example.invalid`).
        const plainEmailForCleanup = `${RUN_TAG}-plain@example.invalid`;
        const plainIdForCleanup = await getUserId(pool, plainEmailForCleanup);
        if (plainIdForCleanup) {
          await pool.query("DELETE FROM memberships WHERE user_id = $1 AND organization_id = $2", [
            plainIdForCleanup,
            s8OrgAOwner.organizationId,
          ]);
        }
        if (s9Boundary) {
          await pool.query("DELETE FROM memberships WHERE user_id = $1 AND organization_id = $2", [
            s9Boundary.userId,
            s8OrgAOwner.organizationId,
          ]);
        }

        // Scenarios 27-28's and scenario 30's seedMemberInOrg fixtures hold
        // their ONLY membership in org A and own no org of their own. Left in
        // place, the per-user loop below would read org A as "their" org and
        // delete it out from under s8OrgAOwner (which still owns it) depending
        // on loop order. Stripping these rows first leaves org A to be cleaned
        // up normally via s8OrgAOwner's own membership, exactly like the
        // plainEmail/s9Boundary rows above. The `-c%` prefix covers both the
        // C1 (c1super/c1member) and C2 (c2freshguest) fixtures -- the latter
        // should already have been swept away by scenario 30, but if that
        // assertion ever fails, its surviving membership row must not take org
        // A down with it during cleanup.
        await pool.query(
          `DELETE FROM memberships WHERE organization_id = $1
             AND user_id IN (SELECT id FROM users WHERE email LIKE $2)`,
          [s8OrgAOwner.organizationId, `${RUN_TAG}-c%`],
        );
      }

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
