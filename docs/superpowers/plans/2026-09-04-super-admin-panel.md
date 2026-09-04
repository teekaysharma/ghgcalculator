# Platform Super-Admin Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a platform-wide `isSuperAdmin` flag and a small internal `/admin` page that lists every account across every tenant, letting a super-admin manually verify a pending registration or delete one outright.

**Architecture:** One new boolean column on `users` plus one new write-only `admin_action_log` audit table, seeded/created by an idempotent migration script. A new `requireSuperAdmin` Express middleware gates three new routes (list / verify / delete), all reusing the existing `verifyUserEmail` storage method and the existing `deleteExpiredUnverifiedRegistrations`-style `db.batch()` pattern for atomic deletes. A new standalone React page (`/admin`, not an `AppShell` section, since it's cross-tenant) consumes those routes with the same `apiRequest`/`useMutation`/`useToast` conventions already used throughout this codebase.

**Tech Stack:** Express + Passport (session auth), Drizzle ORM on `drizzle-orm/neon-http` (Postgres/Neon), React + Vite, wouter routing, TanStack Query, shadcn/ui components. No unit-test framework in this repo — verification is done via `tsc`, manual `curl`/browser checks, and this project's own script-based end-to-end tests (`npm run verify`, plus dedicated standalone scripts for destructive flows).

## Global Constraints

- Delete is scoped to **pending/unverified accounts only**. A verified account can be viewed but never deleted from this panel — attempting it returns `409 { reason: "already_verified" }`.
- Every verify/delete action writes a row to `admin_action_log` (actor, action, target user id, target email, timestamp). `admin_action_log` is write-only in v1 — no read/list endpoint.
- Only one super-admin is seeded, hardcoded by email (`teekaysharma@googlemail.com`) in the migration. No self-serve promotion path exists or should be built.
- `db.batch([...])` must be used for any multi-statement atomic write — `db.transaction()` throws at runtime on this project's `drizzle-orm/neon-http` driver (confirmed against driver source during the registration-hardening feature).
- All new schema changes go through a hand-written idempotent migration script (`scripts/manual-migration-NNN.mjs`), never `drizzle-kit push` — see `MIGRATIONS.md`.
- The new routes use `requireAuth` + a new `requireSuperAdmin` middleware, **never** `requireOrg` — a super-admin isn't scoped to one tenant.
- No rate limiter on the new admin routes (they're already auth + role gated; no unauthenticated attack surface to throttle).
- The `409`/`reason` error-response shape for "already verified" must match the existing precedent at `server/routes.ts:523-526` (`/api/auth/verify-email`'s own `already_verified` case) so the client's existing `throwIfResNotOk` (`client/src/lib/queryClient.ts:3-23`) surfaces it with no new contract.

---

### Task 1: Schema & migration

**Files:**
- Modify: `shared/schema.ts:46-50` (add `isSuperAdmin` column), and insert a new table after `shared/schema.ts:147`
- Create: `scripts/manual-migration-013.mjs`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `User.isSuperAdmin: boolean` (via `users.$inferSelect`, consumed by every later task); `adminActionLog` table; `AdminActionLog`/`InsertAdminActionLog` types; `adminActionLogActions = ["verify", "delete"] as const` union — Task 2 imports `adminActionLog` (the table) and `type AdminActionLog` from `@shared/schema`.

- [ ] **Step 1: Add `isSuperAdmin` to the `users` table**

In `shared/schema.ts`, the `users` table currently reads (lines 36-50):

```ts
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name"),
  // Registration hardening (2026-09-03): no session is created until this
  // flips true via POST /api/auth/verify-email. Existing rows are
  // grandfathered to true by scripts/manual-migration-012.mjs -- this gate
  // only applies to registrations created after that migration runs. See
  // docs/superpowers/specs/2026-09-03-registration-hardening-design.md.
  emailVerified: boolean("email_verified").notNull().default(false),
  emailVerificationToken: text("email_verification_token"),
  emailVerificationTokenExpiresAt: timestamp("email_verification_token_expires_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

Change it to add one new column (do **not** add it to `insertUserSchema`'s `.pick()` below — self-serve registration must never be able to set this):

```ts
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name"),
  // Registration hardening (2026-09-03): no session is created until this
  // flips true via POST /api/auth/verify-email. Existing rows are
  // grandfathered to true by scripts/manual-migration-012.mjs -- this gate
  // only applies to registrations created after that migration runs. See
  // docs/superpowers/specs/2026-09-03-registration-hardening-design.md.
  emailVerified: boolean("email_verified").notNull().default(false),
  emailVerificationToken: text("email_verification_token"),
  emailVerificationTokenExpiresAt: timestamp("email_verification_token_expires_at"),
  // Platform-wide admin flag (2026-09-04), distinct from the per-organization
  // owner/admin/member roles in `memberships.role` below. Deliberately
  // excluded from insertUserSchema's pick list -- self-serve registration
  // must never be able to set this. Seeded only via
  // scripts/manual-migration-013.mjs (hardcoded to the project owner's
  // email); no self-serve promotion path exists. See
  // docs/superpowers/specs/2026-09-04-super-admin-panel-design.md.
  isSuperAdmin: boolean("is_super_admin").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

- [ ] **Step 2: Add the `admin_action_log` table**

In `shared/schema.ts`, immediately after the existing block that ends with (around line 147):

```ts
export type InsertOrganizationModule = z.infer<typeof insertOrganizationModuleSchema>;
export type OrganizationModule = typeof organizationModules.$inferSelect;
```

and before the `// GHG Emission types` comment that follows it, insert:

```ts
// Write-only audit log for platform-admin actions (verify/delete a pending
// registration from the /admin panel) -- this acts across other tenants'
// data, so every action is recorded. No read/list endpoint in v1 (matches
// organizationModules' precedent of write-only infra with no HTTP route).
export const adminActionLogActions = ["verify", "delete"] as const;
export type AdminActionLogAction = (typeof adminActionLogActions)[number];

export const adminActionLog = pgTable("admin_action_log", {
  id: serial("id").primaryKey(),
  // The admin who performed the action. A real FK (unlike
  // organizationModules.enabledBy below) -- the actor here is always an
  // authenticated super-admin session, never a vendor-script identity.
  actorUserId: integer("actor_user_id").notNull().references(() => users.id),
  action: text("action").notNull(), // "verify" | "delete"
  // Deliberately NOT a foreign key: the delete action's entire point is
  // removing this row, and a hard FK would either block the delete or
  // depend on ON DELETE SET NULL firing correctly inside a db.batch() --
  // not worth the fragility.
  targetUserId: integer("target_user_id"),
  // Denormalized snapshot so the log row stays legible forever, independent
  // of whether targetUserId still resolves to a live row (it won't, after
  // a delete action).
  targetEmail: text("target_email").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertAdminActionLogSchema = createInsertSchema(adminActionLog).pick({
  actorUserId: true,
  action: true,
  targetUserId: true,
  targetEmail: true,
});

export type InsertAdminActionLog = z.infer<typeof insertAdminActionLogSchema>;
export type AdminActionLog = typeof adminActionLog.$inferSelect;
```

- [ ] **Step 3: Type-check**

Run: `npm run check`
Expected: clean, no errors. (This only checks the schema file compiles — nothing references the new column/table yet.)

- [ ] **Step 4: Create the migration script**

Create `scripts/manual-migration-013.mjs`:

```js
// scripts/manual-migration-013.mjs
//
// Platform super-admin panel: adds is_super_admin to users and creates the
// admin_action_log table, then seeds is_super_admin = true for the project
// owner's own account (hardcoded by email -- there is no self-serve
// promotion path, see
// docs/superpowers/specs/2026-09-04-super-admin-panel-design.md).
//
// Order, all in one transaction:
//   1. ADD COLUMN IF NOT EXISTS users.is_super_admin boolean (defaults false)
//   2. Seed is_super_admin = true for the owner's account, but ONLY if step 1
//      just created the column this run (same grandfather-gate pattern as
//      scripts/manual-migration-012.mjs's email_verified backfill, so this
//      never re-fires and can't accidentally re-promote/demote anyone
//      later). If no user row exists yet for that email, this is skipped
//      with a clear message rather than failing -- register that account
//      first, then re-run this script.
//   3. CREATE TABLE IF NOT EXISTS admin_action_log
//
// Idempotent like every other migration in this project: checks
// information_schema before any DDL change, safe to re-run.
//
// Usage: node scripts/manual-migration-013.mjs

import "dotenv/config";
import { Pool } from "pg";

const SUPER_ADMIN_EMAIL = "teekaysharma@googlemail.com";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL not set. Run this from the project folder with .env filled in.");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const applied = [];
const skipped = [];

// Returns true if the column was just added, false if it already existed.
async function addColumnIfMissing(client, columnName, ddl) {
  const res = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = $1`,
    [columnName],
  );
  if (res.rowCount > 0) {
    skipped.push(`users.${columnName} (already exists)`);
    return false;
  }
  await client.query(ddl);
  applied.push(`ALTER TABLE users ADD COLUMN ${columnName}`);
  return true;
}

async function createTableIfMissing(client, tableName, ddl) {
  const res = await client.query(`SELECT 1 FROM information_schema.tables WHERE table_name = $1`, [tableName]);
  if (res.rowCount > 0) {
    skipped.push(`table ${tableName} (already exists)`);
    return false;
  }
  await client.query(ddl);
  applied.push(`CREATE TABLE ${tableName}`);
  return true;
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const isSuperAdminWasJustAdded = await addColumnIfMissing(
      client,
      "is_super_admin",
      `ALTER TABLE users ADD COLUMN is_super_admin boolean NOT NULL DEFAULT false`,
    );

    // Gated exactly like manual-migration-012.mjs's email_verified
    // grandfather backfill: only runs the one-time seed if the column was
    // just created in THIS invocation, so re-running the script can never
    // silently re-promote or demote the seeded account.
    if (isSuperAdminWasJustAdded) {
      const owner = await client.query(`SELECT id FROM users WHERE email = $1`, [SUPER_ADMIN_EMAIL]);
      if (owner.rowCount > 0) {
        await client.query(`UPDATE users SET is_super_admin = true WHERE id = $1`, [owner.rows[0].id]);
        applied.push(`seeded is_super_admin = true for ${SUPER_ADMIN_EMAIL}`);
      } else {
        skipped.push(
          `seed super-admin (no user row found for ${SUPER_ADMIN_EMAIL} -- register that account, then re-run this script)`,
        );
      }
    } else {
      skipped.push("seed super-admin (is_super_admin column already existed, no seed re-run)");
    }

    await createTableIfMissing(
      client,
      "admin_action_log",
      `CREATE TABLE admin_action_log (
        id serial PRIMARY KEY,
        actor_user_id integer NOT NULL REFERENCES users(id),
        action text NOT NULL,
        target_user_id integer,
        target_email text NOT NULL,
        created_at timestamp NOT NULL DEFAULT now()
      )`,
    );

    await client.query("COMMIT");

    console.log(`Applied ${applied.length} step(s):`);
    applied.forEach((s) => console.log(`  + ${s}`));
    console.log(`Skipped ${skipped.length}:`);
    skipped.forEach((s) => console.log(`  = ${s}`));
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error("ROLLBACK itself failed:", rollbackErr);
    }
    console.error("Migration failed, rolled back. No partial changes were applied.");
    console.error(err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
```

- [ ] **Step 5: Run the migration**

Run: `node scripts/manual-migration-013.mjs`
Expected: prints `Applied N step(s)` including `ALTER TABLE users ADD COLUMN is_super_admin` and `CREATE TABLE admin_action_log`. The seed line depends on live DB state — it will either say `seeded is_super_admin = true for teekaysharma@googlemail.com`, or (if that account doesn't currently exist) `seed super-admin (no user row found for teekaysharma@googlemail.com -- register that account, then re-run this script)`. **If you see the latter**, that's expected and not a failure — register an account with that exact email through the running app's `/register` page at some point before Task 3's manual verification, then re-run this script once to seed it (the column-add step will correctly skip on that re-run; only the seed step will fire, since it's independently gated on "row exists" rather than "column exists").

- [ ] **Step 6: Verify idempotency**

Run: `node scripts/manual-migration-013.mjs` again.
Expected: `Applied 0 step(s)`, all three checks report `Skipped`, including the seed line reporting `seed super-admin (is_super_admin column already existed, no seed re-run)` — never re-running the UPDATE.

- [ ] **Step 7: Commit**

```bash
git add shared/schema.ts scripts/manual-migration-013.mjs
git commit -m "feat: add users.is_super_admin and admin_action_log for the platform admin panel"
```

---

### Task 2: Server — middleware, storage, routes

**Files:**
- Create: `server/middleware/admin.ts`
- Modify: `server/storage.ts` (new `AdminUserListItem` interface, 3 new `IStorage` methods + `DbStorage` implementations, import additions)
- Modify: `server/routes.ts` (import `requireSuperAdmin`, 3 new routes, extend `/api/auth/me` and the login success response)

**Interfaces:**
- Consumes: Task 1's `User.isSuperAdmin`, `adminActionLog` table, `type AdminActionLog`.
- Produces:
  - `requireSuperAdmin(req, res, next)` middleware, exported from `server/middleware/admin.ts`.
  - `storage.listAllUsersForAdmin(): Promise<AdminUserListItem[]>`
  - `storage.deleteUnverifiedUserById(userId: number, actorUserId: number): Promise<"deleted" | "not_found" | "already_verified">`
  - `storage.logAdminAction(entry: { actorUserId: number; action: "verify" | "delete"; targetUserId: number; targetEmail: string }): Promise<AdminActionLog>`
  - Routes: `GET /api/admin/users` → `200 { users: AdminUserListItem[] }`; `POST /api/admin/users/:id/verify` → `200 { user }` / `404`; `DELETE /api/admin/users/:id` → `204` / `404` / `409 { message, reason: "already_verified" }`.
  - `GET /api/auth/me` and `POST /api/auth/login`'s success response both gain `user.isSuperAdmin: boolean` — Task 3 consumes this exact field name.

- [ ] **Step 1: Create the `requireSuperAdmin` middleware**

Create `server/middleware/admin.ts`:

```ts
import type { Request, Response, NextFunction } from "express";

/**
 * Rejects requests from non-super-admin users. Must run after requireAuth
 * (reads req.user). Deliberately never paired with requireOrg -- a
 * super-admin isn't scoped to any one tenant, matching the requireAuth-only
 * pattern already used by the reference-data routes in server/routes.ts
 * (~line 2055 onward).
 */
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user?.isSuperAdmin) {
    return res.status(403).json({ message: "Super-admin access required" });
  }
  next();
}
```

No change needed to `server/types/express.d.ts` — `Express.User extends SchemaUser` already means `req.user.isSuperAdmin` is correctly typed once Task 1's schema column exists.

- [ ] **Step 2: Add storage imports**

In `server/storage.ts`, the import block from `"@shared/schema"` currently ends (around line 76):

```ts
  gwpValues,
  type Organization,
  type InsertOrganization,
  type User,
  type InsertUser,
  type Membership,
  type InsertMembership,
  type EmissionFactorRow,
