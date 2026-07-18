// scripts/verify-branch.mjs
//
// Full local setup + smoke test + revert for the saas-multitenant branch.
//
// What it does, in order:
//   1. Checks .env exists with DATABASE_URL and SESSION_SECRET set (does NOT
//      create or guess these -- you fill .env yourself first, see .env.example).
//   2. npm install
//   3. npm run db:push (creates/updates tables from shared/schema.ts)
//   4. Starts the dev server in the background, waits for it to answer
//   5. Runs a real end-to-end flow against the live endpoints:
//        register -> me -> create reporting entity -> create facility
//        -> create reporting boundary -> setup-status -> create emission
//        factor -> list factors -> calculate (persist:true, now gated on
//        setup completeness) -> list emission records -> logout
//   6. Reverts: deletes ONLY the rows this run created (matched by a unique
//      test-run tag), then stops the server. It does NOT drop your schema
//      or touch any other data in the database.
//
// Usage:
//   npm run verify
//
// Exit code is 0 if every step passed, non-zero otherwise. Output for each
// step is printed as it happens so a failure is easy to locate.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { Pool } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = process.env.PORT || "5000";
const BASE_URL = `http://localhost:${PORT}`;
const RUN_TAG = `smoketest-${Date.now()}`;
const TEST_EMAIL = `${RUN_TAG}@example.invalid`;
const TEST_PASSWORD = "SmokeTest12345!";
const TEST_ORG_NAME = RUN_TAG;

let passed = 0;
let failed = 0;
let serverProcess = null;

function log(step, msg) {
  console.log(`[verify] ${step}: ${msg}`);
}

function ok(step, msg) {
  passed++;
  console.log(`  \u2713 ${step}${msg ? " - " + msg : ""}`);
}

function fail(step, msg) {
  failed++;
  console.error(`  \u2717 ${step}${msg ? " - " + msg : ""}`);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      stdio: "inherit",
      shell: process.platform === "win32",
      ...opts,
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

async function killServer() {
  if (!serverProcess || serverProcess.killed) return;
  const pid = serverProcess.pid;
  if (process.platform === "win32") {
    // spawn(shell: true) on Windows creates a child cmd.exe that itself
    // spawns node; a plain kill() only kills cmd.exe and leaves the real
    // process running. taskkill /T kills the whole tree.
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { shell: true });
      killer.on("exit", resolve);
      killer.on("error", resolve);
    });
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      serverProcess.kill("SIGTERM");
    }
  }
}

async function waitForServer(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (serverProcess && serverProcess.exitCode !== null) {
      return false; // process already crashed, no point continuing to poll
    }
    try {
      const res = await fetch(`${BASE_URL}/api/auth/me`);
      // Any HTTP response at all (even 401) means the server is up.
      if (res.status) return true;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  return false;
}

async function step1_checkEnv() {
  log("1/6", "checking .env");
  const envPath = path.join(ROOT, ".env");
  if (!existsSync(envPath)) {
    throw new Error(
      ".env not found. Run: cp .env.example .env, then fill in DATABASE_URL (from the Neon Auth file) " +
        "and SESSION_SECRET (node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"), then re-run.",
    );
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set in .env.");
  }
  if (!process.env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET is not set in .env.");
  }
  ok("env check", "DATABASE_URL and SESSION_SECRET present");
}

async function step2_install() {
  log("2/6", "npm install");
  await run("npm", ["install"]);
  ok("npm install");
}

