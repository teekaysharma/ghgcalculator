# Platform Super-Admin Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a platform-wide `isSuperAdmin` flag and an internal `/admin` page that lists every account across every tenant (searchable, paginated), letting a super-admin verify a pending registration, delete one, promote another verified account to super-admin, or demote a super-admin back to a normal account (with a required reason) — with every action recorded in a viewable audit log.

**Architecture:** One new boolean column on `users` plus one new `admin_action_log` audit table (with an optional `note` column used by demote), seeded/created by an idempotent migration script. A new `requireSuperAdmin` Express middleware gates six new routes (list/search/paginate, verify, delete, promote, demote, view action log), reusing the existing `verifyUserEmail` storage method and the existing `deleteExpiredUnverifiedRegistrations`-style `db.batch()` pattern for atomic deletes. A new standalone React page (`/admin`, not an `AppShell` section, since it's cross-tenant) consumes those routes with the same `apiRequest`/`useMutation`/`useToast` conventions already used throughout this codebase, plus one deliberate, documented deviation (an object-shaped query key) needed for correct cache invalidation under pagination.

**Tech Stack:** Express + Passport (session auth), Drizzle ORM on `drizzle-orm/neon-http` (Postgres/Neon), React + Vite, wouter routing, TanStack Query, shadcn/ui components. No unit-test framework in this repo — verification is done via `tsc`, manual `curl`/browser checks, and this project's own script-based end-to-end tests (`npm run verify`, plus dedicated standalone scripts for destructive flows).

## Global Constraints

- Delete is scoped to **pending/unverified accounts only**. A verified account can be viewed but never deleted from this panel — attempting it returns `409 { reason: "already_verified" }`.
- Every verify/delete/promote/demote action writes a row to `admin_action_log` (actor, action, target user id, target email, optional note, timestamp). `admin_action_log` **is readable** via `GET /api/admin/action-log` and shown in the panel.
- The **first** super-admin is always seeded by the migration, hardcoded by email (`teekaysharma@googlemail.com`). After that, any super-admin can **promote** another *verified* account to super-admin from the panel, behind a confirmation dialog that states plainly what the grantee gains.
- Any super-admin can **demote** another super-admin back to a normal account, but only with a **required, non-empty note** explaining why (recorded on the audit log row). **A super-admin can never demote themselves** — the route rejects it with `400` unconditionally. This is the one hard guard rail in the feature: it exists specifically so the panel can never be used to drop the platform to zero super-admins. The migration's seed is self-healing (it re-fires whenever the count of current super-admins is truly zero), but that's not a substitute for this guard: a lone super-admin demoting themselves would still leave the platform with zero super-admins until someone noticed and manually re-ran the migration, rather than staying continuously usable.
- Promoting an unverified account is rejected (`400`) — an account that can't log in yet shouldn't be grantable platform-wide access. Demoting an account that isn't currently a super-admin is also rejected (`400`).
- `GET /api/admin/users` supports `?search=&limit=&offset=` (case-insensitive substring match on email or name; default `limit` 25, max 200).
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
- Produces: `User.isSuperAdmin: boolean` (via `users.$inferSelect`, consumed by every later task); `adminActionLog` table (with a nullable `note` column); `AdminActionLog`/`InsertAdminActionLog` types; `adminActionLogActions = ["verify", "delete", "promote", "demote"] as const` union — Task 2 imports `adminActionLog` (the table) and `type AdminActionLog` from `@shared/schema`.

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
  // must never be able to set this. The FIRST super-admin is seeded only
  // via scripts/manual-migration-013.mjs (hardcoded to the project owner's
  // email); any super-admin can promote another verified account, or
  // demote another super-admin (never themselves), from the /admin panel
  // after that. See
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
// Audit log for platform-admin actions (verify/delete/promote/demote from
// the /admin panel) -- this acts across other tenants' data and can grant
// or revoke platform-wide privileges, so every action is recorded and
// readable via GET /api/admin/action-log.
export const adminActionLogActions = ["verify", "delete", "promote", "demote"] as const;
export type AdminActionLogAction = (typeof adminActionLogActions)[number];

export const adminActionLog = pgTable("admin_action_log", {
  id: serial("id").primaryKey(),
  // The admin who performed the action. A real FK (unlike
  // organizationModules.enabledBy below) -- the actor here is always an
  // authenticated super-admin session, never a vendor-script identity.
  actorUserId: integer("actor_user_id").notNull().references(() => users.id),
  action: text("action").notNull(), // "verify" | "delete" | "promote" | "demote"
  // Deliberately NOT a foreign key: the delete action's entire point is
  // removing this row, and a hard FK would either block the delete or
  // depend on ON DELETE SET NULL firing correctly inside a db.batch() --
  // not worth the fragility.
  targetUserId: integer("target_user_id"),
  // Denormalized snapshot so the log row stays legible forever, independent
  // of whether targetUserId still resolves to a live row (it won't, after
  // a delete action).
  targetEmail: text("target_email").notNull(),
  // Free-text justification, required by the demote route (validated
  // there, not at the DB level -- nullable here since verify/delete/promote
  // never send one) so a demotion always carries a recorded reason.
  note: text("note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertAdminActionLogSchema = createInsertSchema(adminActionLog).pick({
  actorUserId: true,
  action: true,
  targetUserId: true,
  targetEmail: true,
  note: true,
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
// owner's own account (hardcoded by email -- this is the only way to
// create the FIRST super-admin; any super-admin can promote a verified
// account, or demote another super-admin (never themselves), from the
// /admin panel after that. See
// docs/superpowers/specs/2026-09-04-super-admin-panel-design.md).
//
// Order, all in one transaction:
//   1. ADD COLUMN IF NOT EXISTS users.is_super_admin boolean (defaults false)
//   2. Seed is_super_admin = true for the owner's account, but ONLY if no
//      super-admins currently exist (COUNT WHERE is_super_admin = true == 0).
//      This self-heals: the seed fires as soon as the account exists and
//      re-runs the script. It's still safe against accidental re-promotion
//      of a deliberately demoted account because the panel forbids self-demote,
//      so at least one super-admin always remains after any panel-based demote
//      action. The count only reaches 0 again via direct DB manipulation
//      (e.g. reset/testing), which is an appropriate case to self-heal on.
//      If no user row exists yet for that email, this is skipped with a
//      clear message rather than failing -- register that account first,
//      then re-run this script.
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

    await addColumnIfMissing(
      client,
      "is_super_admin",
      `ALTER TABLE users ADD COLUMN is_super_admin boolean NOT NULL DEFAULT false`,
    );

    // Gate on zero current super-admins for self-healing seeding. Safe against
    // accidental re-promotion because the panel forbids self-demote, so at
    // least one super-admin always remains after any panel-based demote.
    // The count only reaches 0 via direct DB manipulation (e.g. reset/testing),
    // which is an appropriate case to self-heal on.
    const superAdminCount = await client.query(`SELECT COUNT(*)::int AS count FROM users WHERE is_super_admin = true`);
    if (superAdminCount.rows[0].count === 0) {
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
      skipped.push(`seed super-admin (${superAdminCount.rows[0].count} super-admin(s) already exist, no seed needed)`);
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
        note text,
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
Expected: prints `Applied N step(s)` including `ALTER TABLE users ADD COLUMN is_super_admin` and `CREATE TABLE admin_action_log`. The seed line depends on live DB state — since the gate is "zero current super-admins" (`SELECT COUNT(*) FROM users WHERE is_super_admin = true` is `0`), not "column was just added," it will say `seeded is_super_admin = true for teekaysharma@googlemail.com` whenever that account already exists and no super-admin exists yet, or (if that account doesn't currently exist) `seed super-admin (no user row found for teekaysharma@googlemail.com -- register that account, then re-run this script)`. **If you see the latter**, that's expected and not a failure — register an account with that exact email through the running app's `/register` page at some point before Task 3's manual verification, then re-run this script to seed it (the column-add step will correctly skip on that re-run; only the seed step fires, since it's independently gated on the super-admin count rather than the column's existence — this also means the seed is self-healing: it fires again automatically any time the count drops back to zero, e.g. after a database reset).

- [ ] **Step 6: Verify idempotency**

Run: `node scripts/manual-migration-013.mjs` again.
Expected: `Applied 0 step(s)`, both DDL checks report `Skipped`, and the seed line now reports `seed super-admin (1 super-admin(s) already exist, no seed needed)` — the count gate sees the super-admin seeded in Step 5 and correctly declines to re-run the `UPDATE`.

- [ ] **Step 7: Commit**

```bash
git add shared/schema.ts scripts/manual-migration-013.mjs
git commit -m "feat: add users.is_super_admin and admin_action_log for the platform admin panel"
```

---

### Task 2: Server — middleware, storage, routes

**Files:**
- Create: `server/middleware/admin.ts`
- Modify: `server/storage.ts` (new `AdminUserListItem`/`AdminActionLogEntry` interfaces, 6 new `IStorage` methods + `DbStorage` implementations, import additions)
- Modify: `server/routes.ts` (import `requireSuperAdmin`, 6 new routes, extend `/api/auth/me` and the login success response)

**Interfaces:**
- Consumes: Task 1's `User.isSuperAdmin`, `adminActionLog` table, `type AdminActionLog`.
- Produces:
  - `requireSuperAdmin(req, res, next)` middleware, exported from `server/middleware/admin.ts`.
  - `storage.listAllUsersForAdmin(params: { search?: string; limit: number; offset: number }): Promise<{ users: AdminUserListItem[]; total: number }>`
  - `storage.deleteUnverifiedUserById(userId: number, actorUserId: number): Promise<"deleted" | "not_found" | "already_verified">`
  - `storage.promoteToSuperAdmin(userId: number): Promise<void>`
  - `storage.demoteFromSuperAdmin(userId: number): Promise<void>`
  - `storage.logAdminAction(entry: { actorUserId: number; action: "verify" | "delete" | "promote" | "demote"; targetUserId: number; targetEmail: string; note?: string }): Promise<AdminActionLog>`
  - `storage.listAdminActionLog(): Promise<AdminActionLogEntry[]>`
  - Routes: `GET /api/admin/users?search=&limit=&offset=` → `200 { users: AdminUserListItem[], total: number }`; `POST /api/admin/users/:id/verify` → `200 { user }` / `404`; `DELETE /api/admin/users/:id` → `204` / `404` / `409 { message, reason: "already_verified" }`; `POST /api/admin/users/:id/promote` → `200 { user }` / `404` / `400` (target not verified); `POST /api/admin/users/:id/demote` `{ note }` → `200 { user }` / `400` (missing note, self-demote, or target not currently a super-admin) / `404`; `GET /api/admin/action-log` → `200 { entries: AdminActionLogEntry[] }`.
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

In `server/storage.ts`, the top of the file currently reads (line 1):

```ts
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
```

Change to add `ilike` and `or` (needed for the case-insensitive email/name search):

```ts
import { and, desc, eq, ilike, inArray, lt, or, sql } from "drizzle-orm";
```

Further down, the import block from `"@shared/schema"` currently ends (around line 76):

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

- [ ] **Step 3: Add the `AdminUserListItem`/`AdminActionLogEntry` interfaces and `IStorage` method signatures**

In `server/storage.ts`, immediately before the `// --- IStorage ---` comment block (the comment that starts `// -----------------------------------------------------------------------\n// IStorage`, around line 190), insert:

```ts
// -----------------------------------------------------------------------
// AdminUserListItem / AdminActionLogEntry
//
// Response shapes for the platform-admin panel. organizations is an array
// (not a single object) on AdminUserListItem because the schema itself
// allows a user to belong to more than one organization even though
// nothing in the product creates that today (memberships only enforces
// uniqueness on (userId, organizationId), not on userId alone) -- this is
// the honest shape rather than silently assuming one org per user forever.
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

export interface AdminActionLogEntry {
  id: number;
  actorEmail: string;
  action: "verify" | "delete" | "promote" | "demote";
  targetEmail: string;
  note: string | null;
  createdAt: Date;
}
```

Then, inside the `IStorage` interface, immediately after the existing last method (`getSourceStreamDetailForBoundary(...)`, right before the interface's closing `}`, around line 350-351):

```ts
  getSourceStreamDetailForBoundary(organizationId: number, reportingBoundaryId: number): Promise<SourceStreamDetail[]>;

  // Platform admin (super-admin only, cross-tenant). Like
  // deleteExpiredUnverifiedRegistrations above, these take no
  // organizationId -- a super-admin isn't scoped to one tenant.
  listAllUsersForAdmin(params: { search?: string; limit: number; offset: number }): Promise<{ users: AdminUserListItem[]; total: number }>;
  deleteUnverifiedUserById(userId: number, actorUserId: number): Promise<"deleted" | "not_found" | "already_verified">;
  promoteToSuperAdmin(userId: number): Promise<void>;
  demoteFromSuperAdmin(userId: number): Promise<void>;
  logAdminAction(entry: {
    actorUserId: number;
    action: "verify" | "delete" | "promote" | "demote";
    targetUserId: number;
    targetEmail: string;
    note?: string;
  }): Promise<AdminActionLog>;
  listAdminActionLog(): Promise<AdminActionLogEntry[]>;
}
```

(Only the 7 new lines plus the closing `}` are new — `getSourceStreamDetailForBoundary`'s own line is shown for placement context, don't duplicate it.)

- [ ] **Step 4: Implement the six methods on `DbStorage`**

In `server/storage.ts`, `DbStorage`'s last method is `getSourceStreamDetailForBoundary`, ending right before the class's closing `}` (around line 1490-1491):

```ts
      };
    });
  }
}

export const storage = new DbStorage();
```

Insert the six new methods between the end of `getSourceStreamDetailForBoundary`'s body and the class's closing `}`:

```ts
      };
    });
  }

  async listAllUsersForAdmin(params: {
    search?: string;
    limit: number;
    offset: number;
  }): Promise<{ users: AdminUserListItem[]; total: number }> {
    const { search, limit, offset } = params;
    const searchFilter = search ? or(ilike(users.email, `%${search}%`), ilike(users.name, `%${search}%`)) : undefined;

    const totalRes = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(searchFilter);
    const total = totalRes[0]?.count ?? 0;

    const pageUsers = await db
      .select()
      .from(users)
      .where(searchFilter)
      .orderBy(desc(users.createdAt))
      .limit(limit)
      .offset(offset);

    const userIds = pageUsers.map((u) => u.id);
    const pageMemberships =
      userIds.length > 0
        ? await db
            .select({
              userId: memberships.userId,
              organizationId: memberships.organizationId,
              role: memberships.role,
              organizationName: organizations.name,
            })
            .from(memberships)
            .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
            .where(inArray(memberships.userId, userIds))
        : [];

    const orgsByUserId = new Map<number, { organizationId: number; organizationName: string; role: string }[]>();
    for (const m of pageMemberships) {
      const list = orgsByUserId.get(m.userId) ?? [];
      list.push({ organizationId: m.organizationId, organizationName: m.organizationName, role: m.role });
      orgsByUserId.set(m.userId, list);
    }

    return {
      users: pageUsers.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        emailVerified: u.emailVerified,
        isSuperAdmin: u.isSuperAdmin,
        createdAt: u.createdAt,
        organizations: orgsByUserId.get(u.id) ?? [],
      })),
      total,
    };
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

  async promoteToSuperAdmin(userId: number): Promise<void> {
    await db.update(users).set({ isSuperAdmin: true }).where(eq(users.id, userId));
  }

  async demoteFromSuperAdmin(userId: number): Promise<void> {
    await db.update(users).set({ isSuperAdmin: false }).where(eq(users.id, userId));
  }

  async logAdminAction(entry: {
    actorUserId: number;
    action: "verify" | "delete" | "promote" | "demote";
    targetUserId: number;
    targetEmail: string;
    note?: string;
  }): Promise<AdminActionLog> {
    const [row] = await db.insert(adminActionLog).values(entry).returning();
    return row;
  }

  async listAdminActionLog(): Promise<AdminActionLogEntry[]> {
    return db
      .select({
        id: adminActionLog.id,
        actorEmail: users.email,
        action: adminActionLog.action,
        targetEmail: adminActionLog.targetEmail,
        note: adminActionLog.note,
        createdAt: adminActionLog.createdAt,
      })
      .from(adminActionLog)
      .innerJoin(users, eq(users.id, adminActionLog.actorUserId))
      .orderBy(desc(adminActionLog.createdAt))
      .limit(200) as Promise<AdminActionLogEntry[]>;
  }
}

export const storage = new DbStorage();
```

(Note `verifyUserEmail` is **not** touched — it already exists at `server/storage.ts:389-394` and is reused unmodified by the route in the next step. The `as Promise<AdminActionLogEntry[]>` cast on `listAdminActionLog` is needed because drizzle infers `action`'s type as the column's declared `text` — i.e. plain `string` — rather than the narrower `"verify" | "delete" | "promote" | "demote"` literal union; every other typed-union column in this codebase, e.g. `memberships.role`, has the same widened-string inference and this project doesn't work around it elsewhere, so match that precedent rather than introducing a runtime validator for one field.)

- [ ] **Step 5: Type-check**

Run: `npm run check`
Expected: clean. If it isn't, the most likely cause is a missed import (`ilike`/`or` from drizzle-orm, or `adminActionLog`/`type AdminActionLog` from `@shared/schema`, both from Step 2) — fix before continuing.

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

- [ ] **Step 8: Add the six admin routes**

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
  // Self-demote is rejected unconditionally so the panel can never drop the
  // platform to zero super-admins.
  // -----------------------------------------------------------------------
  app.get("/api/admin/users", requireAuth, requireSuperAdmin, async (req, res) => {
    const search = typeof req.query.search === "string" ? req.query.search.trim() : undefined;
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 25;
    const rawOffset = Number(req.query.offset);
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
    const result = await storage.listAllUsersForAdmin({ search: search || undefined, limit, offset });
    return res.json(result);
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

  app.post("/api/admin/users/:id/promote", requireAuth, requireSuperAdmin, async (req, res) => {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({ message: "Invalid user id" });
    }
    const target = await storage.getUser(targetId);
    if (!target) return res.status(404).json({ message: "User not found" });
    if (!target.emailVerified) {
      return res.status(400).json({ message: "Account must be verified before it can be promoted to super-admin." });
    }
    await storage.promoteToSuperAdmin(target.id);
    try {
      await storage.logAdminAction({
        actorUserId: (req.user as { id: number }).id,
        action: "promote",
        targetUserId: target.id,
        targetEmail: target.email,
      });
    } catch (err) {
      console.error("Failed to write admin action log (promote):", err);
    }
    return res.status(200).json({ user: { id: target.id, email: target.email, name: target.name, isSuperAdmin: true } });
  });

  app.post("/api/admin/users/:id/demote", requireAuth, requireSuperAdmin, async (req, res) => {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({ message: "Invalid user id" });
    }
    const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
    if (!note) {
      return res.status(400).json({ message: "A reason is required to demote an account." });
    }
    const actorId = (req.user as { id: number }).id;
    if (targetId === actorId) {
      // The one hard guard rail in this feature: without it, the last
      // remaining super-admin could demote themselves and lock the
      // platform out of this panel entirely. The migration's seed is
      // self-healing (it re-fires whenever the count is truly zero), but
      // that's not a substitute for this guard: a lone super-admin
      // demoting themselves would still leave the platform with zero
      // super-admins until someone notices and manually intervenes (or
      // waits for/triggers a migration re-run) rather than the platform
      // staying continuously usable.
      return res.status(400).json({ message: "You cannot demote yourself." });
    }
    const target = await storage.getUser(targetId);
    if (!target) return res.status(404).json({ message: "User not found" });
    if (!target.isSuperAdmin) {
      return res.status(400).json({ message: "Account is not a super-admin." });
    }
    await storage.demoteFromSuperAdmin(target.id);
    try {
      await storage.logAdminAction({
        actorUserId: actorId,
        action: "demote",
        targetUserId: target.id,
        targetEmail: target.email,
        note,
      });
    } catch (err) {
      console.error("Failed to write admin action log (demote):", err);
    }
    return res.status(200).json({ user: { id: target.id, email: target.email, name: target.name, isSuperAdmin: false } });
  });

  app.get("/api/admin/action-log", requireAuth, requireSuperAdmin, async (_req, res) => {
    const entries = await storage.listAdminActionLog();
    return res.json({ entries });
  });

```

- [ ] **Step 9: Type-check**

Run: `npm run check`
Expected: clean.

- [ ] **Step 10: Manual verification against the running server**

Start the dev server in one terminal: `npm run dev`

In another terminal, register + verify + promote a scratch admin user, then exercise all six routes:

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
curl -s -b /tmp/admincookie.txt "http://localhost:5000/api/admin/users?limit=5"
```
Expected: `{"users":[...],"total":N}` including an entry for `plantest-admin@example.invalid`.

```bash
curl -s -b /tmp/admincookie.txt "http://localhost:5000/api/admin/users?search=plantest-admin"
```
Expected: `total` is exactly `1`, and that one result is `plantest-admin@example.invalid` — confirms search actually filters.

Register a second scratch user (leave unverified), then:

```bash
curl -s -b /tmp/admincookie.txt -X POST http://localhost:5000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"plantest-pending@example.invalid","password":"PlanTest12345","organizationName":"plantest-pending"}'
```

Find its id from a `GET /api/admin/users?search=plantest-pending` call, then:

```bash
curl -s -b /tmp/admincookie.txt -X POST http://localhost:5000/api/admin/users/<id>/verify
```
Expected: `{"user":{...,"emailVerified":true}}`.

```bash
curl -s -b /tmp/admincookie.txt -X POST http://localhost:5000/api/admin/users/<id>/promote
```
Expected: `{"user":{...,"isSuperAdmin":true}}` — this account was just verified above, so promotion should succeed.

```bash
curl -s -b /tmp/admincookie.txt -X POST http://localhost:5000/api/admin/users/<id>/demote -i
```
(no body) Expected: `HTTP 400`, message about a required reason — confirms the missing-note rejection.

```bash
curl -s -b /tmp/admincookie.txt -X POST http://localhost:5000/api/admin/users/<id>/demote \
  -H "Content-Type: application/json" \
  -d '{"note":"Testing the demote flow"}'
```
Expected: `{"user":{...,"isSuperAdmin":false}}`.

```bash
curl -s -b /tmp/admincookie.txt -X POST http://localhost:5000/api/admin/users/<plantest-admin's own id>/demote \
  -H "Content-Type: application/json" \
  -d '{"note":"Trying to demote myself"}' -i
```
Expected: `HTTP 400`, message says the caller cannot demote themselves — confirms the self-demote guard.

Register a third scratch user (leave unverified) and try to promote it directly:

```bash
curl -s -b /tmp/admincookie.txt -X POST http://localhost:5000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"plantest-unverified@example.invalid","password":"PlanTest12345","organizationName":"plantest-unverified"}'
```
Find its id, then:
```bash
curl -s -b /tmp/admincookie.txt -X POST http://localhost:5000/api/admin/users/<id>/promote -i
```
Expected: `HTTP 400`, body mentions the account must be verified first — confirms the unverified-promote rejection.

```bash
curl -s -b /tmp/admincookie.txt -X DELETE http://localhost:5000/api/admin/users/<plantest-admin's own id>
```
Expected: `HTTP 409` body `{"message":"Cannot delete a verified account from this panel.","reason":"already_verified"}` (the admin account itself is verified, so this proves the pending-only delete scope).

```bash
curl -s -b /tmp/admincookie.txt http://localhost:5000/api/admin/action-log
```
Expected: `{"entries":[...]}` including a `"verify"` entry, a `"promote"` entry, and a `"demote"` entry with `note` equal to `"Testing the demote flow"` — confirms the note round-trips through the read endpoint.

Clean up manually afterward:
```bash
node -e '
const { Pool } = require("pg");
require("dotenv").config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const emails = ["plantest-admin@example.invalid", "plantest-pending@example.invalid", "plantest-unverified@example.invalid"];
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
git commit -m "feat: add platform admin routes (list/search, verify, delete, promote, demote, action log)"
```

---

### Task 3: Client — admin page, nav link, route

**Files:**
- Modify: `client/src/hooks/use-auth.tsx:5-9` (add `isSuperAdmin` to `AuthUser`)
- Create: `client/src/pages/Admin.tsx`
- Modify: `client/src/pages/Home.tsx` (nav link)
- Modify: `client/src/App.tsx` (import + route)

**Interfaces:**
- Consumes: Task 2's route contracts (`GET /api/admin/users`, `POST /api/admin/users/:id/verify`, `DELETE /api/admin/users/:id`, `POST /api/admin/users/:id/promote`, `POST /api/admin/users/:id/demote`, `GET /api/admin/action-log`) and the extended `/api/auth/me` shape (`user.isSuperAdmin`).
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
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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

interface AdminActionLogEntry {
  id: number;
  actorEmail: string;
  action: "verify" | "delete" | "promote" | "demote";
  targetEmail: string;
  note: string | null;
  createdAt: string;
}

const PAGE_SIZE = 25;

export default function Admin() {
  const { user, isLoading } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [offset, setOffset] = useState(0);
  // Per-row draft text for the demote reason, keyed by user id -- each
  // row's AlertDialog is a separate mounted instance, so this needs to be
  // keyed rather than a single shared string.
  const [demoteNotes, setDemoteNotes] = useState<Record<number, string>>({});

  // Auth-only gating is handled by ProtectedRoute (App.tsx). This is the
  // extra, super-admin-only gate: redirect a logged-in but non-admin user
  // straight back to the app, same loading/redirect shape as
  // ProtectedRoute itself.
  useEffect(() => {
    if (!isLoading && user && !user.isSuperAdmin) {
      setLocation("/");
    }
  }, [isLoading, user, setLocation]);

  // Debounce the search box, and reset back to the first page whenever the
  // (debounced) search term actually changes.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search);
      setOffset(0);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  // Object-shaped query key (not the usual "queryKey[0] is the literal
  // fetch URL" convention used everywhere else in this app) so that
  // invalidateQueries({ queryKey: ["/api/admin/users"] }) below still
  // matches every search/page variant via TanStack Query's array-prefix
  // matching -- a single string key baking the querystring in would not
  // match on invalidation.
  const usersQuery = useQuery<{ users: AdminUserListItem[]; total: number }>({
    queryKey: ["/api/admin/users", { search: debouncedSearch, offset }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(offset));
      const res = await fetch(`/api/admin/users?${params.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return res.json();
    },
    enabled: !!user?.isSuperAdmin,
  });

  const actionLogQuery = useQuery<{ entries: AdminActionLogEntry[] }>({
    queryKey: ["/api/admin/action-log"],
    enabled: !!user?.isSuperAdmin,
  });

  function invalidateAll() {
    queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
    queryClient.invalidateQueries({ queryKey: ["/api/admin/action-log"] });
  }

  const verify = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/admin/users/${id}/verify`);
      return res.json();
    },
    onSuccess: () => {
      invalidateAll();
      toast({ title: "Account verified" });
    },
    onError: (err) => toast({ title: "Could not verify account", description: err.message, variant: "destructive" }),
  });

  const deleteUser = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/admin/users/${id}`);
    },
    onSuccess: () => {
      invalidateAll();
      toast({ title: "Registration deleted" });
    },
    onError: (err) => toast({ title: "Could not delete registration", description: err.message, variant: "destructive" }),
  });

  const promote = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/admin/users/${id}/promote`);
      return res.json();
    },
    onSuccess: () => {
      invalidateAll();
      toast({ title: "Promoted to super-admin" });
    },
    onError: (err) => toast({ title: "Could not promote account", description: err.message, variant: "destructive" }),
  });

  const demote = useMutation({
    mutationFn: async ({ id, note }: { id: number; note: string }) => {
      const res = await apiRequest("POST", `/api/admin/users/${id}/demote`, { note });
      return res.json();
    },
    onSuccess: (_data, { id }) => {
      invalidateAll();
      setDemoteNotes((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      toast({ title: "Super-admin access removed" });
    },
    onError: (err) => toast({ title: "Could not demote account", description: err.message, variant: "destructive" }),
  });

  if (isLoading || !user?.isSuperAdmin) return null;

  const rows = usersQuery.data?.users ?? [];
  const total = usersQuery.data?.total ?? 0;
  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + PAGE_SIZE, total);
  const entries = actionLogQuery.data?.entries ?? [];

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
              Verify or delete a pending registration, promote a verified account to super-admin, or demote one.
            </CardDescription>
            <Input
              placeholder="Search by email or name..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="max-w-xs mt-2"
            />
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
                    const isSelf = u.id === user.id;
                    return (
                      <TableRow key={u.id}>
                        <TableCell>{u.email}</TableCell>
                        <TableCell>{u.name ?? "-"}</TableCell>
                        <TableCell>
                          {!u.emailVerified ? (
                            <Badge variant="outline">Pending</Badge>
                          ) : u.isSuperAdmin ? (
                            <Badge variant="default">Super Admin</Badge>
                          ) : (
                            <Badge variant="secondary">Verified</Badge>
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
                          {u.emailVerified && !u.isSuperAdmin && (
                            <div className="flex justify-end">
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button variant="ghost" size="sm">
                                    Promote to super-admin
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>Promote {u.email} to super-admin?</AlertDialogTitle>
                                    <AlertDialogDescription>
                                      This grants full access to every account and organization on the platform,
                                      including the ability to verify, delete, promote, and demote other accounts.
                                      This is a significant privilege grant with no built-in way to undo it from this
                                      panel.
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction onClick={() => promote.mutate(u.id)}>
                                      Promote
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            </div>
                          )}
                          {u.emailVerified && u.isSuperAdmin && !isSelf && (
                            <div className="flex justify-end">
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button variant="ghost" size="sm" className="text-destructive">
                                    Demote
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>Demote {u.email}?</AlertDialogTitle>
                                    <AlertDialogDescription>
                                      This removes {u.email}'s super-admin access. A reason is required and is
                                      recorded in the activity log below.
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <div className="py-2 space-y-2">
                                    <Label htmlFor={`demote-note-${u.id}`}>Reason for demotion</Label>
                                    <Textarea
                                      id={`demote-note-${u.id}`}
                                      value={demoteNotes[u.id] ?? ""}
                                      onChange={(e) =>
                                        setDemoteNotes((prev) => ({ ...prev, [u.id]: e.target.value }))
                                      }
                                      placeholder="Why is this account being demoted?"
                                    />
                                  </div>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction
                                      disabled={!demoteNotes[u.id]?.trim()}
                                      onClick={() => demote.mutate({ id: u.id, note: demoteNotes[u.id]!.trim() })}
                                    >
                                      Demote
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            </div>
                          )}
                          {u.emailVerified && u.isSuperAdmin && isSelf && (
                            <p className="text-xs text-neutral-400 text-right">(you)</p>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
            {total > 0 && (
              <div className="flex items-center justify-between mt-4">
                <p className="text-sm text-neutral-500">
                  Showing {rangeStart}–{rangeEnd} of {total}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                    disabled={offset === 0}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setOffset(offset + PAGE_SIZE)}
                    disabled={offset + PAGE_SIZE >= total}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-base">Recent activity</CardTitle>
            <CardDescription>The most recent admin actions across the platform.</CardDescription>
          </CardHeader>
          <CardContent>
            {actionLogQuery.isLoading && <div className="text-sm text-neutral-500">Loading...</div>}
            {!actionLogQuery.isLoading && entries.length === 0 && (
              <p className="text-sm text-neutral-500">No admin actions recorded yet.</p>
            )}
            {entries.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Actor</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Note</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell>{e.actorEmail}</TableCell>
                      <TableCell className="capitalize">{e.action}</TableCell>
                      <TableCell>{e.targetEmail}</TableCell>
                      <TableCell>{e.note ?? "—"}</TableCell>
                      <TableCell>{new Date(e.createdAt).toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
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
2. Click it, or navigate to `/admin` directly. Confirm the accounts table loads and includes your own row with a "Super Admin" badge and `(you)` in the actions cell instead of a Demote button, and the "Recent activity" card renders below it (empty is fine at this point).
3. Type a search term matching no existing account into the search box. Confirm the table shows "No accounts found." Clear it and confirm the full list returns.
4. Register a second, throwaway account from a private/incognito window (or log out and back in as the admin after). Back on `/admin`, confirm the new pending account appears with a "Pending" badge and both "Verify" and "Delete" buttons.
5. Click "Verify" on it. Confirm its badge flips to "Verified" (not yet "Super Admin"), its action buttons change to a single "Promote to super-admin" button, and a new "verify" row appears in "Recent activity" without a page reload.
6. Click "Promote to super-admin" on that same row. Confirm the `AlertDialog` shows the privilege-grant warning text, confirm cancelling leaves it unpromoted, then confirm on a second attempt. Confirm its badge flips to "Super Admin", its action button changes to "Demote", and a new "promote" row appears in "Recent activity".
7. Click "Demote" on that row. Confirm the confirm button stays disabled until you type something into the reason textarea, confirm cancelling leaves it a super-admin, then type a reason and confirm. Confirm its badge flips back to "Verified", its action button reverts to "Promote to super-admin", and a new "demote" row appears in "Recent activity" showing the reason you typed in the Note column.
8. Register a third throwaway account, click "Delete" on its row, confirm the `AlertDialog` appears, confirm cancelling leaves the row in place, then confirm on a second attempt. Confirm the row disappears from the list and a "delete" row appears in "Recent activity".
9. If you have more than 25 accounts in the database (unlikely on a fresh dev DB — skip this check if the account list fits on one page), confirm "Previous"/"Next" move between pages and the "Showing X–Y of Z" label updates correctly.
10. Log out, log in as a non-admin account. Confirm no "Admin" link appears, and confirm navigating to `/admin` directly redirects back to `/`.

- [ ] **Step 7: Commit**

```bash
git add client/src/hooks/use-auth.tsx client/src/pages/Admin.tsx client/src/pages/Home.tsx client/src/App.tsx
git commit -m "feat: add /admin page (search, pagination, verify/delete/promote/demote, activity log)"
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
```

- [ ] **Step 4: Run it**

With the dev server already running (`npm run dev` in another terminal):

Run: `node scripts/verify-admin-panel.mjs`
Expected: `[verify-admin-panel] 29 passed, 0 failed` (15 scenarios, most asserting 1-2 things each), exit code 0.

- [ ] **Step 5: Full regression check**

Run: `npm run check` then `npm run verify`
Expected: both clean, `npm run verify` still reporting 0 failed.

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-admin-panel.mjs scripts/verify-branch.mjs
git commit -m "test: add standalone admin-panel coverage (incl. promote/demote), extend schema precondition check"
```

---

## Self-Review

**Spec coverage:** every section of the revised `docs/superpowers/specs/2026-09-04-super-admin-panel-design.md` maps to a task — Data model → Task 1, Server → Task 2, Client → Task 3, Testing → Task 4. All five "Decisions" (pending-only delete, readable audit log with a note field, in-panel promotion with a confirmation warning, in-panel demotion requiring a note, search/pagination) are reflected in the Global Constraints and enforced in code (route-level 409 check, `db.batch` audit insert for delete + standalone `logAdminAction` for verify/promote/demote, the promote route's `emailVerified` precondition, the demote route's note/self/is-super-admin preconditions in that order, the `AlertDialog` warning copy naming exactly what a grantee gains and what a demotion requires, `ilike`-based search + `limit`/`offset` pagination with a `total` count). All "Out of scope" items (deleting a verified tenant, self-serve creation of the *first* super-admin, self-demote) are correctly absent or explicitly blocked in every task.

**Placeholder scan:** no TBD/TODO, no "add appropriate error handling," no "write tests for the above" — every step above has real, complete code or a real runnable command with an expected result.

**Type consistency:** `AdminUserListItem` (server `server/storage.ts` Task 2, client `Admin.tsx` Task 3) match field-for-field except `createdAt`'s type (`Date` server-side vs `string` client-side, correct — it crosses a JSON boundary). `AdminActionLogEntry` likewise matches field-for-field between Task 2's storage interface and Task 3's client interface, including `note: string | null` and the `action: "verify" | "delete" | "promote" | "demote"` union staying consistent across Task 1's `adminActionLogActions`, Task 2's `logAdminAction`/`listAdminActionLog`, and Task 3's rendering. `listAllUsersForAdmin`'s `{ search?, limit, offset }` parameter and `{ users, total }` return shape are defined once in Task 2 Step 3 and used identically in Step 4's implementation, Step 8's route, and Task 3's `queryFn`. `deleteUnverifiedUserById`'s return union, `promoteToSuperAdmin`'s signature, and `demoteFromSuperAdmin`'s signature are each defined once and consumed with matching signatures at their one call site. The demote route's three-step precondition order (note present → not self → target exists → target is a super-admin) matches exactly between Task 2's route code and Task 4's scenario 7/8/9 tests, which each isolate one precondition at a time. `AuthUser.isSuperAdmin` (Task 3 Step 1) is populated by the exact `/api/auth/me`/login response field name added in Task 2 Step 7 — both are `isSuperAdmin`, no naming drift.
