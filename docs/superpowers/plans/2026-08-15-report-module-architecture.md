# Report Format Selector + Add-On Module Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the mechanism that lets a report-format/view selector show only the framework-specific views a given organization is entitled to, gated by a vendor-controlled per-organization entitlement table — with exactly one real view (`standard`) wired up this round.

**Architecture:** One new tenant-scoped table (`organization_modules`) records which module keys an organization is entitled to. A static, in-code registry (`server/modules.ts`) declares known module keys. `/api/auth/me` exposes each org's entitled keys. `OrganizationReport.tsx` reads them and renders a view selector only when there's more than one option — today there's only ever one (`standard`), so the selector stays invisible until a second real module exists, proving the mechanism without inventing content to justify it.

**Tech Stack:** Existing stack only — Drizzle ORM, `pg` for raw migration scripts, Express, React Query, shadcn/Radix `Select`. No new dependencies.

## Global Constraints

- Every tenant-scoped table query MUST filter on `organizationId` — no exceptions (standing project rule, already hit and fixed twice this project).
- `drizzle-kit push` is retired for this project. All schema changes go through a hand-written idempotent migration script in `scripts/manual-migration-NNN.mjs`, using the existing `tableExists`/`ensureTable` helper pattern (see `scripts/manual-migration-005.mjs`), wrapped in one `BEGIN`/`COMMIT` transaction with `ROLLBACK` on error.
- **Any command that mutates the live Neon DB (running a `scripts/manual-migration-*.mjs` against `DATABASE_URL`) requires the user's explicit go-ahead each time** — do not run it unprompted, even if an earlier step in this same plan was already authorized.
- This project has no automated unit-test framework (confirmed: zero `.test.`/`.spec.` files exist). Its established verification pattern, used for every prior task this session, is `npm run check` (tsc) plus live verification against the running dev server / live DB — that is the pattern these tasks follow, not a pytest/vitest-style TDD template that doesn't exist in this codebase.
- No entitlement-granting capability is ever exposed through an HTTP route reachable by an org's own owner/admin — grants happen only via a script run directly by the vendor.

---

### Task 1: Schema and migration for `organization_modules`