```

Change to add `adminActionLog` (the table, alongside the other non-type imports) and `type AdminActionLog`:

```ts
  gwpValues,
  adminActionLog,
  type Organization,
  type InsertOrganization,
  type User,
  type InsertUser,
  type Membership,
  type InsertMembership,
  type AdminActionLog,
  type EmissionFactorRow,
```

(Everything else in that import block is unchanged.)

- [ ] **Step 3: Add the `AdminUserListItem` interface and `IStorage` method signatures**

In `server/storage.ts`, immediately before the `// --- IStorage ---` comment block (the comment that starts `// -----------------------------------------------------------------------\n// IStorage`, around line 190), insert:

```ts
// -----------------------------------------------------------------------
// AdminUserListItem
//
// Response shape for GET /api/admin/users. organizations is an array (not
// a single object) because the schema itself allows a user to belong to
// more than one organization even though nothing in the product creates
// that today (memberships only enforces uniqueness on (userId,
// organizationId), not on userId alone) -- this is the honest shape rather
// than silently assuming one org per user forever.
// -----------------------------------------------------------------------
export interface AdminUserListItem {
  id: number;
  email: string;
  name: string | null;
  emailVerified: boolean;
  isSuperAdmin: boolean;
  createdAt: Date;
  organizations: { organizationId: number; organizationName: string; role: string }[];
}
```

