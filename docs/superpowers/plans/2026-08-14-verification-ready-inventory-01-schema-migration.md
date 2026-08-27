# Verification-Ready Inventory — Plan 1: Schema Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is Plan 1 of 4 for the design at `docs/superpowers/specs/2026-08-14-verification-ready-multi-facility-inventory-design.md` — Plans 2-4 depend on this one completing first.

**Goal:** Add every new column Section 1 of the design spec requires, across 5 tables, via one idempotent migration script — no application code changes in this plan.

**Architecture:** Pure additive schema change. Every new column is nullable or has a safe default, following this project's established migration pattern (`scripts/manual-migration-001.mjs` through `006.mjs`).

**Tech Stack:** Drizzle ORM (`shared/schema.ts`), raw `pg` migration script (`scripts/manual-migration-007.mjs`), Neon Postgres.

## Global Constraints

- Every tenant-scoped table query MUST filter on `organizationId` — not relevant to this plan (no queries, only schema), but do not violate it in any verification query written here.
- `drizzle-kit push` is retired for this project. This plan writes a hand-written idempotent migration script instead.
- No PR, no push to GitHub. Local only.
- **Running the migration against the live Neon DB requires the user's explicit go-ahead** — this project's standing rule (see `CLAUDE.md`) is to ask before any DB-mutating action. Task 3 below has an explicit STOP for this.

---

### Task 1: Add new columns to `shared/schema.ts`

**Files:**
- Modify: `shared/schema.ts`

**Interfaces:**
- Consumes: existing `facilities`, `emissionFactorsTable`, `ipccDefaultFactors`, `emissionRecordsTable`, `reportingEntities`, `reportingBoundaries` table definitions (already in the file).
- Produces: the exact column names and types every later plan's code references. Get these exactly right — Plans 2-4 use them by these names.

- [ ] **Step 1: Add `equityShareOwnershipPercent` to `facilities`**

Find the `facilities` table definition (search for `export const facilities = pgTable(`). Add one field:

```ts
    // Design: docs/superpowers/specs/2026-08-14-verification-ready-multi-facility-inventory-design.md
    // Required only when the parent reportingBoundary's consolidationApproach
    // is 'equity_share' -- validated at the API layer (server/routes.ts),
    // not here, matching this project's existing convention. Control
    // approaches (operational_control/financial_control) are binary
    // include/exclude -- no percentage needed.
    equityShareOwnershipPercent: numeric("equity_share_ownership_percent", { precision: 5, scale: 2 }),
```

Add it right after the existing `country: text("country"),` line, before `createdAt`.

- [ ] **Step 2: Add `country` and `isBiogenic` to `emissionFactorsTable`**

Find `export const emissionFactorsTable = pgTable(`. Add two fields after the existing `source: text("source"),` line:

```ts
    // Design: docs/superpowers/specs/2026-08-14-verification-ready-multi-facility-inventory-design.md
    // ISO country code (e.g. "GB", "US") this factor applies to. Nullable --
    // most org factors won't have one set until Plan 4 adds the
    // country-tiered picker. Used to prefer a facility's own country's
    // factors over generic IPCC defaults.
    country: text("country"),
    // Flags biomass/waste-derived CO2 factors so they can be excluded from
    // gross Scope 1/2/3 totals and reported as a separate memo item (GRI
    // 305 / GHG Protocol / IPCC convention). No biogenic factors are seeded
    // as of this migration -- the field exists ahead of that data landing.
    isBiogenic: boolean("is_biogenic").notNull().default(false),
```

- [ ] **Step 3: Add `isBiogenic`, `factorLower`, `factorUpper` to `ipccDefaultFactors`**

Find `export const ipccDefaultFactors = pgTable(`. Add three fields after the existing `factor: numeric("factor", { precision: 20, scale: 8 }).notNull(),` line:

```ts
    // Design: docs/superpowers/specs/2026-08-14-verification-ready-multi-facility-inventory-design.md
    isBiogenic: boolean("is_biogenic").notNull().default(false),
    // Real published 95% confidence interval bounds from the IPCC source
    // table (same units as `factor`). Nullable -- not every future
    // category's source table publishes a CI. Feeds uncertaintyPercent
    // pre-fill in dataQualityRecords (Plan 2): +/-(factorUpper-factorLower)/2/factor*100.
    factorLower: numeric("factor_lower", { precision: 20, scale: 8 }),
    factorUpper: numeric("factor_upper", { precision: 20, scale: 8 }),
```

