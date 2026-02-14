import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { rm } from "node:fs/promises";

const TEST_HOST = process.env.TEST_HOST || "localhost";
const TEST_PORT = process.env.TEST_PORT || "5000";
const BASE_URL = `http://${TEST_HOST}:${TEST_PORT}`;
const STORE_PATH = "data/setup-store.json";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitForServer(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE_URL}/api/setup-status`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await delay(300);
  }
  throw new Error("Server did not become ready in time");
}

function startServer() {
  const server = spawn(process.execPath, ["./node_modules/tsx/dist/cli.mjs", "server/index.ts"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "development",
      FORCE_COLOR: "0",
      HOST: process.env.HOST || TEST_HOST,
      PORT: process.env.PORT || TEST_PORT,
    },
  });

  server.stdout.on("data", (chunk) => process.stdout.write(`[dev] ${chunk}`));
  server.stderr.on("data", (chunk) => process.stderr.write(`[dev] ${chunk}`));
  return server;
}

async function stopServer(server) {
  server.kill("SIGKILL");
  await delay(250);
}

async function jsonRequest(path, { method = "GET", body } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  return { status: res.status, data };
}

async function run() {
  await rm(STORE_PATH, { force: true });

  let server = startServer();
  try {
    await waitForServer();

    const setup0 = await jsonRequest("/api/setup-status");
    assert(setup0.status === 200, "setup-status should return 200");
    assert(setup0.data?.setupStatus?.readyForCalculation === false, "setup should be incomplete initially");

    const org = await jsonRequest("/api/organizations", {
      method: "POST",
      body: { name: "Acme Integration Test Org" },
    });
    assert(org.status === 201, "organization creation should return 201");
    const organizationId = org.data?.organization?.id;
    assert(Number.isInteger(organizationId), "organization id missing");

    const facility = await jsonRequest("/api/facilities", {
      method: "POST",
      body: { organizationId, name: "Plant Alpha" },
    });
    assert(facility.status === 201, "facility creation should return 201");
    const facilityId = facility.data?.facility?.id;
    assert(Number.isInteger(facilityId), "facility id missing");

    const facilityDuplicate = await jsonRequest("/api/facilities", {
      method: "POST",
      body: { organizationId, name: "Plant Alpha" },
    });
    assert(facilityDuplicate.status === 409, "duplicate facility should return 409");

    const boundary = await jsonRequest("/api/reporting-boundaries", {
      method: "POST",
      body: {
        organizationId,
        reportingYear: 2025,
        consolidationApproach: "operational_control",
      },
    });
    assert(boundary.status === 201, "boundary creation should return 201");
    const boundaryId = boundary.data?.boundary?.id;
    assert(Number.isInteger(boundaryId), "boundary id missing");

    const boundaryDuplicate = await jsonRequest("/api/reporting-boundaries", {
      method: "POST",
      body: {
        organizationId,
        reportingYear: 2025,
        consolidationApproach: "operational_control",
      },
    });
    assert(boundaryDuplicate.status === 409, "duplicate boundary should return 409");

    const summary = await jsonRequest("/api/setup-summary");
    assert(summary.status === 200, "setup-summary should return 200");
    assert(Array.isArray(summary.data?.organizations), "setup-summary organizations should be an array");

    const filteredSummary = await jsonRequest(`/api/setup-summary?organizationId=${organizationId}`);
    assert(filteredSummary.status === 200, "filtered setup-summary should return 200");
    assert(filteredSummary.data?.organizations?.length === 1, "filtered setup-summary should return one organization");

    const pagedSummary = await jsonRequest("/api/setup-summary?page=1&pageSize=1");
    assert(pagedSummary.status === 200, "paged setup-summary should return 200");
    assert(pagedSummary.data?.pagination?.pageSize === 1, "paged setup-summary should respect pageSize");

    const invalidPagedSummary = await jsonRequest("/api/setup-summary?page=0&pageSize=500");
    assert(invalidPagedSummary.status === 400, "invalid pagination should return 400");


    const orgUpdate = await jsonRequest(`/api/organizations/${organizationId}`, {
      method: "PUT",
      body: { name: "Acme Integration Test Org Updated" },
    });
    assert(orgUpdate.status === 200, "organization update should return 200");

    const facilityUpdate = await jsonRequest(`/api/facilities/${facilityId}`, {
      method: "PUT",
      body: { name: "Plant Alpha Updated" },
    });
    assert(facilityUpdate.status === 200, "facility update should return 200");

    const boundaryUpdate = await jsonRequest(`/api/reporting-boundaries/${boundaryId}`, {
      method: "PUT",
      body: { reportingYear: 2026, consolidationApproach: "financial_control" },
    });
    assert(boundaryUpdate.status === 200, "boundary update should return 200");

    const setup1 = await jsonRequest("/api/setup-status");
    assert(setup1.status === 200, "setup-status should return 200 after setup");
    assert(setup1.data?.setupStatus?.readyForCalculation === true, "setup should be ready after required entities");

    await stopServer(server);
    server = startServer();
    await waitForServer();

    const setupAfterRestart = await jsonRequest("/api/setup-status");
    assert(setupAfterRestart.status === 200, "setup-status should return 200 after restart");
    assert(setupAfterRestart.data?.setupStatus?.readyForCalculation === true, "setup should persist after restart");

    const deleteBoundary = await jsonRequest(`/api/reporting-boundaries/${boundaryId}`, { method: "DELETE" });
    assert(deleteBoundary.status === 204, "boundary delete should return 204");

    const setup2 = await jsonRequest("/api/setup-status");
    assert(setup2.status === 200, "setup-status should return 200 after boundary delete");
    assert(setup2.data?.setupStatus?.readyForCalculation === false, "setup should be incomplete after deleting boundary");

    const deleteFacility = await jsonRequest(`/api/facilities/${facilityId}`, { method: "DELETE" });
    assert(deleteFacility.status === 204, "facility delete should return 204");

    const deleteOrganization = await jsonRequest(`/api/organizations/${organizationId}`, { method: "DELETE" });
    assert(deleteOrganization.status === 204, "organization delete should return 204");

    console.log("✅ setup API integration checks passed");
  } finally {
    await stopServer(server);
    await rm(STORE_PATH, { force: true });
  }
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error("❌ setup API integration checks failed");
    console.error(error);
    process.exit(1);
  });