**Files:**
- Modify: `shared/schema.ts` (add near the `memberships` table, since it's the closest existing analog — a tenant-scoped join-like table keyed by `organizationId`)
- Create: `scripts/manual-migration-009.mjs`

**Interfaces:**
- Produces: `organizationModules` (Drizzle table), `insertOrganizationModuleSchema`, `InsertOrganizationModule` type, `OrganizationModule` type — all exported from `shared/schema.ts`, consumed by Task 2's `storage.ts` changes.

- [ ] **Step 1: Add the `organizationModules` table to `shared/schema.ts`**

Add this immediately after the `memberships` table definition (both are small, org-scoped, join-like tables — keeping them adjacent matches this file's existing organization pattern):

```ts
// Per-organization entitlement for future add-on report/output modules
// (CBAM-shaped view, GRI-table view, etc.) -- see
// docs/superpowers/specs/2026-08-15-report-module-architecture-design.md.
// Deliberately has no HTTP route for org owners/admins to write to --
// grants happen only via scripts/grant-module.mjs, run directly by the
// vendor, since no billing/self-serve system exists yet. moduleKey
// matches a key declared in server/modules.ts's MODULE_REGISTRY.
export const organizationModules = pgTable(
  "organization_modules",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    moduleKey: text("module_key").notNull(),
    enabledAt: timestamp("enabled_at").defaultNow().notNull(),
    // Free-text note of who/how this was granted (e.g. an email or invoice
    // reference) -- this is a vendor-run script action, not necessarily
    // tied to an authenticated user session, so this is not a foreign key.
    enabledBy: text("enabled_by"),
  },
  (table) => ({
    orgModuleUnique: unique("organization_modules_org_module_unique").on(table.organizationId, table.moduleKey),
    orgIdx: index("organization_modules_org_idx").on(table.organizationId),
  }),
);

export const insertOrganizationModuleSchema = createInsertSchema(organizationModules).pick({
  organizationId: true,
  moduleKey: true,
  enabledBy: true,
});

export type InsertOrganizationModule = z.infer<typeof insertOrganizationModuleSchema>;
export type OrganizationModule = typeof organizationModules.$inferSelect;
```

- [ ] **Step 2: Run `npm run check` to confirm the schema change compiles**

Run: `npm run check`
Expected: no errors (this is an additive table, nothing existing references it yet).

- [ ] **Step 3: Write `scripts/manual-migration-009.mjs`**

Follow the exact idempotent pattern from `scripts/manual-migration-005.mjs` (the last migration that created a brand-new table):

```js
// scripts/manual-migration-009.mjs
//
// Creates organization_modules -- the entitlement table for future add-on
// report/output modules (CBAM-shaped view, GRI-table view, etc.). See
// docs/superpowers/specs/2026-08-15-report-module-architecture-design.md.
// Deliberately created with zero rows: nothing is entitled to anything by
// default except the always-on "standard" view, which needs no row at all
// (server/modules.ts treats it as always enabled).
//
// Idempotent: checks information_schema before doing anything, safe to run
// repeatedly. Wrapped in one transaction (BEGIN/COMMIT, ROLLBACK on error),
// same as every prior manual migration in this project.
//
// Usage: node scripts/manual-migration-009.mjs

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

async function ensureTable(client, table, createDdl) {
  if (await tableExists(client, table)) {
    skipped.push(`table ${table} (already exists)`);
    return;
  }
  await client.query(createDdl);
  applied.push(`CREATE TABLE ${table}`);
}

async function indexExists(client, name) {
  const res = await client.query(`SELECT 1 FROM pg_indexes WHERE indexname = $1`, [name]);
  return res.rowCount > 0;
}

async function ensureIndex(client, name, ddl) {
  if (await indexExists(client, name)) {
    skipped.push(`index ${name} (already exists)`);
    return;
  }
  await client.query(ddl);
  applied.push(ddl);
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await ensureTable(
      client,
      "organization_modules",
      `CREATE TABLE IF NOT EXISTS organization_modules (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        module_key TEXT NOT NULL,
        enabled_at TIMESTAMP NOT NULL DEFAULT NOW(),
        enabled_by TEXT
      )`,
    );

    await ensureIndex(
      client,
      "organization_modules_org_module_unique",
      `CREATE UNIQUE INDEX organization_modules_org_module_unique ON organization_modules (organization_id, module_key)`,
    );

    await ensureIndex(
      client,
      "organization_modules_org_idx",
      `CREATE INDEX organization_modules_org_idx ON organization_modules (organization_id)`,
    );

    await client.query("COMMIT");

    console.log(`Applied ${applied.length} statement(s):`);
    applied.forEach((s) => console.log(`  + ${s}`));
    console.log(`Skipped ${skipped.length} (already present):`);
    skipped.forEach((s) => console.log(`  = ${s}`));
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
```

- [ ] **Step 4: Ask the user for explicit go-ahead, then run the migration against the live Neon DB**

Do not run this unprompted. Once authorized:

Run: `node scripts/manual-migration-009.mjs`
Expected output: `Applied 3 statement(s)` (the table + two indexes) on a fresh run, or `Skipped 3` if re-run.

- [ ] **Step 5: Verify the table exists via a direct query**

Run a one-off query (e.g. via a short inline script or `psql`) confirming `organization_modules` has the expected columns and both indexes. This project has no `psql` CLI wired up by default — reuse the same `pg.Pool` + `.env`'s `DATABASE_URL` pattern as the migration script itself for this check.

- [ ] **Step 6: Commit**

```bash
git add shared/schema.ts scripts/manual-migration-009.mjs
git commit -m "Add organization_modules entitlement table for future report modules"
```

---

### Task 2: Module registry, storage method, and API exposure

**Files:**
- Create: `server/modules.ts`
- Modify: `server/storage.ts` (add to `IStorage` interface around line 144's block and to `DbStorage` near `getMembership`)
- Modify: `server/routes.ts:493-503` (`/api/auth/me` handler)

**Interfaces:**
- Consumes: `organizationModules` table from Task 1 (`shared/schema.ts`).
- Produces: `MODULE_REGISTRY` (const object, `server/modules.ts`), `storage.getEnabledModuleKeys(organizationId: number): Promise<string[]>` — consumed by Task 4's client-side fetch of `/api/auth/me`.

- [ ] **Step 1: Create `server/modules.ts`**

```ts
// server/modules.ts
//
// Static, declarative registry of known add-on modules. NOT filesystem- or
// runtime-discovered -- every module ships as reviewed code within this
// same codebase (see
// docs/superpowers/specs/2026-08-15-report-module-architecture-design.md
// for why: auto-loading unreviewed code in a multi-tenant process is a
// real security risk this design deliberately avoids). What varies per
// organization is only whether it's *entitled* to a given key, tracked in
// organization_modules.
//
// To add a real second module later: add an entry here, build its report
// renderer component, then grant it to a specific organization via
// scripts/grant-module.mjs. Nothing about this registry or the entitlement
// table needs to change to do that.

export interface ModuleDefinition {
  label: string;
  alwaysEnabled: boolean;
}

export const MODULE_REGISTRY: Record<string, ModuleDefinition> = {
  standard: {
    label: "Standard (GHG Protocol / ISO 14064-1)",
    alwaysEnabled: true,
  },
};

export function isKnownModuleKey(key: string): boolean {
  return key in MODULE_REGISTRY;
}
```

- [ ] **Step 2: Add `getEnabledModuleKeys` to `IStorage` and `DbStorage` in `server/storage.ts`**

Add to the `IStorage` interface, in the same block as the other membership-related methods (near line 158):

```ts
  getEnabledModuleKeys(organizationId: number): Promise<string[]>;
```

Add the import at the top of `server/storage.ts` (extend the existing import from `../shared/schema`):

```ts
  organizationModules,
```

Add the implementation to `DbStorage`, near `getMembership` (around line 329):

```ts
  async getEnabledModuleKeys(organizationId: number): Promise<string[]> {
    const rows = await db
      .select({ moduleKey: organizationModules.moduleKey })
      .from(organizationModules)
      .where(eq(organizationModules.organizationId, organizationId));
    const grantedKeys = rows.map((r) => r.moduleKey);
    const alwaysEnabledKeys = Object.entries(MODULE_REGISTRY)
      .filter(([, def]) => def.alwaysEnabled)
      .map(([key]) => key);
    return Array.from(new Set([...alwaysEnabledKeys, ...grantedKeys]));
  }
```

Add the import for `MODULE_REGISTRY` at the top of `server/storage.ts`:

```ts
import { MODULE_REGISTRY } from "./modules";
```

- [ ] **Step 3: Run `npm run check`**

Run: `npm run check`
Expected: no errors.

- [ ] **Step 4: Add `enabledModules` to each org in `/api/auth/me`'s response**

Modify `server/routes.ts:493-503`:

```ts
  app.get("/api/auth/me", requireAuth, async (req, res) => {
    const user = req.user as { id: number; email: string; name: string | null };
    const memberships = await storage.getMembershipsForUser(user.id);
    const organizations = await Promise.all(
      memberships.map(async (m) => {
        const org = await storage.getOrganization(m.organizationId);
        const enabledModules = await storage.getEnabledModuleKeys(m.organizationId);
        return {
          organizationId: m.organizationId,
          role: m.role,
          name: org?.name ?? null,
          slug: org?.slug ?? null,
          enabledModules,
        };
      }),
    );
    return res.json({ user: { id: user.id, email: user.email, name: user.name }, memberships, organizations });
  });
```

(`enabledModules` is added per-organization, not as one flat top-level field, because a user can belong to more than one organization — each org has its own entitlements.)

- [ ] **Step 5: Live-verify against the dev server**

Start the dev server (`npm run dev`), register a fresh test account, call `GET /api/auth/me` with the session cookie, and confirm the response's `organizations[0].enabledModules` equals `["standard"]`.

- [ ] **Step 6: Commit**

```bash
git add server/modules.ts server/storage.ts server/routes.ts
git commit -m "Expose per-organization module entitlements via /api/auth/me"
```

---

### Task 3: Grant/revoke scripts

**Files:**
- Create: `scripts/grant-module.mjs`
- Create: `scripts/revoke-module.mjs`

**Interfaces:**
- Consumes: `organization_modules` table (Task 1).
- No consumers within the app itself — these are vendor-run CLI scripts, invoked directly, never through an HTTP route.

- [ ] **Step 1: Write `scripts/grant-module.mjs`**

```js
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
```

- [ ] **Step 2: Write `scripts/revoke-module.mjs`**

```js
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
```

- [ ] **Step 3: Run `npm run check`**

Run: `npm run check`
Expected: no errors (plain `.mjs` scripts, not type-checked directly, but this confirms nothing else broke).

- [ ] **Step 4: Ask the user for explicit go-ahead, then live-verify against the live Neon DB**

Using a test organization created earlier in this plan's verification (Task 2, Step 5):

1. Run `node scripts/grant-module.mjs <that org's slug> test_module "plan verification"` — expect "Granted".
2. Run it again — expect "already has... no change" (idempotency).
3. Call `GET /api/auth/me` for that org's user — confirm `enabledModules` now includes `"test_module"` alongside `"standard"`.
4. Run `node scripts/revoke-module.mjs <that org's slug> test_module` — expect "Revoked".
5. Call `GET /api/auth/me` again — confirm `enabledModules` is back to `["standard"]` only.

- [ ] **Step 5: Commit**

```bash
git add scripts/grant-module.mjs scripts/revoke-module.mjs
git commit -m "Add vendor-run scripts to grant/revoke organization module entitlements"
```

---

### Task 4: Report view selector in `OrganizationReport.tsx`

**Files:**
- Modify: `client/src/components/OrganizationReport.tsx`

**Interfaces:**
- Consumes: `GET /api/auth/me`'s `organizations[].enabledModules` (Task 2), `MODULE_REGISTRY` labels (mirrored client-side, see Step 1 below).

- [ ] **Step 1: Add a minimal client-side mirror of module labels**

`server/modules.ts` isn't importable from client code (server-only file). Add a small client-side constant near the top of `OrganizationReport.tsx` — deliberately minimal, just the label needed for display, not the full registry shape:

```ts
// Mirrors server/modules.ts's MODULE_REGISTRY labels for display purposes
// only. If a second real module is ever added there, add its label here
// too -- this project's existing convention already duplicates small
// shared shapes between client/server (see GasComponent in
// shared/schema.ts vs client/src/types/emissions.ts) rather than sharing
// server-only files with the client bundle.
const MODULE_LABELS: Record<string, string> = {
  standard: "Standard (GHG Protocol / ISO 14064-1)",
};
```

- [ ] **Step 2: Fetch the caller's enabled modules for this report's organization**

Add a query near the top of the `OrganizationReport` component function, alongside the existing `query`:

```ts
  const meQuery = useQuery<{ organizations: { organizationId: number; enabledModules: string[] }[] }>({
    queryKey: ["/api/auth/me"],
  });
```

- [ ] **Step 3: Add the selector, rendered only when there's more than one option**

Add a `reportView` state and the selector markup, right before the existing return's opening `<div className="space-y-4">` content — insert as the first child inside it, so it sits above the report body:

```ts
  const [reportView, setReportView] = useState("standard");

  // Every org has at least "standard" (always enabled, no row needed in
  // organization_modules). With only one entitled key, there's nothing to
  // choose between yet, so the selector stays hidden rather than showing a
  // single-option dropdown to every customer until a real second module
  // exists.
  const enabledModules = meQuery.data?.organizations[0]?.enabledModules ?? ["standard"];
```

Then, inside the existing top-level `<div className="space-y-4">`, add as the first child:

```tsx
      {enabledModules.length > 1 && (
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-neutral-600">Report view</label>
          <select
            className="border rounded-md px-2 py-1 text-sm"
            value={reportView}
            onChange={(e) => setReportView(e.target.value)}
          >
            {enabledModules.map((key) => (
              <option key={key} value={key}>
                {MODULE_LABELS[key] ?? key}
              </option>
            ))}
          </select>
        </div>
      )}
```

(Plain `<select>`, not the shadcn `Select` component, matches this file's existing lightweight styling and avoids pulling in the Radix `Select` dependency for a control that's invisible in every deployment until a second module ships — if/when a second real module is added, this is a reasonable point to upgrade to the shadcn `Select` used elsewhere in the app.)

- [ ] **Step 4: Run `npm run check` and `npm run build`**

Run: `npm run check && npx vite build`
Expected: no errors.

- [ ] **Step 5: Live-verify in the browser**

Start the dev server, log in as the test organization used in Task 2/3's verification, open the Organization Report for an existing reporting boundary. Confirm:
- With only `"standard"` enabled (the default state), no "Report view" selector is visible — the report renders exactly as it did before this task.
- Re-run `node scripts/grant-module.mjs <org slug> test_module` (Task 3), reload the report page, confirm the "Report view" selector now appears with two options ("Standard (GHG Protocol / ISO 14064-1)" and "test_module", the latter falling back to its raw key since it has no `MODULE_LABELS` entry — expected, since no real second module exists yet).
- Run `node scripts/revoke-module.mjs <org slug> test_module`, reload, confirm the selector disappears again.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/OrganizationReport.tsx
git commit -m "Add report-view selector to OrganizationReport, hidden until a second module is entitled"
```

---

## Self-review notes

- **Spec coverage:** data model (Task 1) ✓, module registry (Task 2) ✓, API exposure (Task 2) ✓, entitlement granting (Task 3) ✓, selector UI (Task 4) ✓, "generalizes beyond reports" (no task needed — the spec states the *same table* gates future non-report routes too, which requires no additional code now, just documents that a future route would reuse `storage.getEnabledModuleKeys`).
- **Placeholder scan:** no TBD/TODO; every step has real, complete code.
- **Type consistency:** `getEnabledModuleKeys(organizationId: number): Promise<string[]>` used identically in Task 2 (definition) and Task 4 (consumption via the API response shape, not a direct import — client and server don't share this function, only its JSON output shape, consistent with this project's existing client/server duplication convention).