async function step3_dbPush() {
  log("3/6", "npm run db:push (creates/updates schema on your real Neon database)");
  await run("npm", ["run", "db:push", "--", "--force"]);

  // drizzle-kit push can print a fatal Postgres error and still exit 0
  // (observed: "column \"id\" is in a primary key", code 42P16, mid-push --
  // process exit code was 0 regardless). Don't trust the exit code alone,
  // check that the columns/tables this push was supposed to create are
  // actually there before letting the smoke test proceed and produce a
  // pile of confusing, unrelated-looking 500s instead of one clear error.
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const res = await pool.query(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE (table_name = 'emission_factors' AND column_name = 'year')
         OR (table_name = 'emission_records' AND column_name = 'scope3_category')
    `);
    const found = new Set(res.rows.map((r) => `${r.table_name}.${r.column_name}`));
    const required = ["emission_factors.year", "emission_records.scope3_category"];
    const missing = required.filter((r) => !found.has(r));
    if (missing.length > 0) {
      throw new Error(
        `db:push reported success but these columns are missing: ${missing.join(", ")}. ` +
          `drizzle-kit likely hit an error mid-push and exited 0 anyway -- scroll up in the ` +
          `db:push output above for the real Postgres error (look for anything starting ` +
          `with "error:"), fix it, then re-run.`,
      );
    }
  } finally {
    await pool.end();
  }

  ok("db:push", "schema verified against live database, not just trusting the exit code");
}

async function step4_startServer() {
  log("4/6", `starting dev server on ${BASE_URL}`);
  serverProcess = spawn("npm", ["run", "dev"], {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
    detached: process.platform !== "win32",
  });
  const up = await waitForServer();
  if (!up) throw new Error("Server did not respond within 20s. Check the output above for a boot error.");
  ok("server boot", `responding at ${BASE_URL}`);
}

async function step5_smokeTest() {
  log("5/6", "running end-to-end smoke test");
  let cookie = "";

  // --- register ---
  {
    const res = await fetch(`${BASE_URL}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        name: "Smoke Test",
        organizationName: TEST_ORG_NAME,
      }),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    if (res.status === 201 && cookie) ok("POST /api/auth/register", `201, session cookie received`);
    else fail("POST /api/auth/register", `expected 201 + cookie, got ${res.status}`);
  }

  // --- me ---
  {
    const res = await fetch(`${BASE_URL}/api/auth/me`, { headers: { Cookie: cookie } });
    const body = await res.json().catch(() => ({}));
    const hasMembership = Array.isArray(body.memberships) && body.memberships.length === 1;
    if (res.status === 200 && body.user?.email === TEST_EMAIL && hasMembership) {
      ok("GET /api/auth/me", "user + exactly one membership returned");
    } else {
      fail("GET /api/auth/me", `status ${res.status}, body ${JSON.stringify(body)}`);
    }
  }

  // --- ISO setup: reporting entity, facility, reporting boundary ---
  let entityId = null;
  {
    const res = await fetch(`${BASE_URL}/api/reporting-entities`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: `${RUN_TAG}-entity`, legalEntity: `${RUN_TAG}-legal` }),
    });
    const body = await res.json().catch(() => ({}));
    entityId = body.reportingEntity?.id;
    if (res.status === 201 && entityId) ok("POST /api/reporting-entities", `entity id ${entityId}`);
    else fail("POST /api/reporting-entities", `status ${res.status}, body ${JSON.stringify(body)}`);
  }

  {
    const res = await fetch(`${BASE_URL}/api/facilities`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ reportingEntityId: entityId, name: `${RUN_TAG}-facility`, country: "GB" }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 201 && body.facility?.id) ok("POST /api/facilities", `facility id ${body.facility.id}`);
    else fail("POST /api/facilities", `status ${res.status}, body ${JSON.stringify(body)}`);
  }

  {
    const res = await fetch(`${BASE_URL}/api/reporting-boundaries`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        reportingEntityId: entityId,
        reportingYear: 2026,
        consolidationApproach: "operational_control",
        description: `${RUN_TAG}-boundary`,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 201 && body.boundary?.id) ok("POST /api/reporting-boundaries", `boundary id ${body.boundary.id}`);
    else fail("POST /api/reporting-boundaries", `status ${res.status}, body ${JSON.stringify(body)}`);
  }

  {
    const res = await fetch(`${BASE_URL}/api/setup-status`, { headers: { Cookie: cookie } });
    const body = await res.json().catch(() => ({}));
    if (res.status === 200 && body.setupStatus?.readyForCalculation === true) {
      ok("GET /api/setup-status", "readyForCalculation: true after entity+facility+boundary created");
    } else {
      fail("GET /api/setup-status", `status ${res.status}, body ${JSON.stringify(body)}`);
    }
  }

  // --- create emission factor ---
  let factorId = null;
  {
    const res = await fetch(`${BASE_URL}/api/emission-factors`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        factors: [
          { name: `${RUN_TAG}-diesel`, factor: 2.68, unit: "litre", scope: "scope1", category: "fuel" },
        ],
      }),
    });
    const body = await res.json().catch(() => ({}));
    factorId = body.factors?.[0]?.id;
    if (res.status === 201 && factorId) ok("POST /api/emission-factors", `factor id ${factorId}`);
    else fail("POST /api/emission-factors", `status ${res.status}, body ${JSON.stringify(body)}`);
  }

  // --- list emission factors, confirm tenant scoping returns it ---
  {
    const res = await fetch(`${BASE_URL}/api/emission-factors`, { headers: { Cookie: cookie } });
    const body = await res.json().catch(() => ({}));
    const found = (body.factors || []).some((f) => f.id === factorId);
    if (res.status === 200 && found) ok("GET /api/emission-factors", "created factor visible to its own org");
    else fail("GET /api/emission-factors", `status ${res.status}, factor not found in list`);
  }

  // --- calculate with persist ---
  {
    const res = await fetch(`${BASE_URL}/api/calculate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        persist: true,
        inputs: {
          scope1: [{ activity: `${RUN_TAG}-diesel`, unit: "litre", qty: 10, year: 2026 }],
          scope2: [],
          scope3: [],
        },
        emissionFactors: {
          [`${RUN_TAG}-diesel`]: { factor: 2.68, unit: "litre" },
        },
      }),
    });
    const body = await res.json().catch(() => ({}));
    const total = body.results?.scope1;
    if (res.status === 200 && total === 26.8) ok("POST /api/calculate", "scope1 = 26.8 as expected, persist requested");
    else fail("POST /api/calculate", `status ${res.status}, body ${JSON.stringify(body)}`);
  }

  // --- confirm the calculation was actually persisted ---
  {
    const res = await fetch(`${BASE_URL}/api/emission-records`, { headers: { Cookie: cookie } });
    const body = await res.json().catch(() => ({}));
    const found = (body.records || []).some((r) => r.activity === `${RUN_TAG}-diesel`);
    if (res.status === 200 && found) ok("GET /api/emission-records", "persisted record found, org-scoped read works");
    else fail("GET /api/emission-records", `status ${res.status}, record not found`);
  }

  // --- logout ---
  {
    const res = await fetch(`${BASE_URL}/api/auth/logout`, { method: "POST", headers: { Cookie: cookie } });
    if (res.status === 204) ok("POST /api/auth/logout", "204");
    else fail("POST /api/auth/logout", `expected 204, got ${res.status}`);
  }
}

async function step6_revert() {
  log("6/6", "reverting: deleting only the data this run created, then stopping the server");

  await killServer();
  ok("server stopped");

  if (!process.env.DATABASE_URL) {
    log("6/6", "no DATABASE_URL available, nothing was ever written, skipping cleanup query");
    return;
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    // Delete in FK-safe order. Scoped strictly to this run's tag, nothing
    // else in the database is touched.
    const org = await pool.query("SELECT id FROM organizations WHERE slug LIKE $1", [`${RUN_TAG}%`]);
    const orgIds = org.rows.map((r) => r.id);

    if (orgIds.length > 0) {
      await pool.query("DELETE FROM emission_records WHERE organization_id = ANY($1)", [orgIds]);
      await pool.query("DELETE FROM emission_factors WHERE organization_id = ANY($1)", [orgIds]);
      await pool.query("DELETE FROM memberships WHERE organization_id = ANY($1)", [orgIds]);
      await pool.query("DELETE FROM organizations WHERE id = ANY($1)", [orgIds]);
    }
    await pool.query("DELETE FROM users WHERE email = $1", [TEST_EMAIL]);

    ok("data cleanup", `removed test org/user/factor/record rows tagged ${RUN_TAG}`);
  } catch (err) {
    fail("data cleanup", err instanceof Error ? err.message : String(err));
  } finally {
    await pool.end();
  }
}

async function main() {
  try {
    await step1_checkEnv();
    await step2_install();
    await step3_dbPush();
    await step4_startServer();
    await step5_smokeTest();
  } catch (err) {
    fail("fatal", err instanceof Error ? err.message : String(err));
  } finally {
    await step6_revert();
  }

  console.log("");
  console.log(`[verify] ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