Then, inside the `IStorage` interface, immediately after the existing last method (`getSourceStreamDetailForBoundary(...)`, right before the interface's closing `}`, around line 350-351):

```ts
  getSourceStreamDetailForBoundary(organizationId: number, reportingBoundaryId: number): Promise<SourceStreamDetail[]>;

  // Platform admin (super-admin only, cross-tenant). Like
  // deleteExpiredUnverifiedRegistrations above, these take no
  // organizationId -- a super-admin isn't scoped to one tenant.
  listAllUsersForAdmin(): Promise<AdminUserListItem[]>;
  deleteUnverifiedUserById(userId: number, actorUserId: number): Promise<"deleted" | "not_found" | "already_verified">;
  logAdminAction(entry: {
    actorUserId: number;
    action: "verify" | "delete";
    targetUserId: number;
    targetEmail: string;
  }): Promise<AdminActionLog>;
}
```

(Only the 4 new lines plus the closing `}` are new — `getSourceStreamDetailForBoundary`'s own line is shown for placement context, don't duplicate it.)

- [ ] **Step 4: Implement the three methods on `DbStorage`**

In `server/storage.ts`, `DbStorage`'s last method is `getSourceStreamDetailForBoundary`, ending right before the class's closing `}` (around line 1490-1491):

```ts
      };
    });
  }
}

export const storage = new DbStorage();
```

Insert the three new methods between the end of `getSourceStreamDetailForBoundary`'s body and the class's closing `}`:

```ts
      };
    });
  }

  async listAllUsersForAdmin(): Promise<AdminUserListItem[]> {
    const allUsers = await db.select().from(users).orderBy(desc(users.createdAt));
    const allMemberships = await db
      .select({
        userId: memberships.userId,
        organizationId: memberships.organizationId,
        role: memberships.role,
        organizationName: organizations.name,
      })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.organizationId));

    const orgsByUserId = new Map<number, { organizationId: number; organizationName: string; role: string }[]>();
    for (const m of allMemberships) {
      const list = orgsByUserId.get(m.userId) ?? [];
      list.push({ organizationId: m.organizationId, organizationName: m.organizationName, role: m.role });
      orgsByUserId.set(m.userId, list);
    }

    return allUsers.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      emailVerified: u.emailVerified,
      isSuperAdmin: u.isSuperAdmin,
      createdAt: u.createdAt,
      organizations: orgsByUserId.get(u.id) ?? [],
    }));
  }

  async deleteUnverifiedUserById(
    userId: number,
    actorUserId: number,
  ): Promise<"deleted" | "not_found" | "already_verified"> {
    const [target] = await db.select().from(users).where(eq(users.id, userId));
    if (!target) return "not_found";
    if (target.emailVerified) return "already_verified";

    const userMemberships = await db.select().from(memberships).where(eq(memberships.userId, userId));
    // A pending (just-registered, unverified) user always has exactly one
    // membership -- registration creates it atomically. orgId is only
    // undefined in a data-integrity-violation scenario this shouldn't ever
    // reach, handled defensively below rather than assumed away.
    const orgId = userMemberships[0]?.organizationId;

    // Same db.batch() requirement as deleteExpiredUnverifiedRegistrations
    // above -- db.transaction() throws on this project's neon-http driver.
    // The audit-log insert rides in the same batch as the deletes so "the
    // row is gone" and "there's a record of who removed it" are one atomic
    // fact, never one without the other.
    if (orgId) {
      await db.batch([
        db.insert(adminActionLog).values({
          actorUserId,
          action: "delete",
          targetUserId: target.id,
          targetEmail: target.email,
        }),
        db.delete(organizations).where(eq(organizations.id, orgId)),
        db.delete(users).where(eq(users.id, userId)),
      ]);
    } else {
      await db.batch([
        db.insert(adminActionLog).values({
          actorUserId,
          action: "delete",
          targetUserId: target.id,
          targetEmail: target.email,
        }),
        db.delete(users).where(eq(users.id, userId)),
      ]);
    }

    return "deleted";
  }

  async logAdminAction(entry: {
    actorUserId: number;
    action: "verify" | "delete";
    targetUserId: number;
    targetEmail: string;
  }): Promise<AdminActionLog> {
    const [row] = await db.insert(adminActionLog).values(entry).returning();
    return row;
  }
}

export const storage = new DbStorage();
```

(Note `verifyUserEmail` is **not** touched — it already exists at `server/storage.ts:389-394` and is reused unmodified by the route in the next step.)

- [ ] **Step 5: Type-check**

Run: `npm run check`
Expected: clean. If it isn't, the most likely cause is a missed import (`adminActionLog` or `type AdminActionLog` from Step 2) — fix before continuing.

- [ ] **Step 6: Import `requireSuperAdmin` into routes.ts**

In `server/routes.ts`, line 10 currently reads:

```ts
import { requireAuth, requireOrg } from "./middleware/tenant";
```

Change to:

```ts
import { requireAuth, requireOrg } from "./middleware/tenant";
import { requireSuperAdmin } from "./middleware/admin";
```

- [ ] **Step 7: Extend `/api/auth/me` and the login success response**

In `server/routes.ts`, the login handler (around line 573-591) currently ends its success path with:

```ts
        req.login(user, (loginErr) => {
          if (loginErr) return next(loginErr);
          return res.json({ user: { id: user.id, email: user.email, name: user.name } });
        });
```

Change the response line to:

```ts
        req.login(user, (loginErr) => {
          if (loginErr) return next(loginErr);
          return res.json({ user: { id: user.id, email: user.email, name: user.name, isSuperAdmin: user.isSuperAdmin } });
        });
```

The `/api/auth/me` handler (around line 603-620) currently reads:

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

Change to:

```ts
  app.get("/api/auth/me", requireAuth, async (req, res) => {
    const user = req.user as { id: number; email: string; name: string | null; isSuperAdmin: boolean };
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
    return res.json({
      user: { id: user.id, email: user.email, name: user.name, isSuperAdmin: user.isSuperAdmin },
      memberships,
      organizations,
    });
  });
```

- [ ] **Step 8: Add the three admin routes**

Immediately after the `/api/auth/me` handler's closing `});` from the previous step, and before the existing `// --- Team ---` comment block, insert:

```ts
  // -----------------------------------------------------------------------
  // Platform admin (super-admin only, cross-tenant). See
  // docs/superpowers/specs/2026-09-04-super-admin-panel-design.md. Delete is
  // deliberately scoped to pending/unverified accounts only -- a verified
  // tenant's organization cascades through every tenant-scoped table, and
  // emission_factors.uploaded_by/emission_records.created_by reference
  // users.id with no cascade, so deleting a user who's created data would
  // hit a hard FK failure. Removing a live tenant is out of scope here.
  // -----------------------------------------------------------------------
  app.get("/api/admin/users", requireAuth, requireSuperAdmin, async (_req, res) => {
    const usersList = await storage.listAllUsersForAdmin();
    return res.json({ users: usersList });
  });

  app.post("/api/admin/users/:id/verify", requireAuth, requireSuperAdmin, async (req, res) => {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({ message: "Invalid user id" });
    }
    const target = await storage.getUser(targetId);
    if (!target) return res.status(404).json({ message: "User not found" });
    await storage.verifyUserEmail(target.id);
    try {
      await storage.logAdminAction({
        actorUserId: (req.user as { id: number }).id,
        action: "verify",
        targetUserId: target.id,
        targetEmail: target.email,
      });
    } catch (err) {
      // A logging failure must never turn a successful verify into a 500 --
      // the admin's action already succeeded.
      console.error("Failed to write admin action log (verify):", err);
    }
    return res.status(200).json({ user: { id: target.id, email: target.email, name: target.name, emailVerified: true } });
  });

  app.delete("/api/admin/users/:id", requireAuth, requireSuperAdmin, async (req, res) => {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({ message: "Invalid user id" });
    }
    const target = await storage.getUser(targetId);
    if (!target) return res.status(404).json({ message: "User not found" });
    if (target.emailVerified) {
      return res.status(409).json({ message: "Cannot delete a verified account from this panel.", reason: "already_verified" });
    }
    const result = await storage.deleteUnverifiedUserById(targetId, (req.user as { id: number }).id);
    if (result === "not_found") return res.status(404).json({ message: "User not found" });
    if (result === "already_verified") {
      return res.status(409).json({ message: "Cannot delete a verified account from this panel.", reason: "already_verified" });
    }
    return res.status(204).end();
  });

```

- [ ] **Step 9: Type-check**

Run: `npm run check`
Expected: clean.

- [ ] **Step 10: Manual verification against the running server**

Start the dev server in one terminal: `npm run dev`

In another terminal, register + verify + promote a scratch admin user, then exercise all three routes:

```bash
curl -s -X POST http://localhost:5000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"plantest-admin@example.invalid","password":"PlanTest12345","organizationName":"plantest-admin"}'
```
Expected: `{"status":"pending_verification",...}`.

```bash
node -e '
const { Pool } = require("pg");
require("dotenv").config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query("SELECT email_verification_token FROM users WHERE email = $1", ["plantest-admin@example.invalid"])
  .then(r => { console.log(r.rows[0].email_verification_token); return pool.end(); });
'
```
Copy the printed token, then:

```bash
curl -s -X POST http://localhost:5000/api/auth/verify-email \
  -H "Content-Type: application/json" \
  -d '{"token":"<paste token here>"}' -i
```
Expected: `HTTP/1.1 204`.

```bash
node -e '
const { Pool } = require("pg");
require("dotenv").config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query("UPDATE users SET is_super_admin = true WHERE email = $1", ["plantest-admin@example.invalid"])
  .then(() => pool.end());
'
```

```bash
curl -s -c /tmp/admincookie.txt -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"plantest-admin@example.invalid","password":"PlanTest12345"}'
```
Expected: `{"user":{...,"isSuperAdmin":true}}` — confirm `isSuperAdmin` is present and `true` in this response.

```bash
curl -s -b /tmp/admincookie.txt http://localhost:5000/api/admin/users
```
Expected: `{"users":[...]}` including an entry for `plantest-admin@example.invalid`.

Register a second scratch user (leave unverified), then:

```bash
curl -s -b /tmp/admincookie.txt -X POST http://localhost:5000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"plantest-pending@example.invalid","password":"PlanTest12345","organizationName":"plantest-pending"}'
```

Find its id from the `GET /api/admin/users` response above (or query the DB by email), then:

```bash
curl -s -b /tmp/admincookie.txt -X POST http://localhost:5000/api/admin/users/<id>/verify
```
Expected: `{"user":{...,"emailVerified":true}}`.

```bash
curl -s -b /tmp/admincookie.txt -X DELETE http://localhost:5000/api/admin/users/<plantest-admin's own id>
```
Expected: `HTTP 409` body `{"message":"Cannot delete a verified account from this panel.","reason":"already_verified"}` (the admin account itself is verified, so this proves the pending-only delete scope).

Clean up manually afterward:
```bash
node -e '
const { Pool } = require("pg");
require("dotenv").config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const emails = ["plantest-admin@example.invalid", "plantest-pending@example.invalid"];
  const rows = (await pool.query("SELECT id, email FROM users WHERE email = ANY($1)", [emails])).rows;
  const ids = rows.map(r => r.id);
  if (ids.length) await pool.query("DELETE FROM admin_action_log WHERE actor_user_id = ANY($1)", [ids]);
  for (const r of rows) {
    const m = await pool.query("SELECT organization_id FROM memberships WHERE user_id = $1", [r.id]);
    if (m.rows[0]) await pool.query("DELETE FROM organizations WHERE id = $1", [m.rows[0].organization_id]);
    await pool.query("DELETE FROM users WHERE id = $1", [r.id]);
  }
  await pool.end();
})();
'
```

- [ ] **Step 11: Commit**

```bash
git add server/middleware/admin.ts server/storage.ts server/routes.ts
git commit -m "feat: add platform admin routes (list/verify/delete accounts)"
```

---

### Task 3: Client — admin page, nav link, route

**Files:**
- Modify: `client/src/hooks/use-auth.tsx:5-9` (add `isSuperAdmin` to `AuthUser`)
- Create: `client/src/pages/Admin.tsx`
- Modify: `client/src/pages/Home.tsx` (nav link)
- Modify: `client/src/App.tsx` (import + route)

**Interfaces:**
- Consumes: Task 2's route contracts (`GET /api/admin/users`, `POST /api/admin/users/:id/verify`, `DELETE /api/admin/users/:id`) and the extended `/api/auth/me` shape (`user.isSuperAdmin`).
- Produces: the `/admin` page, reachable via a nav link visible only to `user.isSuperAdmin`.

- [ ] **Step 1: Extend `AuthUser`**

In `client/src/hooks/use-auth.tsx`, the `AuthUser` interface currently reads (lines 5-9):

```ts
interface AuthUser {
  id: number;
  email: string;
  name: string | null;
}
```

Change to:

```ts
interface AuthUser {
  id: number;
  email: string;
  name: string | null;
  isSuperAdmin: boolean;
}
```

No other change in this file is needed — `value.user = meQuery.data?.user ?? null` already flows the new field through automatically once the server sends it.

- [ ] **Step 2: Create the Admin page**

Create `client/src/pages/Admin.tsx`:

```tsx
import { useEffect } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

interface AdminOrgSummary {
  organizationId: number;
  organizationName: string;
  role: string;
}

interface AdminUserListItem {
  id: number;
  email: string;
  name: string | null;
  emailVerified: boolean;
  isSuperAdmin: boolean;
  createdAt: string;
  organizations: AdminOrgSummary[];
}

export default function Admin() {
  const { user, isLoading } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Auth-only gating is handled by ProtectedRoute (App.tsx). This is the
  // extra, super-admin-only gate: redirect a logged-in but non-admin user
  // straight back to the app, same loading/redirect shape as
  // ProtectedRoute itself.
  useEffect(() => {
    if (!isLoading && user && !user.isSuperAdmin) {
      setLocation("/");
    }
  }, [isLoading, user, setLocation]);

  const usersQuery = useQuery<{ users: AdminUserListItem[] }>({
    queryKey: ["/api/admin/users"],
    enabled: !!user?.isSuperAdmin,
  });

  const verify = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/admin/users/${id}/verify`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      toast({ title: "Account verified" });
    },
    onError: (err) => toast({ title: "Could not verify account", description: err.message, variant: "destructive" }),
  });

  const deleteUser = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/admin/users/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      toast({ title: "Registration deleted" });
    },
    onError: (err) => toast({ title: "Could not delete registration", description: err.message, variant: "destructive" }),
  });

  if (isLoading || !user?.isSuperAdmin) return null;

  const rows = usersQuery.data?.users ?? [];

  return (
    <div className="min-h-screen bg-neutral-50 font-sans">
      <div className="container mx-auto px-4 py-8 max-w-6xl">
        <header className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="font-heading font-bold text-3xl text-primary-800 mb-1">Platform Admin</h1>
            <p className="text-neutral-600 text-sm">All accounts across every organization.</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setLocation("/")}>
            Back to app
          </Button>
        </header>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Accounts</CardTitle>
            <CardDescription>
              Verify or delete a pending registration. Verified accounts are view-only here.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {usersQuery.isLoading && <div className="text-sm text-neutral-500">Loading...</div>}
            {!usersQuery.isLoading && rows.length === 0 && (
              <p className="text-sm text-neutral-500">No accounts found.</p>
            )}
            {rows.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Organization</TableHead>
                    <TableHead>Registered</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((u) => {
                    const org = u.organizations[0];
                    const orgLabel = org
                      ? u.organizations.length > 1
                        ? `${org.organizationName} +${u.organizations.length - 1} more`
                        : org.organizationName
                      : "—";
                    return (
                      <TableRow key={u.id}>
                        <TableCell>{u.email}</TableCell>
                        <TableCell>{u.name ?? "-"}</TableCell>
                        <TableCell>
                          {u.emailVerified ? (
                            <Badge variant="secondary">Verified</Badge>
                          ) : (
                            <Badge variant="outline">Pending</Badge>
                          )}
                        </TableCell>
                        <TableCell>{orgLabel}</TableCell>
                        <TableCell>{new Date(u.createdAt).toLocaleDateString()}</TableCell>
                        <TableCell>
                          {!u.emailVerified && (
                            <div className="flex gap-2 justify-end">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => verify.mutate(u.id)}
                                disabled={verify.isPending}
                              >
                                Verify
                              </Button>
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button variant="ghost" size="sm" className="text-destructive">
                                    Delete
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>Delete this registration?</AlertDialogTitle>
                                    <AlertDialogDescription>
                                      This permanently removes {u.email} and its organization. This cannot be undone.
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction onClick={() => deleteUser.mutate(u.id)}>
                                      Delete
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add the nav link**

In `client/src/pages/Home.tsx`, the import block currently starts:

```tsx
import { useState } from "react";
import AppShell from "@/components/AppShell";
```

Change to add the `Link` import:

```tsx
import { useState } from "react";
import { Link } from "wouter";
import AppShell from "@/components/AppShell";
```

Further down, the header's button group currently reads:

```tsx
            <div className="flex items-center gap-3 mt-4 md:mt-0">
              <div className="text-right text-sm">
                {org && <div className="font-medium text-neutral-800">{org.name}</div>}
                {user && <div className="text-neutral-500">{user.email}</div>}
              </div>
              <Button variant="outline" size="sm" onClick={() => logout()}>
                Log out
              </Button>
            </div>
```

Change to:

```tsx
            <div className="flex items-center gap-3 mt-4 md:mt-0">
              <div className="text-right text-sm">
                {org && <div className="font-medium text-neutral-800">{org.name}</div>}
                {user && <div className="text-neutral-500">{user.email}</div>}
              </div>
              {user?.isSuperAdmin && (
                <Link href="/admin" className="text-sm text-primary-600 hover:underline">
                  Admin
                </Link>
              )}
              <Button variant="outline" size="sm" onClick={() => logout()}>
                Log out
              </Button>
            </div>
```

- [ ] **Step 4: Register the route**

In `client/src/App.tsx`, the imports currently read:

```tsx
import { Switch, Route } from "wouter";
import NotFound from "@/pages/not-found";
import Home from "@/pages/Home";
import Login from "@/pages/Login";
import Register from "@/pages/Register";
import VerifyEmail from "@/pages/VerifyEmail";
import Footer from "./Footer"; // Import the Footer component
import { AuthProvider } from "@/hooks/use-auth";
import ProtectedRoute from "@/components/ProtectedRoute";

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/register" component={Register} />
      <Route path="/verify-email" component={VerifyEmail} />
      <Route path="/">
        <ProtectedRoute>
          <Home />
        </ProtectedRoute>
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}
```

Change to:

```tsx
import { Switch, Route } from "wouter";
import NotFound from "@/pages/not-found";
import Home from "@/pages/Home";
import Login from "@/pages/Login";
import Register from "@/pages/Register";
import VerifyEmail from "@/pages/VerifyEmail";
import Admin from "@/pages/Admin";
import Footer from "./Footer"; // Import the Footer component
import { AuthProvider } from "@/hooks/use-auth";
import ProtectedRoute from "@/components/ProtectedRoute";

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/register" component={Register} />
      <Route path="/verify-email" component={VerifyEmail} />
      <Route path="/admin">
        <ProtectedRoute>
          <Admin />
        </ProtectedRoute>
      </Route>
      <Route path="/">
        <ProtectedRoute>
          <Home />
        </ProtectedRoute>
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}
```

- [ ] **Step 5: Type-check**

Run: `npm run check`
Expected: clean.

- [ ] **Step 6: Manual browser verification**

With the dev server running (`npm run dev`) and Task 1's migration having successfully seeded a real super-admin (see Task 1 Step 5's note — register `teekaysharma@googlemail.com` through `/register` first if that step reported the seed was skipped, then re-run `node scripts/manual-migration-013.mjs` once):

1. Log in as the seeded super-admin at `/login`. Confirm an "Admin" link now appears in the header next to "Log out".
2. Click it, or navigate to `/admin` directly. Confirm the accounts table loads and includes your own row with a "Verified" badge and no action buttons.
3. Register a second, throwaway account from a private/incognito window (or log out and back in as the admin after). Back on `/admin`, confirm the new pending account appears with a "Pending" badge and both "Verify" and "Delete" buttons.
4. Click "Verify" on it. Confirm its badge flips to "Verified" and its action buttons disappear, without a page reload.
5. Register a third throwaway account, click "Delete" on its row, confirm the `AlertDialog` appears, confirm cancelling leaves the row in place, then confirm on a second attempt. Confirm the row disappears from the list.
6. Log out, log in as a non-admin account. Confirm no "Admin" link appears, and confirm navigating to `/admin` directly redirects back to `/`.

- [ ] **Step 7: Commit**

```bash
git add client/src/hooks/use-auth.tsx client/src/pages/Admin.tsx client/src/pages/Home.tsx client/src/App.tsx
git commit -m "feat: add /admin page for platform account management"
```

---

### Task 4: Testing

**Files:**
- Create: `scripts/verify-admin-panel.mjs`
- Modify: `scripts/verify-branch.mjs:156-171` (extend `step3_dbPush`'s schema-precondition check)

**Interfaces:**
- Consumes: Tasks 1-3 fully in place (exercises the real endpoints and DB state end-to-end).
- Produces: automated regression coverage for the feature; no new interfaces for later tasks (this is the last task).

- [ ] **Step 1: Extend `verify-branch.mjs`'s schema check**

In `scripts/verify-branch.mjs`, `step3_dbPush` currently queries (around lines 156-171):

```js
    const res = await pool.query(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE (table_name = 'emission_factors' AND column_name = 'year')
         OR (table_name = 'emission_records' AND column_name = 'scope3_category')
         OR (table_name = 'users' AND column_name IN (
              'email_verified', 'email_verification_token', 'email_verification_token_expires_at'
            ))
    `);
    const found = new Set(res.rows.map((r) => `${r.table_name}.${r.column_name}`));
    const required = [
      "emission_factors.year",
      "emission_records.scope3_category",
      "users.email_verified",
      "users.email_verification_token",
      "users.email_verification_token_expires_at",
    ];
    const missing = required.filter((r) => !found.has(r));
    if (missing.length > 0) {
      throw new Error(
        `Schema is out of sync: missing ${missing.join(", ")}. Run the relevant migration ` +
          `script in scripts/ against DATABASE_URL before re-running verify.`,
      );
    }
```

Change to add the `is_super_admin` column to the same column check, and add a separate table-existence check for `admin_action_log` (a whole-table check, since the existing query only covers columns):

```js
    const res = await pool.query(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE (table_name = 'emission_factors' AND column_name = 'year')
         OR (table_name = 'emission_records' AND column_name = 'scope3_category')
         OR (table_name = 'users' AND column_name IN (
              'email_verified', 'email_verification_token', 'email_verification_token_expires_at',
              'is_super_admin'
            ))
    `);
    const found = new Set(res.rows.map((r) => `${r.table_name}.${r.column_name}`));
    const required = [
      "emission_factors.year",
      "emission_records.scope3_category",
      "users.email_verified",
      "users.email_verification_token",
      "users.email_verification_token_expires_at",
      "users.is_super_admin",
    ];
    const missing = required.filter((r) => !found.has(r));
    if (missing.length > 0) {
      throw new Error(
        `Schema is out of sync: missing ${missing.join(", ")}. Run the relevant migration ` +
          `script in scripts/ against DATABASE_URL before re-running verify.`,
      );
    }

    const adminLogTable = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'admin_action_log'`,
    );
    if (adminLogTable.rowCount === 0) {
      throw new Error(
        "Schema is out of sync: missing table admin_action_log. Run scripts/manual-migration-013.mjs " +
          "against DATABASE_URL before re-running verify.",
      );
    }
```

Also update the `ok(...)` call right after this block (a few lines further down) to mention the new checks — it currently reads:

```js
  ok(
    "schema check",
    "emission_factors.year, emission_records.scope3_category, and users email-verification columns present",
  );
```

Change to:

```js
  ok(
    "schema check",
    "emission_factors.year, emission_records.scope3_category, users email-verification/is_super_admin columns, and admin_action_log table present",
  );
```

- [ ] **Step 2: Run the full smoke test**

Run: `npm run verify`
Expected: all steps pass, including the extended schema check, exit code 0.

- [ ] **Step 3: Create the standalone admin-panel test script**

Create `scripts/verify-admin-panel.mjs`:

```js
// scripts/verify-admin-panel.mjs
//
// Dedicated test for the platform super-admin panel (GET /api/admin/users,
// POST /api/admin/users/:id/verify, DELETE /api/admin/users/:id) -- kept
// separate from scripts/verify-branch.mjs on purpose (see
// docs/superpowers/specs/2026-09-04-super-admin-panel-design.md): it
// deletes data, so it isn't something to run on every npm run verify pass.
//
// Requires the dev server already running (npm run dev in another
// terminal) -- this script does not start or stop it.
//
// There is no self-serve way to become a super-admin (see the design
// spec's "Only one super-admin is seeded" decision) -- this script
// promotes its own tagged test user directly via SQL after registering it
// through the real HTTP flow, then reuses that session's cookie. This
// works without a fresh login because passport's deserializeUser
// (server/auth.ts) re-fetches the full user row from the DB on every
// request, so an already-established session cookie picks up the flag on
// its very next use.
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
    const adminCookie = await login(adminEmail);

    const plainEmail = await registerAndVerify(pool, `${RUN_TAG}-plain`);
    createdEmails.push(plainEmail);
    const plainCookie = await login(plainEmail);

    // --- scenario 1: non-admin gets 403 on all three routes ---
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

    // --- scenario 2: admin's list includes its own row ---
    {
      const res = await fetch(`${BASE_URL}/api/admin/users`, { headers: { Cookie: adminCookie } });
      const body = await res.json().catch(() => ({}));
      const found = Array.isArray(body.users) && body.users.some((u) => u.email === adminEmail);
      if (res.status === 200 && found) {
        ok("GET /api/admin/users (admin)", `200, ${body.users.length} user(s), includes self`);
      } else {
        fail("GET /api/admin/users (admin)", `status ${res.status}, body ${JSON.stringify(body)}`);
      }
    }

    // --- scenario 3: verify flips DB state and logs an action ---
    const pendingEmail1 = `${RUN_TAG}-pending1@example.invalid`;
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
        const targetId = await getUserId(pool, pendingEmail1);
        const res = await fetch(`${BASE_URL}/api/admin/users/${targetId}/verify`, {
          method: "POST",
          headers: { Cookie: adminCookie },
        });
        const dbRow = await pool.query(
          "SELECT email_verified, email_verification_token FROM users WHERE id = $1",
          [targetId],
        );
        const verified = dbRow.rows[0]?.email_verified === true && dbRow.rows[0]?.email_verification_token === null;
        if (res.status === 200 && verified) {
          ok("POST /api/admin/users/:id/verify", "200, email_verified=true, token cleared");
        } else {
          fail("POST /api/admin/users/:id/verify", `status ${res.status}, db row ${JSON.stringify(dbRow.rows[0])}`);
        }

        const logRow = await pool.query(
          `SELECT action, target_user_id, target_email FROM admin_action_log
           WHERE actor_user_id = (SELECT id FROM users WHERE email = $1) AND action = 'verify' AND target_email = $2`,
          [adminEmail, pendingEmail1],
        );
        if (logRow.rowCount >= 1) ok("admin_action_log (verify)", "row written with correct actor/target");
        else fail("admin_action_log (verify)", "no matching row found");
      }
    }

    // --- scenario 4: delete removes a pending user, log row survives ---
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
           WHERE actor_user_id = (SELECT id FROM users WHERE email = $1) AND action = 'delete' AND target_email = $2`,
          [adminEmail, pendingEmail2],
        );
        if (logRow.rowCount >= 1) {
          ok("admin_action_log (delete)", "row survives target deletion (target_user_id not an FK)");
        } else {
          fail("admin_action_log (delete)", "no matching row found");
        }
      }
    }

    // --- scenario 5: deleting a VERIFIED user is rejected, nothing changes ---
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

    // --- scenario 6: 404s on a nonexistent id ---
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
  } finally {
    // Cleanup. Order matters: admin_action_log.actor_user_id is a real FK
    // with no cascade (same class of constraint as
    // emission_factors.uploaded_by) -- the admin-actor's own log rows must
    // be deleted before that actor's users row, or this cleanup would hit
    // the exact FK failure the feature's delete-scope decision was
    // designed around. Target-side log rows from scenarios 3 and 5 also
    // need direct cleanup (their users weren't deleted by the endpoints
    // under test). Scenario 4's target user is already gone -- only its
    // now-orphaned log row remains, caught by the same LIKE query below.
    try {
      const remaining = await pool.query("SELECT id, email FROM users WHERE email = ANY($1)", [createdEmails]);
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
```

- [ ] **Step 4: Run it**

With the dev server already running (`npm run dev` in another terminal):

Run: `node scripts/verify-admin-panel.mjs`
Expected: `[verify-admin-panel] 12 passed, 0 failed` (6 scenarios, most asserting 2 things each), exit code 0.

- [ ] **Step 5: Full regression check**

Run: `npm run check` then `npm run verify`
Expected: both clean, `npm run verify` still reporting 0 failed.

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-admin-panel.mjs scripts/verify-branch.mjs
git commit -m "test: add standalone admin-panel coverage, extend schema precondition check"
```

---

## Self-Review

**Spec coverage:** every section of `docs/superpowers/specs/2026-09-04-super-admin-panel-design.md` maps to a task — Data model → Task 1, Server → Task 2, Client → Task 3, Testing → Task 4. All five "Decisions" (pending-only delete, audit log, single hardcoded seed, write-only log, no pagination) are reflected in the Global Constraints and enforced in code (route-level 409 check, `db.batch` audit insert, migration's gated one-time seed, no `GET` on `admin_action_log`, plain unpaginated `listAllUsersForAdmin`). All "Out of scope" items are correctly absent from every task.

**Placeholder scan:** no TBD/TODO, no "add appropriate error handling," no "write tests for the above" — every step above has real, complete code or a real runnable command with an expected result.

**Type consistency:** `AdminUserListItem` (server `server/storage.ts` Task 2, client `Admin.tsx` Task 3) match field-for-field (`id`, `email`, `name`, `emailVerified`, `isSuperAdmin`, `createdAt`, `organizations: {organizationId, organizationName, role}[]`) except `createdAt`'s type (`Date` server-side vs `string` client-side, which is correct — it crosses a JSON boundary). `deleteUnverifiedUserById`'s return union (`"deleted" | "not_found" | "already_verified"`) is defined once in Task 2 and consumed with the same three literal strings in the route handler in the same task. `logAdminAction`'s parameter shape is identical between the `IStorage` signature and its one call site (the verify route) in Task 2. `AuthUser.isSuperAdmin` (Task 3 Step 1) is populated by the exact `/api/auth/me`/login response field name added in Task 2 Step 7 — both are `isSuperAdmin`, no naming drift.