- [ ] **Step 4: Add `facilityId`, `sourceStreamId`, `calculationApproachId`, `reportingBoundaryId` to `emissionRecordsTable`**

Find `export const emissionRecordsTable = pgTable(`. Add four fields right after the existing `gasBreakdown: jsonb("gas_breakdown"),` line (added earlier this session), before `createdAt`:

```ts
    // Design: docs/superpowers/specs/2026-08-14-verification-ready-multi-facility-inventory-design.md
    // All four nullable: existing rows (and the retired legacy calculator's
    // records) never had this context. Going forward, every facility-MRV
    // calculation (Plan 2) sets all four, making emissionRecordsTable the
    // single persisted-calculation-results table for both surfaces.
    // reportingBoundaryId is denormalized from the source stream so the
    // Plan 3 rollup query filters directly without a join chain.
    facilityId: integer("facility_id").references(() => facilities.id, { onDelete: "cascade" }),
    sourceStreamId: integer("source_stream_id").references(() => sourceStreams.id, { onDelete: "cascade" }),
    calculationApproachId: integer("calculation_approach_id").references(() => calculationApproaches.id, { onDelete: "set null" }),
    reportingBoundaryId: integer("reporting_boundary_id").references(() => reportingBoundaries.id, { onDelete: "cascade" }),
```

**Note:** `emissionRecordsTable` is defined earlier in the file than `sourceStreams`, `calculationApproaches`, and `facilities` (check with `grep -n "^export const" shared/schema.ts` if unsure of order). TypeScript/Drizzle table definitions can reference tables defined later in the same file as long as they're all in the same module scope (function-body references, not top-level evaluation order) — this is already proven safe in this file (e.g. `emissionRecordsTable` referencing `users.id` which is defined earlier, and other tables referencing tables defined later via `.references(() => otherTable.id)`, the arrow function defers evaluation). No reordering needed.

- [ ] **Step 4b: Add `gasBreakdown` to `calculationApproaches`**

Find `export const calculationApproaches = pgTable(`. Add one field after the existing `isIpccDefault` column (added earlier this session):

```ts
    // Design: docs/superpowers/specs/2026-08-14-verification-ready-multi-facility-inventory-design.md
    // Mirrors emissionRecordsTable.gasBreakdown. Stored here too (not just
    // on the derived emissionRecordsTable row) so DataQualitySection
    // (Plan 2 Task 2) can read the selected factor's per-gas components
    // directly via its own existing query
    // (/api/source-streams/:id/calculation-approach) without needing to
    // join through emission_records or re-derive the bundle from free-text
    // fields.
    gasBreakdown: jsonb("gas_breakdown"),
```

Also add `gasBreakdown: true,` to `insertCalculationApproachSchema`'s `.pick()` block (Step 7 below covers the general pattern; do this one now while you're in this table's definition).

- [ ] **Step 5: Add `baseYear`, `baseYearRationale` to `reportingEntities`**

Find `export const reportingEntities = pgTable(`. Add two fields after the existing `legalEntity: text("legal_entity"),` line:

```ts
    // Design: docs/superpowers/specs/2026-08-14-verification-ready-multi-facility-inventory-design.md
    // Set once per entity. Base-year *emissions* are never duplicated into
    // a new field -- derive them by looking up the reportingBoundary row
    // matching this entity + baseYear (Plan 3's rollup endpoint does this).
    baseYear: integer("base_year"),
    baseYearRationale: text("base_year_rationale"),
```

- [ ] **Step 6: Add `revenueAmount`, `revenueCurrency`, `fullTimeEquivalentEmployees`, `status`, `finalizedAt` to `reportingBoundaries`**

Find `export const reportingBoundaries = pgTable(`. Add five fields after the existing `description: text("description"),` line:

```ts
    // Design: docs/superpowers/specs/2026-08-14-verification-ready-multi-facility-inventory-design.md
    // Entity-wide annual figures for GRI 102 intensity ratios, alongside
    // the existing per-facility facilityProducts.actualProduction.
    revenueAmount: numeric("revenue_amount", { precision: 20, scale: 2 }),
    revenueCurrency: text("revenue_currency"),
    fullTimeEquivalentEmployees: numeric("full_time_equivalent_employees", { precision: 10, scale: 1 }),
    // The "GHG statement" snapshot lock (ISO 14064-3: verification applies
    // to a fixed, dated statement, not a live-recalculating number).
    // 'draft' | 'finalized'. Enforced as a string union at the API layer,
    // not a DB enum, matching this project's existing convention
    // (consolidationApproach is the one exception, already a DB-level text
    // column validated against the consolidationApproaches array in code).
    status: text("status").notNull().default("draft"),
    finalizedAt: timestamp("finalized_at"),
```

- [ ] **Step 7: Update every affected `insertXSchema.pick()` call**

Each table modified above has a corresponding `createInsertSchema(...).pick({...})` block. Add the new field names to each `.pick()` object so the new columns are actually settable through the app's insert paths:

- `insertFacilitySchema` (or equivalent — search for `createInsertSchema(facilities)`): add `equityShareOwnershipPercent: true,`
- `insertEmissionFactorSchema`: add `country: true, isBiogenic: true,`
- There is currently no `createInsertSchema` for `ipccDefaultFactors` (it's seeded only via migration scripts, never through a user-facing insert route) — skip.
- `insertEmissionRecordSchema`: add `facilityId: true, sourceStreamId: true, calculationApproachId: true, reportingBoundaryId: true,`
- `insertReportingEntitySchema`: add `baseYear: true, baseYearRationale: true,`
- `insertReportingBoundarySchema`: add `revenueAmount: true, revenueCurrency: true, fullTimeEquivalentEmployees: true, status: true, finalizedAt: true,`

- [ ] **Step 8: Run the TypeScript compiler to catch mistakes early**

Run: `cd "C:\Users\LENOVO\Documents\ClaudeCowork\OUTPUTS\ghgcalculator" && npm run check`
Expected: zero errors. If there are errors, they're almost always a typo in a field name or a missing `.pick()` entry — fix and re-run before continuing.

- [ ] **Step 9: Commit**

```bash
git add shared/schema.ts
git commit -m "$(cat <<'EOF'
Add schema columns for verification-ready multi-facility inventory

Section 1 of docs/superpowers/specs/2026-08-14-verification-ready-multi-facility-inventory-design.md:
equity-share ownership, factor country/biogenic tags and IPCC confidence
intervals, emission-record facility/source-stream/boundary linkage, base
year, and the draft/finalized report-snapshot fields. Schema only -- no
migration run yet, no application code wired up.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Write `scripts/manual-migration-007.mjs`

**Files:**
- Create: `scripts/manual-migration-007.mjs`

**Interfaces:**
- Consumes: nothing from Task 1's TypeScript changes directly (this is a raw-SQL script, run with plain `node`, not through Drizzle) — but every column name/type here MUST exactly match Task 1's Drizzle definitions, since they describe the same live database columns.
- Produces: the actual database columns that Plan 2, 3, and 4's code reads/writes at runtime.

- [ ] **Step 1: Write the migration script**

Create `scripts/manual-migration-007.mjs` with this exact content:

```js
// scripts/manual-migration-007.mjs
//
// Additive pass, following the conventions of manual-migration-002 through
// 006.mjs. Adds every column Section 1 of
// docs/superpowers/specs/2026-08-14-verification-ready-multi-facility-inventory-design.md
// requires, across 5 tables. All nullable or safely defaulted -- no
// existing row becomes invalid. See shared/schema.ts for the Drizzle-side
// source of truth this migration brings the live database in line with.
//
// Idempotent: every helper checks information_schema before doing
// anything, safe to run repeatedly and safe if a previous run got partway
// through before failing. Wrapped in one transaction (BEGIN/COMMIT,
// ROLLBACK on error).
//
// Usage: node scripts/manual-migration-007.mjs

import "dotenv/config";
import { Pool } from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL not set. Run this from the project folder with .env filled in.");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const applied = [];
const skipped = [];

async function columnExists(client, table, column) {
  const res = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return res.rowCount > 0;
}

async function ensureColumn(client, table, column, addColumnDdl) {
  if (await columnExists(client, table, column)) {
    skipped.push(`column ${table}.${column} (already exists)`);
    return;
  }
  await client.query(`ALTER TABLE ${table} ADD COLUMN ${addColumnDdl}`);
  applied.push(`ALTER TABLE ${table} ADD COLUMN ${addColumnDdl}`);
}

async function indexExists(client, name) {
  const res = await client.query(`SELECT 1 FROM pg_class WHERE relname = $1`, [name]);
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

    // -----------------------------------------------------------------
    // facilities -- equity-share ownership
    // -----------------------------------------------------------------
    await ensureColumn(
      client,
      "facilities",
      "equity_share_ownership_percent",
      "equity_share_ownership_percent NUMERIC(5, 2)",
    );

    // -----------------------------------------------------------------
    // emission_factors -- country tag + biogenic flag
    // -----------------------------------------------------------------
    await ensureColumn(client, "emission_factors", "country", "country TEXT");
    await ensureColumn(client, "emission_factors", "is_biogenic", "is_biogenic BOOLEAN NOT NULL DEFAULT FALSE");

    // -----------------------------------------------------------------
    // ipcc_default_factors -- biogenic flag + published confidence interval
    // -----------------------------------------------------------------
    await ensureColumn(client, "ipcc_default_factors", "is_biogenic", "is_biogenic BOOLEAN NOT NULL DEFAULT FALSE");
    await ensureColumn(client, "ipcc_default_factors", "factor_lower", "factor_lower NUMERIC(20, 8)");
    await ensureColumn(client, "ipcc_default_factors", "factor_upper", "factor_upper NUMERIC(20, 8)");

    // -----------------------------------------------------------------
    // calculation_approaches -- per-gas breakdown, mirrors emission_records
    // -----------------------------------------------------------------
    await ensureColumn(client, "calculation_approaches", "gas_breakdown", "gas_breakdown JSONB");

    // -----------------------------------------------------------------
    // emission_records -- facility/source-stream/boundary linkage
    // -----------------------------------------------------------------
    await ensureColumn(
      client,
      "emission_records",
      "facility_id",
      "facility_id INTEGER REFERENCES facilities(id) ON DELETE CASCADE",
    );
    await ensureColumn(
      client,
      "emission_records",
      "source_stream_id",
      "source_stream_id INTEGER REFERENCES source_streams(id) ON DELETE CASCADE",
    );
    await ensureColumn(
      client,
      "emission_records",
      "calculation_approach_id",
      "calculation_approach_id INTEGER REFERENCES calculation_approaches(id) ON DELETE SET NULL",
    );
    await ensureColumn(
      client,
      "emission_records",
      "reporting_boundary_id",
      "reporting_boundary_id INTEGER REFERENCES reporting_boundaries(id) ON DELETE CASCADE",
    );
    // 1:1 with calculationApproach, same pattern as calculation_approaches'
    // own unique-on-sourceStreamId constraint. Plain unique index: Postgres
    // excludes NULLs from the uniqueness check by default, so legacy rows
    // (calculation_approach_id IS NULL) never conflict with each other --
    // only real facility-MRV-computed rows (Plan 2) are constrained to one
    // emission_records row per calculation approach.
    await ensureIndex(
      client,
      "emission_records_calc_approach_unique",
      `CREATE UNIQUE INDEX emission_records_calc_approach_unique ON emission_records (calculation_approach_id)`,
    );

    // -----------------------------------------------------------------
    // reporting_entities -- base year
    // -----------------------------------------------------------------
    await ensureColumn(client, "reporting_entities", "base_year", "base_year INTEGER");
    await ensureColumn(client, "reporting_entities", "base_year_rationale", "base_year_rationale TEXT");

    // -----------------------------------------------------------------
    // reporting_boundaries -- intensity denominators + finalize/version snapshot
    // -----------------------------------------------------------------
    await ensureColumn(client, "reporting_boundaries", "revenue_amount", "revenue_amount NUMERIC(20, 2)");
    await ensureColumn(client, "reporting_boundaries", "revenue_currency", "revenue_currency TEXT");
    await ensureColumn(
      client,
      "reporting_boundaries",
      "full_time_equivalent_employees",
      "full_time_equivalent_employees NUMERIC(10, 1)",
    );
    await ensureColumn(client, "reporting_boundaries", "status", "status TEXT NOT NULL DEFAULT 'draft'");
    await ensureColumn(client, "reporting_boundaries", "finalized_at", "finalized_at TIMESTAMP");

    await client.query("COMMIT");

    console.log(`Applied ${applied.length} statement(s):`);
    applied.forEach((s) => console.log(`  + ${s}`));
    console.log(`Skipped ${skipped.length} (already present):`);
    skipped.forEach((s) => console.log(`  = ${s}`));
    console.log(
      "\nAll columns are nullable or safely defaulted -- no existing row is affected. " +
        "See docs/superpowers/specs/2026-08-14-verification-ready-multi-facility-inventory-design.md Section 1.",
    );
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

- [ ] **Step 2: Commit the script (without running it yet)**

```bash
git add scripts/manual-migration-007.mjs
git commit -m "$(cat <<'EOF'
Write manual-migration-007.mjs for verification-ready inventory columns

Idempotent, transactional migration for the columns added to
shared/schema.ts in the previous commit. Not yet run against the live DB
-- see Task 3.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Run the migration against the live Neon DB

**Files:** none (execution only).

**Interfaces:**
- Consumes: `scripts/manual-migration-007.mjs` from Task 2.
- Produces: the live database columns Plan 2/3/4 depend on existing.

- [ ] **Step 1: STOP — ask the user for explicit permission**

This project's standing rule (`CLAUDE.md`) requires asking before any DB-mutating action against the live Neon database. Do not run the migration without an explicit yes from the user in this session, even though the script is idempotent and additive-only. Use the AskUserQuestion tool: "OK to run manual-migration-007.mjs against the live Neon DB now?" with options "Yes, run it" / "Let me review the file first" — same pattern as migration 006 this session.

- [ ] **Step 2: Run the migration**

Run: `cd "C:\Users\LENOVO\Documents\ClaudeCowork\OUTPUTS\ghgcalculator" && node scripts/manual-migration-007.mjs`
Expected: `Applied 19 statement(s)` (1 facilities + 2 emission_factors + 3 ipcc_default_factors + 1 calculation_approaches + 4 emission_records columns + 1 emission_records unique index + 2 reporting_entities + 5 reporting_boundaries = 19), `Skipped 0`.

- [ ] **Step 3: Verify columns exist with a direct query**

Run this verification script and confirm it prints all 17 expected rows with no errors:

```bash
node -e "
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const res = await pool.query(\`
    SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE (table_name, column_name) IN (
      ('facilities','equity_share_ownership_percent'),
      ('emission_factors','country'), ('emission_factors','is_biogenic'),
      ('ipcc_default_factors','is_biogenic'), ('ipcc_default_factors','factor_lower'), ('ipcc_default_factors','factor_upper'),
      ('calculation_approaches','gas_breakdown'),
      ('emission_records','facility_id'), ('emission_records','source_stream_id'), ('emission_records','calculation_approach_id'), ('emission_records','reporting_boundary_id'),
      ('reporting_entities','base_year'), ('reporting_entities','base_year_rationale'),
      ('reporting_boundaries','revenue_amount'), ('reporting_boundaries','revenue_currency'), ('reporting_boundaries','full_time_equivalent_employees'), ('reporting_boundaries','status'), ('reporting_boundaries','finalized_at')
    )
    ORDER BY table_name, column_name
  \`);
  console.table(res.rows);
  console.log('Total columns found:', res.rowCount, '(expected 18)');
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
"
```

- [ ] **Step 4: No commit needed**

This task only ran an already-committed script against the live database — nothing in the working tree changed. Move to Plan 2.

## Self-Review

**Spec coverage:** every column in the design spec's Section 1 table is covered by Task 1 (schema.ts) and Task 2 (migration script) — cross-checked field-by-field against the spec's table during writing.

**Placeholder scan:** no TBD/TODO; every code block is complete, runnable SQL/TypeScript, not a description of what to write.

**Type consistency:** column names in `shared/schema.ts` (Task 1) and `manual-migration-007.mjs` (Task 2) match exactly (e.g. `equityShareOwnershipPercent` / `equity_share_ownership_percent` — camelCase in Drizzle, snake_case in SQL, the same convention every existing table in this file already uses). The verification query in Task 3 Step 3 references the same 17 columns.
