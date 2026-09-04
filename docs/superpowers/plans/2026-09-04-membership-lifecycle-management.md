# Membership & Account Lifecycle Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reversible, auditable access control on top of the platform super-admin panel — per-membership and per-account active/inactive, org-admin self-service scoped to their own tenant, and a unified password-reset token mechanism (self-service forgot-password, admin-triggered reset, and email-change) that never requires an admin to type or share a password.

**Architecture:** Two new boolean columns (`memberships.isActive`, `users.isActive`) plus a password-reset token pair on `users` (mirroring the existing email-verification token exactly), applied by one idempotent migration. `requireOrg` starts filtering to active memberships only. Two parallel route namespaces reuse the same underlying storage methods: `/api/admin/...` (super-admin, unrestricted) and a new `/api/team/...` tier (org-admin, scoped to their own tenant, with a boundary rule for account-wide actions). A shared password-reset flow (`server/email.ts`'s `sendPasswordResetEmail`, mirroring `sendVerificationEmail`) backs self-service forgot-password, admin-triggered reset, and email-change alike.

**Tech Stack:** Express + Passport (session auth), Drizzle ORM on `drizzle-orm/neon-http` (Postgres/Neon), React + Vite, wouter routing, TanStack Query, shadcn/ui components. No unit-test framework in this repo — verification is via `tsc`, manual `curl`/browser checks, and this project's script-based end-to-end tests.

## Global Constraints

- Membership deactivation takes effect on the target's very next request — `requireOrg` resolves membership fresh every time, no caching, no session invalidation needed.
- **Deactivating an account requires the target already be verified** (`400` otherwise — deactivating a pending registration isn't meaningful; delete covers that case). Reactivating, changing email, and admin-triggered reset don't carry that precondition.
- **Every action that revokes or changes access requires a non-empty note**, logged: deactivate-membership, deactivate-account, change-email, admin-triggered reset-password. Reactivation (membership or account) does not require one.
- **Org-admin authority**: membership-level actions (deactivate/activate) are unrestricted within their own org — a membership can never affect another tenant. **Account-wide actions** (deactivate/reactivate account, change email, admin-reset-password) are restricted to targets whose **only** membership (active or not) is in the org-admin's own tenant — `403` otherwise, only a super-admin can act.
- **No admin ever types or knows a user's password.** Change-email and admin-triggered reset-password both generate a password-reset token and email a link — the same token mechanism self-service forgot-password uses. `POST /api/auth/reset-password` marks `emailVerified = true` on success (a no-op if already true) — this is what lets one endpoint serve both a plain password reset and an email-change's combined verify-and-set-password step, with no separate verification email needed for email-change.
- `admin_action_log`'s `organizationId`/`organizationName` are **not** a foreign key (same rationale as `targetUserId`) — null for a cross-tenant super-admin action, set for an org-scoped action.
- All schema changes go through a hand-written idempotent migration script, never `drizzle-kit push` — see `MIGRATIONS.md`.
- Forgot-password only issues a token for a **verified** account, and always returns the same generic response regardless of outcome (matches the existing `resend-verification-email` anti-enumeration convention), rate-limited.
- `db.batch([...])`, never `db.transaction()`, for any multi-statement atomic write (unchanged constraint from prior work — most new mutations here are single-row updates and don't need it).

---

### Task 1: Schema & migration

**Files:**
- Modify: `shared/schema.ts` (`memberships` table, `users` table, `adminActionLog` table + `adminActionLogActions`)
- Create: `scripts/manual-migration-014.mjs`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `Membership.isActive: boolean`, `User.isActive: boolean`, `User.passwordResetToken: string | null`, `User.passwordResetTokenExpiresAt: Date | null`, `AdminActionLog.organizationId: number | null`, `AdminActionLog.organizationName: string | null`, `adminActionLogActions` extended to include `"deactivate_membership" | "activate_membership" | "deactivate_user" | "activate_user" | "change_email" | "reset_password"`.

- [ ] **Step 1: Add `isActive` to `memberships`**

In `shared/schema.ts`, the `memberships` table currently reads:

```ts
export const memberships = pgTable(
  "memberships",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    userOrgUnique: unique("memberships_user_org_unique").on(table.userId, table.organizationId),
    orgIdx: index("memberships_org_idx").on(table.organizationId),
  }),
);
```

Change to:

```ts
export const memberships = pgTable(
  "memberships",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    // Access-lifecycle flag (2026-09-04): requireOrg (server/middleware/tenant.ts)
    // only resolves active memberships -- deactivating one revokes that org's
    // access on the user's very next request, without touching their account
    // or any other membership. See
    // docs/superpowers/specs/2026-09-04-membership-lifecycle-management-design.md.
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    userOrgUnique: unique("memberships_user_org_unique").on(table.userId, table.organizationId),
    orgIdx: index("memberships_org_idx").on(table.organizationId),
  }),
);
```

- [ ] **Step 2: Add `isActive` and password-reset token columns to `users`**

In `shared/schema.ts`, the `users` table currently ends:

```ts
  isSuperAdmin: boolean("is_super_admin").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

Change to:

```ts
  isSuperAdmin: boolean("is_super_admin").notNull().default(false),
  // Account-lifecycle flag (2026-09-04), independent of any single
  // organization -- blocks login entirely regardless of which orgs the
  // account belongs to. Orthogonal to emailVerified: unverified+active is
  // the normal pending state; verified+inactive is a suspended account.
  // Reversible. See
  // docs/superpowers/specs/2026-09-04-membership-lifecycle-management-design.md.
  isActive: boolean("is_active").notNull().default(true),
  // Mirrors emailVerificationToken/emailVerificationTokenExpiresAt exactly:
  // random token, an expiry, cleared on successful use. Backs self-service
  // forgot-password, admin-triggered password reset, and email-change (which
  // reuses this same token instead of an admin ever typing a password).
  passwordResetToken: text("password_reset_token"),
  passwordResetTokenExpiresAt: timestamp("password_reset_token_expires_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

(`insertUserSchema`'s `.pick()` list is unchanged — none of these new fields belong there; self-serve registration can't set any of them.)

- [ ] **Step 3: Extend `admin_action_log`**

In `shared/schema.ts`, the block currently reads:

```ts
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
```

Change to:

```ts
export const adminActionLogActions = [
  "verify",
  "delete",
  "promote",
  "demote",
  "deactivate_membership",
  "activate_membership",
  "deactivate_user",
  "activate_user",
  "change_email",
  "reset_password",
] as const;
export type AdminActionLogAction = (typeof adminActionLogActions)[number];

export const adminActionLog = pgTable("admin_action_log", {
  id: serial("id").primaryKey(),
  // The admin who performed the action. A real FK (unlike
  // organizationModules.enabledBy below) -- the actor here is always an
  // authenticated super-admin or org-admin session, never a vendor-script
  // identity.
  actorUserId: integer("actor_user_id").notNull().references(() => users.id),
  action: text("action").notNull(),
  // Deliberately NOT a foreign key: the delete action's entire point is
  // removing this row, and a hard FK would either block the delete or
  // depend on ON DELETE SET NULL firing correctly inside a db.batch() --
  // not worth the fragility.
  targetUserId: integer("target_user_id"),
  // Denormalized snapshot so the log row stays legible forever, independent
  // of whether targetUserId still resolves to a live row (it won't, after
  // a delete action).
  targetEmail: text("target_email").notNull(),
  // Set for an org-scoped action (deactivate/activate a membership, or an
  // account-wide action an org-admin performed within their own tenant);
  // null for a cross-tenant super-admin action. Also not a foreign key, for
  // the same reason as targetUserId -- a denormalized reference that must
  // survive whatever it points to changing later, not a constraint. Lets
  // GET /api/team/action-log filter to "my org's rows" while the
  // super-admin's GET /api/admin/action-log keeps seeing everything.
  organizationId: integer("organization_id"),
  organizationName: text("organization_name"),
  // Free-text justification. Required (validated at the route, not the DB
  // level) for deactivate-membership, deactivate-user, change-email, and
  // admin-triggered reset-password; optional for the rest.
  note: text("note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertAdminActionLogSchema = createInsertSchema(adminActionLog).pick({
  actorUserId: true,
  action: true,
  targetUserId: true,
  targetEmail: true,
  organizationId: true,
  organizationName: true,
  note: true,
});
```

(`InsertAdminActionLog`/`AdminActionLog` type exports immediately below are unchanged — they're inferred from the table/schema above.)

- [ ] **Step 4: Type-check**

Run: `npm run check`
Expected: clean.

- [ ] **Step 5: Create the migration script**

Create `scripts/manual-migration-014.mjs`, following `scripts/manual-migration-013.mjs`'s exact structure (idempotent `information_schema` checks, one transaction, `applied`/`skipped` tracking):

```js
// scripts/manual-migration-014.mjs
//
// Membership & account lifecycle management: adds is_active to memberships
// and users, adds password_reset_token/password_reset_token_expires_at to
// users, and adds organization_id/organization_name to admin_action_log
// (plus widening its action column's allowed values at the app level only --
// action stays a plain text column, same convention as memberships.role).
// See docs/superpowers/specs/2026-09-04-membership-lifecycle-management-design.md.
//
// All existing rows default to is_active = true (DB-level DEFAULT true on
// the ADD COLUMN), so nothing that currently has access loses it when this
// runs -- there is no backfill step needed, unlike migration 012's
// grandfather backfill.
//
// Idempotent like every other migration in this project: checks
// information_schema before any DDL change, safe to re-run.
//
// Usage: node scripts/manual-migration-014.mjs

import "dotenv/config";
import { Pool } from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL not set. Run this from the project folder with .env filled in.");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const applied = [];
const skipped = [];

async function addColumnIfMissing(client, tableName, columnName, ddl) {
  const res = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [tableName, columnName],
  );
  if (res.rowCount > 0) {
    skipped.push(`${tableName}.${columnName} (already exists)`);
    return false;
  }
  await client.query(ddl);
  applied.push(`ALTER TABLE ${tableName} ADD COLUMN ${columnName}`);
  return true;
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await addColumnIfMissing(
      client,
      "memberships",
      "is_active",
      `ALTER TABLE memberships ADD COLUMN is_active boolean NOT NULL DEFAULT true`,
    );
    await addColumnIfMissing(
      client,
      "users",
      "is_active",
      `ALTER TABLE users ADD COLUMN is_active boolean NOT NULL DEFAULT true`,
    );
    await addColumnIfMissing(
      client,
      "users",
      "password_reset_token",
      `ALTER TABLE users ADD COLUMN password_reset_token text`,
    );
    await addColumnIfMissing(
      client,
      "users",
      "password_reset_token_expires_at",
      `ALTER TABLE users ADD COLUMN password_reset_token_expires_at timestamp`,
    );
    await addColumnIfMissing(
      client,
      "admin_action_log",
      "organization_id",
      `ALTER TABLE admin_action_log ADD COLUMN organization_id integer`,
    );
    await addColumnIfMissing(
      client,
      "admin_action_log",
      "organization_name",
      `ALTER TABLE admin_action_log ADD COLUMN organization_name text`,
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

- [ ] **Step 6: Run the migration**

Run: `node scripts/manual-migration-014.mjs`
Expected: `Applied 6 step(s)`, one line per new column.

- [ ] **Step 7: Verify idempotency**

Run: `node scripts/manual-migration-014.mjs` again.
Expected: `Applied 0 step(s)`, all 6 checks report `Skipped`.

- [ ] **Step 8: Commit**

```bash
git add shared/schema.ts scripts/manual-migration-014.mjs
git commit -m "feat: add membership/account isActive, password-reset tokens, and audit-log org scoping"
```

---

### Task 2: Server — password-reset foundation, login/requireOrg changes

**Files:**
- Modify: `server/email.ts` (new `sendPasswordResetEmail` sibling function)
- Modify: `server/storage.ts` (new storage methods, `getActiveMembershipsForUser`, `isUsersSoleOrganization`)
- Modify: `server/auth.ts` (login rejects a deactivated account)
- Modify: `server/middleware/tenant.ts` (`requireOrg` resolves active memberships only)
- Modify: `server/routes.ts` (new `POST /api/auth/forgot-password`, `POST /api/auth/reset-password`)

**Interfaces:**
- Consumes: Task 1's `User.isActive`, `User.passwordResetToken`/`passwordResetTokenExpiresAt`, `Membership.isActive`.
- Produces:
  - `sendPasswordResetEmail(params: { to: string; token: string; requestOrigin: string }): Promise<void>`, exported from `server/email.ts`.
  - `storage.getUserByPasswordResetToken(token: string): Promise<User | undefined>`
  - `storage.setPasswordResetToken(userId: number, token: string, expiresAt: Date): Promise<void>`
  - `storage.resetPassword(userId: number, passwordHash: string): Promise<void>` — sets the new hash, clears both password-reset token fields, sets `emailVerified: true`.
  - `storage.getActiveMembershipsForUser(userId: number): Promise<Membership[]>` — used by `requireOrg` going forward; the existing `getMembershipsForUser` (all memberships, active or not) is unchanged and still used by `/api/auth/me` and elsewhere.
  - `storage.isUsersSoleOrganization(userId: number, organizationId: number): Promise<boolean>` — true only if the user's memberships (all of them, active or not — a deactivated membership still represents a relationship with that org) resolve to exactly one organization, and it's this one. Used by Task 6's org-admin boundary rule.
  - Routes: `POST /api/auth/forgot-password` `{ email }` → `200` generic response always; `POST /api/auth/reset-password` `{ token, newPassword }` → `200` / `400` (invalid/expired token).

- [ ] **Step 1: Add `sendPasswordResetEmail` to `server/email.ts`**

`server/email.ts` currently reads in full:

```ts
import { Resend } from "resend";

// Verification emails only. If this app ever needs other transactional
// email (password reset, invites), add a sibling function here rather than
// overloading this one -- see the file-level pattern in server/vite.ts /
// server/vite-dev.ts for why this project prefers one clear responsibility
// per file over a growing grab-bag module.

if (!process.env.RESEND_API_KEY) {
  throw new Error(
    "RESEND_API_KEY is not set. Sign up at resend.com, create an API key, and set it as RESEND_API_KEY in your .env file (see .env.example).",
  );
}
const resend = new Resend(process.env.RESEND_API_KEY);

const FROM_ADDRESS = process.env.EMAIL_FROM || "onboarding@resend.dev";

export async function sendVerificationEmail(params: {
  to: string;
  token: string;
  requestOrigin: string;
}): Promise<void> {
  const { to, token, requestOrigin } = params;
  const verifyUrl = `${requestOrigin}/verify-email?token=${encodeURIComponent(token)}&email=${encodeURIComponent(to)}`;

  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to,
    subject: "Verify your email — GHG Emissions Calculator",
    html: `
      <p>Thanks for signing up for the GHG Emissions Calculator.</p>
      <p><a href="${verifyUrl}">Click here to verify your email address</a>.</p>
      <p>This link expires in 24 hours. If you don't verify by then, this registration will be automatically removed and you'll need to sign up again.</p>
      <p>If you didn't create this account, you can safely ignore this email.</p>
    `,
  });

  if (error) {
    throw new Error(`Resend failed to send verification email: ${error.message}`);
  }
}
```

Change the file-level comment (it explicitly says to add a sibling here) and add the new function at the end:

```ts
import { Resend } from "resend";

// Verification and password-reset emails. If this app ever needs other
// transactional email (invites), add another sibling function here rather
// than overloading either of these -- see the file-level pattern in
// server/vite.ts / server/vite-dev.ts for why this project prefers one
// clear responsibility per file over a growing grab-bag module.

if (!process.env.RESEND_API_KEY) {
  throw new Error(
    "RESEND_API_KEY is not set. Sign up at resend.com, create an API key, and set it as RESEND_API_KEY in your .env file (see .env.example).",
  );
}
const resend = new Resend(process.env.RESEND_API_KEY);

const FROM_ADDRESS = process.env.EMAIL_FROM || "onboarding@resend.dev";

export async function sendVerificationEmail(params: {
  to: string;
  token: string;
  requestOrigin: string;
}): Promise<void> {
  const { to, token, requestOrigin } = params;
  const verifyUrl = `${requestOrigin}/verify-email?token=${encodeURIComponent(token)}&email=${encodeURIComponent(to)}`;

  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to,
    subject: "Verify your email — GHG Emissions Calculator",
    html: `
      <p>Thanks for signing up for the GHG Emissions Calculator.</p>
      <p><a href="${verifyUrl}">Click here to verify your email address</a>.</p>
      <p>This link expires in 24 hours. If you don't verify by then, this registration will be automatically removed and you'll need to sign up again.</p>
      <p>If you didn't create this account, you can safely ignore this email.</p>
    `,
  });

  if (error) {
    throw new Error(`Resend failed to send verification email: ${error.message}`);
  }
}

// Used for self-service "forgot password", admin-triggered password reset,
// and email-change (which reuses this same token instead of an admin ever
// typing or sharing a password -- see
// docs/superpowers/specs/2026-09-04-membership-lifecycle-management-design.md).
// POST /api/auth/reset-password also marks the account verified on success,
// so this one email/link does double duty for the email-change case.
export async function sendPasswordResetEmail(params: {
  to: string;
  token: string;
  requestOrigin: string;
}): Promise<void> {
  const { to, token, requestOrigin } = params;
  const resetUrl = `${requestOrigin}/reset-password?token=${encodeURIComponent(token)}&email=${encodeURIComponent(to)}`;

  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to,
    subject: "Reset your password — GHG Emissions Calculator",
    html: `
      <p>Use the link below to set a new password for your GHG Emissions Calculator account.</p>
      <p><a href="${resetUrl}">Click here to set a new password</a>.</p>
      <p>This link expires in 24 hours.</p>
      <p>If you didn't request this, you can safely ignore this email -- your password won't change unless you click the link and set a new one.</p>
    `,
  });

  if (error) {
    throw new Error(`Resend failed to send password reset email: ${error.message}`);
  }
}
```

- [ ] **Step 2: Add storage imports and methods**

In `server/storage.ts`, the `drizzle-orm` import (line 1) already includes `and, desc, eq, ilike, inArray, lt, ne, or, sql` — no change needed there.

Immediately after `verifyUserEmail`/before `setEmailVerificationToken` is unaffected; instead, add the new methods right after the existing `getUserByEmail` implementation. Find:

```ts
  async getUserByEmail(email: string): Promise<User | undefined> {
    const [row] = await db.select().from(users).where(eq(users.email, email));
    return row;
  }
```

Insert immediately after it:

```ts
  async getUserByEmail(email: string): Promise<User | undefined> {
    const [row] = await db.select().from(users).where(eq(users.email, email));
    return row;
  }

  async getUserByPasswordResetToken(token: string): Promise<User | undefined> {
    const [row] = await db.select().from(users).where(eq(users.passwordResetToken, token));
    return row;
  }

  async setPasswordResetToken(userId: number, token: string, expiresAt: Date): Promise<void> {
    await db
      .update(users)
      .set({ passwordResetToken: token, passwordResetTokenExpiresAt: expiresAt })
      .where(eq(users.id, userId));
  }

  async resetPassword(userId: number, passwordHash: string): Promise<void> {
    await db
      .update(users)
      .set({
        passwordHash,
        passwordResetToken: null,
        passwordResetTokenExpiresAt: null,
        emailVerified: true,
      })
      .where(eq(users.id, userId));
  }
```

Then find `getMembershipsForUser` and `getMembership`:

```ts
  async getMembershipsForUser(userId: number): Promise<Membership[]> {
    return db.select().from(memberships).where(eq(memberships.userId, userId));
  }

  async getMembership(userId: number, organizationId: number): Promise<Membership | undefined> {
```

Insert a new method between them:

```ts
  async getMembershipsForUser(userId: number): Promise<Membership[]> {
    return db.select().from(memberships).where(eq(memberships.userId, userId));
  }

  // Used by requireOrg going forward -- an inactive membership must be
  // invisible to tenant-access resolution. getMembershipsForUser above
  // (all memberships, active or not) is unchanged and still used by
  // /api/auth/me and the sole-organization boundary check below, which both
  // need to see a deactivated membership, not just active ones.
  async getActiveMembershipsForUser(userId: number): Promise<Membership[]> {
    return db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.isActive, true)));
  }

  async getMembership(userId: number, organizationId: number): Promise<Membership | undefined> {
```

Then, immediately after `getEnabledModuleKeys` (which ends just before `listMembershipsForOrganization`), add the boundary-rule helper. Find:

```ts
  async getEnabledModuleKeys(organizationId: number): Promise<string[]> {
    const rows = await db
      .select({ moduleKey: organizationModules.moduleKey })
      .from(organizationModules)
      .where(eq(organizationModules.organizationId, organizationId));
    const grantedKeys = rows.map((r) => r.moduleKey).filter(isKnownModuleKey);
    const alwaysEnabledKeys = Object.entries(MODULE_REGISTRY)
      .filter(([, def]) => def.alwaysEnabled)
      .map(([key]) => key);
    return Array.from(new Set([...alwaysEnabledKeys, ...grantedKeys]));
  }

  async listMembershipsForOrganization(
```

Insert between them:

```ts
  async getEnabledModuleKeys(organizationId: number): Promise<string[]> {
    const rows = await db
      .select({ moduleKey: organizationModules.moduleKey })
      .from(organizationModules)
      .where(eq(organizationModules.organizationId, organizationId));
    const grantedKeys = rows.map((r) => r.moduleKey).filter(isKnownModuleKey);
    const alwaysEnabledKeys = Object.entries(MODULE_REGISTRY)
      .filter(([, def]) => def.alwaysEnabled)
      .map(([key]) => key);
    return Array.from(new Set([...alwaysEnabledKeys, ...grantedKeys]));
  }

  // Boundary rule for org-admin account-wide actions (deactivate/reactivate
  // an account, change its email, admin-trigger a password reset): an
  // org-admin may only act if the target's memberships -- ALL of them,
  // active or not, since even a deactivated membership represents a
  // relationship with that org the acting org-admin has no authority over
  // -- resolve to exactly this one organization. Membership-level actions
  // (deactivate/activate one membership) don't need this check; they can
  // never affect another tenant by construction.
  async isUsersSoleOrganization(userId: number, organizationId: number): Promise<boolean> {
    const all = await db.select().from(memberships).where(eq(memberships.userId, userId));
    return all.length === 1 && all[0].organizationId === organizationId;
  }

  async listMembershipsForOrganization(
```

- [ ] **Step 3: Update `IStorage`**

Add the five new method signatures to the `IStorage` interface. Find the existing `// Users (identity, not tenant-scoped)` block:

```ts
  // Users (identity, not tenant-scoped)
  createUser(user: InsertUser): Promise<User>;
  getUser(id: number): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUserByVerificationToken(token: string): Promise<User | undefined>;
  verifyUserEmail(userId: number): Promise<void>;
  setEmailVerificationToken(userId: number, token: string, expiresAt: Date): Promise<void>;
  deleteExpiredUnverifiedRegistrations(): Promise<number>;

  // Memberships (the tenant-scoping join)
  createMembership(membership: InsertMembership): Promise<Membership>;
  getMembershipsForUser(userId: number): Promise<Membership[]>;
  getMembership(userId: number, organizationId: number): Promise<Membership | undefined>;
  listMembershipsForOrganization(organizationId: number): Promise<(Membership & { userEmail: string; userName: string | null })[]>;
  getEnabledModuleKeys(organizationId: number): Promise<string[]>;
```

Change to:

```ts
  // Users (identity, not tenant-scoped)
  createUser(user: InsertUser): Promise<User>;
  getUser(id: number): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUserByVerificationToken(token: string): Promise<User | undefined>;
  getUserByPasswordResetToken(token: string): Promise<User | undefined>;
  verifyUserEmail(userId: number): Promise<void>;
  setEmailVerificationToken(userId: number, token: string, expiresAt: Date): Promise<void>;
  setPasswordResetToken(userId: number, token: string, expiresAt: Date): Promise<void>;
  resetPassword(userId: number, passwordHash: string): Promise<void>;
  deleteExpiredUnverifiedRegistrations(): Promise<number>;

  // Memberships (the tenant-scoping join)
  createMembership(membership: InsertMembership): Promise<Membership>;
  getMembershipsForUser(userId: number): Promise<Membership[]>;
  getActiveMembershipsForUser(userId: number): Promise<Membership[]>;
  getMembership(userId: number, organizationId: number): Promise<Membership | undefined>;
  listMembershipsForOrganization(organizationId: number): Promise<(Membership & { userEmail: string; userName: string | null })[]>;
  getEnabledModuleKeys(organizationId: number): Promise<string[]>;
  isUsersSoleOrganization(userId: number, organizationId: number): Promise<boolean>;
```

- [ ] **Step 4: Type-check**

Run: `npm run check`
Expected: clean.

- [ ] **Step 5: Login rejects a deactivated account**

In `server/auth.ts`, the LocalStrategy currently reads:

```ts
      if (!user.emailVerified) {
        return done(
          null,
          false,
          { message: "Please verify your email before logging in.", reason: "unverified" } as {
            message: string;
            reason: string;
          },
        );
      }
      return done(null, user);
```

Change to:

```ts
      if (!user.emailVerified) {
        return done(
          null,
          false,
          { message: "Please verify your email before logging in.", reason: "unverified" } as {
            message: string;
            reason: string;
          },
        );
      }
      if (!user.isActive) {
        return done(
          null,
          false,
          { message: "This account has been deactivated. Contact your organization admin or support.", reason: "deactivated" } as {
            message: string;
            reason: string;
          },
        );
      }
      return done(null, user);
```

- [ ] **Step 6: `requireOrg` resolves active memberships only**

In `server/middleware/tenant.ts`, `requireOrg` currently reads:

```ts
    const requestedOrgId = req.header("X-Organization-Id");
    const memberships = await storage.getMembershipsForUser(user.id);

    if (memberships.length === 0) {
```

Change to:

```ts
    const requestedOrgId = req.header("X-Organization-Id");
    const memberships = await storage.getActiveMembershipsForUser(user.id);

    if (memberships.length === 0) {
```

- [ ] **Step 7: Type-check**

Run: `npm run check`
Expected: clean.

- [ ] **Step 8: Add the self-service routes**

In `server/routes.ts`, the import line currently reads:

```ts
import { sendVerificationEmail } from "./email";
```

Change to:

```ts
import { sendVerificationEmail, sendPasswordResetEmail } from "./email";
```

Immediately after the existing `resendVerificationLimiter` declaration (around where `POST /api/auth/verify-email` is defined) and before `app.get("/api/cron/cleanup-unverified-users", ...)`, add a new limiter and the two routes. Find:

```ts
  app.post("/api/auth/resend-verification-email", resendVerificationLimiter, async (req, res) => {
    const parsed = z.object({ email: z.string().email() }).safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid input" });
    }
    const genericResponse = { message: "If that email has a pending registration, we've sent a new link." };
    const user = await storage.getUserByEmail(parsed.data.email);
    if (!user || user.emailVerified) {
      return res.status(200).json(genericResponse);
    }
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await storage.setEmailVerificationToken(user.id, token, expiresAt);
    try {
      await sendVerificationEmail({
        to: user.email,
        token,
        requestOrigin: `${req.protocol}://${req.get("host")}`,
      });
    } catch (emailError) {
      console.error("Failed to send verification email (resend):", emailError);
    }
    return res.status(200).json(genericResponse);
  });

  app.get("/api/cron/cleanup-unverified-users", async (req, res) => {
```

Insert the new limiter and routes between them:

```ts
  app.post("/api/auth/resend-verification-email", resendVerificationLimiter, async (req, res) => {
    const parsed = z.object({ email: z.string().email() }).safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid input" });
    }
    const genericResponse = { message: "If that email has a pending registration, we've sent a new link." };
    const user = await storage.getUserByEmail(parsed.data.email);
    if (!user || user.emailVerified) {
      return res.status(200).json(genericResponse);
    }
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await storage.setEmailVerificationToken(user.id, token, expiresAt);
    try {
      await sendVerificationEmail({
        to: user.email,
        token,
        requestOrigin: `${req.protocol}://${req.get("host")}`,
      });
    } catch (emailError) {
      console.error("Failed to send verification email (resend):", emailError);
    }
    return res.status(200).json(genericResponse);
  });

  const forgotPasswordLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many requests, try again later." },
  });

  app.post("/api/auth/forgot-password", forgotPasswordLimiter, async (req, res) => {
    const parsed = z.object({ email: z.string().email() }).safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid input" });
    }
    const genericResponse = { message: "If that account exists, we've sent a password reset link." };
    const user = await storage.getUserByEmail(parsed.data.email);
    // Only issue a token for a verified account -- an unverified
    // registration should use resend-verification-email instead, and this
    // generic response never reveals which case applied.
    if (!user || !user.emailVerified) {
      return res.status(200).json(genericResponse);
    }
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await storage.setPasswordResetToken(user.id, token, expiresAt);
    try {
      await sendPasswordResetEmail({
        to: user.email,
        token,
        requestOrigin: `${req.protocol}://${req.get("host")}`,
      });
    } catch (emailError) {
      console.error("Failed to send password reset email:", emailError);
    }
    return res.status(200).json(genericResponse);
  });

  app.post("/api/auth/reset-password", async (req, res) => {
    const parsed = z
      .object({ token: z.string().min(1), newPassword: z.string().min(8) })
      .safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid input" });
    }
    const user = await storage.getUserByPasswordResetToken(parsed.data.token);
    if (!user || !user.passwordResetTokenExpiresAt || user.passwordResetTokenExpiresAt < new Date()) {
      return res.status(400).json({ message: "This password reset link is invalid or has expired." });
    }
    const passwordHash = await hashPassword(parsed.data.newPassword);
    await storage.resetPassword(user.id, passwordHash);
    return res.status(200).json({ message: "Password updated. You can now log in." });
  });

  app.get("/api/cron/cleanup-unverified-users", async (req, res) => {
```

- [ ] **Step 9: Type-check**

Run: `npm run check`
Expected: clean.

- [ ] **Step 10: Manual verification against the running server**

Start the dev server: `npm run dev`

Register and verify a scratch user (reuse the pattern from earlier verification passes), then:

```bash
curl -s -X POST http://localhost:5000/api/auth/forgot-password \
  -H "Content-Type: application/json" \
  -d '{"email":"plantest-reset@example.invalid"}'
```
Expected: `{"message":"If that account exists, we've sent a password reset link."}` regardless of whether the account exists — try it once with a real verified test email and once with `nobody@example.invalid`, confirm identical response shape both times.

Pull the token directly from the DB (same `pg.Pool` pattern used throughout this project's test scripts):
```bash
node -e '
const { Pool } = require("pg");
require("dotenv").config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query("SELECT password_reset_token FROM users WHERE email = $1", ["plantest-reset@example.invalid"])
  .then(r => { console.log(r.rows[0]?.password_reset_token); return pool.end(); });
'
```

```bash
curl -s -X POST http://localhost:5000/api/auth/reset-password \
  -H "Content-Type: application/json" \
  -d '{"token":"<paste token>","newPassword":"NewPassw0rd123"}'
```
Expected: `200`, then confirm login with the OLD password now fails and login with the NEW password succeeds.

Also confirm a deactivated account (temporarily flip `is_active = false` via a direct SQL `UPDATE` on a scratch test user) is rejected at login with `reason: "deactivated"`, then flip it back and confirm login succeeds again.

- [ ] **Step 11: Commit**

```bash
git add server/email.ts server/storage.ts server/auth.ts server/middleware/tenant.ts server/routes.ts
git commit -m "feat: add self-service password reset, deactivated-account login rejection, active-membership filtering"
```

---

### Task 3: Client — self-service password reset pages

**Files:**
- Create: `client/src/pages/ForgotPassword.tsx`
- Create: `client/src/pages/ResetPassword.tsx`
- Modify: `client/src/pages/Login.tsx` (forgot-password link, `reason: "deactivated"` handling)
- Modify: `client/src/App.tsx` (two new routes)

**Interfaces:**
- Consumes: Task 2's `POST /api/auth/forgot-password`, `POST /api/auth/reset-password`.
- Produces: `/forgot-password` and `/reset-password` pages.

- [ ] **Step 1: Create the forgot-password page**

Create `client/src/pages/ForgotPassword.tsx`:

```tsx
import { useState } from "react";
import { Link } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import AuthLayout from "@/components/auth/AuthLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { apiRequest } from "@/lib/queryClient";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const forgotPassword = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/auth/forgot-password", { email });
    },
    onSuccess: () => setSubmitted(true),
  });

  if (submitted) {
    return (
      <AuthLayout heading="Check your email" subheading="If that account exists, a reset link is on its way.">
        <div className="space-y-4">
          <div className="flex items-center gap-3 text-neutral-700">
            <CheckCircle2 className="h-8 w-8 text-primary shrink-0" />
            <p>We've sent a password reset link to {email} — check your inbox (and spam folder).</p>
          </div>
          <p className="text-sm text-neutral-600 text-center">
            <Link href="/login" className="text-primary font-medium hover:underline">
              Back to log in
            </Link>
          </p>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout heading="Forgot your password?" subheading="Enter your email and we'll send you a reset link.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          forgotPassword.mutate();
        }}
        className="space-y-4"
      >
        {forgotPassword.isError && (
          <Alert variant="destructive">
            <AlertDescription>Something went wrong — try again.</AlertDescription>
          </Alert>
        )}
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <Button type="submit" className="w-full" disabled={forgotPassword.isPending || !email}>
          {forgotPassword.isPending ? "Sending..." : "Send reset link"}
        </Button>
      </form>
      <p className="text-sm text-neutral-600 mt-6 text-center">
        <Link href="/login" className="text-primary font-medium hover:underline">
          Back to log in
        </Link>
      </p>
    </AuthLayout>
  );
}
```

- [ ] **Step 2: Create the reset-password page**

Create `client/src/pages/ResetPassword.tsx`:

```tsx
import { useState } from "react";
import { Link, useSearchParams } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import AuthLayout from "@/components/auth/AuthLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { apiRequest } from "@/lib/queryClient";

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [newPassword, setNewPassword] = useState("");

  const resetPassword = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/auth/reset-password", { token, newPassword });
    },
  });

  if (!token) {
    return (
      <AuthLayout heading="Invalid link" subheading="This password reset link is missing its token.">
        <p className="text-sm text-neutral-600 text-center">
          <Link href="/forgot-password" className="text-primary font-medium hover:underline">
            Request a new link
          </Link>
        </p>
      </AuthLayout>
    );
  }

  if (resetPassword.isSuccess) {
    return (
      <AuthLayout heading="Password updated" subheading="You're all set.">
        <div className="space-y-4">
          <div className="flex items-center gap-3 text-neutral-700">
            <CheckCircle2 className="h-8 w-8 text-primary shrink-0" />
            <p>Your password has been updated — you can log in now.</p>
          </div>
          <Button asChild className="w-full">
            <Link href="/login">Log in</Link>
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout heading="Set a new password" subheading="Choose a new password for your account.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          resetPassword.mutate();
        }}
        className="space-y-4"
      >
        {resetPassword.isError && (
          <Alert variant="destructive">
            <AlertDescription>
              {(resetPassword.error as Error)?.message || "This link is invalid or has expired."}
            </AlertDescription>
          </Alert>
        )}
        <div className="space-y-2">
          <Label htmlFor="newPassword">New password</Label>
          <Input
            id="newPassword"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            minLength={8}
            required
          />
        </div>
        <Button type="submit" className="w-full" disabled={resetPassword.isPending || newPassword.length < 8}>
          {resetPassword.isPending ? "Updating..." : "Set new password"}
        </Button>
      </form>
    </AuthLayout>
  );
}
```

- [ ] **Step 3: Add the forgot-password link and deactivated-account handling to Login.tsx**

In `client/src/pages/Login.tsx`, the state declarations currently read:

```tsx
  const [error, setError] = useState<string | null>(null);
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent">("idle");
```

Change to:

```tsx
  const [error, setError] = useState<string | null>(null);
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent">("idle");
  const [deactivated, setDeactivated] = useState(false);
```

The `onSubmit` handler currently reads:

```tsx
  const onSubmit = async (values: LoginFormValues) => {
    setError(null);
    setUnverifiedEmail(null);
    try {
      await login(values);
      setLocation("/");
    } catch (err) {
      const reason = (err as Error & { reason?: string }).reason;
      if (reason === "unverified") {
        setUnverifiedEmail(values.email);
      } else {
        setError(err instanceof Error ? err.message : "Failed to log in");
      }
    }
  };
```

Change to:

```tsx
  const onSubmit = async (values: LoginFormValues) => {
    setError(null);
    setUnverifiedEmail(null);
    setDeactivated(false);
    try {
      await login(values);
      setLocation("/");
    } catch (err) {
      const reason = (err as Error & { reason?: string }).reason;
      if (reason === "unverified") {
        setUnverifiedEmail(values.email);
      } else if (reason === "deactivated") {
        setDeactivated(true);
      } else {
        setError(err instanceof Error ? err.message : "Failed to log in");
      }
    }
  };
```

The form's alert block currently reads:

```tsx
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {unverifiedEmail && (
```

Change to:

```tsx
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {deactivated && (
          <Alert variant="destructive">
            <AlertDescription>
              This account has been deactivated. Contact your organization admin or support if you believe this is a mistake.
            </AlertDescription>
          </Alert>
        )}
        {unverifiedEmail && (
```

Finally, the "Don't have an account?" line at the bottom currently reads:

```tsx
      <p className="text-sm text-neutral-600 mt-6 text-center">
        Don't have an account?{" "}
        <Link href="/register" className="text-primary font-medium hover:underline">
          Create one
        </Link>
      </p>
```

Change to:

```tsx
      <p className="text-sm text-neutral-600 text-center mt-4">
        <Link href="/forgot-password" className="text-primary font-medium hover:underline">
          Forgot your password?
        </Link>
      </p>
      <p className="text-sm text-neutral-600 mt-2 text-center">
        Don't have an account?{" "}
        <Link href="/register" className="text-primary font-medium hover:underline">
          Create one
        </Link>
      </p>
```

- [ ] **Step 4: Register the new routes**

In `client/src/App.tsx`, the imports currently read:

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

Change to:

```tsx
import { Switch, Route } from "wouter";
import NotFound from "@/pages/not-found";
import Home from "@/pages/Home";
import Login from "@/pages/Login";
import Register from "@/pages/Register";
import VerifyEmail from "@/pages/VerifyEmail";
import ForgotPassword from "@/pages/ForgotPassword";
import ResetPassword from "@/pages/ResetPassword";
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
      <Route path="/forgot-password" component={ForgotPassword} />
      <Route path="/reset-password" component={ResetPassword} />
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

With the dev server running: visit `/login`, confirm a "Forgot your password?" link appears. Click it, submit a verified test account's email, confirm the "Check your email" state. Pull the real token from the DB (same pattern as Task 2's manual check), visit `/reset-password?token=<token>`, set a new password, confirm the success state and that logging in with the new password works. Visit `/reset-password` with no token, confirm the "Invalid link" state. Temporarily deactivate a test account via direct SQL, attempt login, confirm the deactivated-account message renders (not the unverified one), then reactivate it and confirm login works again.

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/ForgotPassword.tsx client/src/pages/ResetPassword.tsx client/src/pages/Login.tsx client/src/App.tsx
git commit -m "feat: add self-service forgot-password/reset-password pages"
```

---

### Task 4: Server — super-admin membership & account lifecycle routes

**Files:**
- Modify: `server/storage.ts` (new methods; extend `AdminUserListItem`, `listAllUsersForAdmin`, `logAdminAction`, `listAdminActionLog`)
- Modify: `server/routes.ts` (6 new routes under `/api/admin/...`)

**Interfaces:**
- Consumes: Task 2's `sendPasswordResetEmail`, `setPasswordResetToken`.
- Produces:
  - `storage.deactivateMembership(membershipId: number, scopedToOrgId?: number): Promise<Membership | undefined>`
  - `storage.activateMembership(membershipId: number, scopedToOrgId?: number): Promise<Membership | undefined>`
  - `storage.deactivateAccount(userId: number): Promise<void>`
  - `storage.reactivateAccount(userId: number): Promise<void>`
  - `storage.setNewEmailPendingVerification(userId: number, newEmail: string, resetToken: string, resetTokenExpiresAt: Date): Promise<void>`
  - `AdminUserListItem` gains `isActive: boolean` (account) and each `organizations[]` entry gains `membershipId: number` and `isActive: boolean`.
  - `logAdminAction`'s `entry.action` union and `AdminActionLogEntry.action` widen to the full `adminActionLogActions` set; both gain optional `organizationId`/`organizationName`.
  - Routes: `POST /api/admin/memberships/:id/deactivate` `{ note }`, `POST /api/admin/memberships/:id/activate`, `POST /api/admin/users/:id/deactivate` `{ note }`, `POST /api/admin/users/:id/reactivate`, `POST /api/admin/users/:id/change-email` `{ newEmail, note }`, `POST /api/admin/users/:id/reset-password` `{ note }`.

- [ ] **Step 1: Extend `AdminUserListItem` and `AdminActionLogEntry`**

In `server/storage.ts`, find:

```ts
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

Change to:

```ts
export interface AdminUserListItem {
  id: number;
  email: string;
  name: string | null;
  emailVerified: boolean;
  isSuperAdmin: boolean;
  isActive: boolean;
  createdAt: Date;
  organizations: { membershipId: number; organizationId: number; organizationName: string; role: string; isActive: boolean }[];
}

export interface AdminActionLogEntry {
  id: number;
  actorEmail: string;
  action:
    | "verify"
    | "delete"
    | "promote"
    | "demote"
    | "deactivate_membership"
    | "activate_membership"
    | "deactivate_user"
    | "activate_user"
    | "change_email"
    | "reset_password";
  targetEmail: string;
  organizationName: string | null;
  note: string | null;
  createdAt: Date;
}
```

- [ ] **Step 2: Update `listAllUsersForAdmin` to surface `isActive`**

In `server/storage.ts`, `listAllUsersForAdmin` currently reads:

```ts
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
```

Change to:

```ts
    const userIds = pageUsers.map((u) => u.id);
    const pageMemberships =
      userIds.length > 0
        ? await db
            .select({
              membershipId: memberships.id,
              userId: memberships.userId,
              organizationId: memberships.organizationId,
              role: memberships.role,
              isActive: memberships.isActive,
              organizationName: organizations.name,
            })
            .from(memberships)
            .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
            .where(inArray(memberships.userId, userIds))
        : [];

    const orgsByUserId = new Map<
      number,
      { membershipId: number; organizationId: number; organizationName: string; role: string; isActive: boolean }[]
    >();
    for (const m of pageMemberships) {
      const list = orgsByUserId.get(m.userId) ?? [];
      list.push({
        membershipId: m.membershipId,
        organizationId: m.organizationId,
        organizationName: m.organizationName,
        role: m.role,
        isActive: m.isActive,
      });
      orgsByUserId.set(m.userId, list);
    }

    return {
      users: pageUsers.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        emailVerified: u.emailVerified,
        isSuperAdmin: u.isSuperAdmin,
        isActive: u.isActive,
        createdAt: u.createdAt,
        organizations: orgsByUserId.get(u.id) ?? [],
      })),
      total,
    };
  }
```

- [ ] **Step 3: Add the six new storage methods**

Immediately after `demoteFromSuperAdmin` and before `logAdminAction`, find:

```ts
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
```

Change to:

```ts
  async demoteFromSuperAdmin(userId: number): Promise<void> {
    await db.update(users).set({ isSuperAdmin: false }).where(eq(users.id, userId));
  }

  async deactivateMembership(membershipId: number, scopedToOrgId?: number): Promise<Membership | undefined> {
    const where = scopedToOrgId
      ? and(eq(memberships.id, membershipId), eq(memberships.organizationId, scopedToOrgId))
      : eq(memberships.id, membershipId);
    const [row] = await db.update(memberships).set({ isActive: false }).where(where).returning();
    return row;
  }

  async activateMembership(membershipId: number, scopedToOrgId?: number): Promise<Membership | undefined> {
    const where = scopedToOrgId
      ? and(eq(memberships.id, membershipId), eq(memberships.organizationId, scopedToOrgId))
      : eq(memberships.id, membershipId);
    const [row] = await db.update(memberships).set({ isActive: true }).where(where).returning();
    return row;
  }

  async deactivateAccount(userId: number): Promise<void> {
    await db.update(users).set({ isActive: false }).where(eq(users.id, userId));
  }

  async reactivateAccount(userId: number): Promise<void> {
    await db.update(users).set({ isActive: true }).where(eq(users.id, userId));
  }

  // Changing email never lets an admin set the account's password. The new
  // occupant proves control of the new inbox and sets their own password
  // via the SAME token-based flow POST /api/auth/reset-password serves for
  // a plain forgot-password reset -- resetTokenExpiresAt/resetToken here are
  // the password-reset token, not a fresh email-verification token; any
  // stale email-verification token is cleared since it no longer applies to
  // the new address.
  async setNewEmailPendingVerification(
    userId: number,
    newEmail: string,
    resetToken: string,
    resetTokenExpiresAt: Date,
  ): Promise<void> {
    await db
      .update(users)
      .set({
        email: newEmail,
        emailVerified: false,
        emailVerificationToken: null,
        emailVerificationTokenExpiresAt: null,
        passwordResetToken: resetToken,
        passwordResetTokenExpiresAt: resetTokenExpiresAt,
      })
      .where(eq(users.id, userId));
  }

  async logAdminAction(entry: {
    actorUserId: number;
    action:
      | "verify"
      | "delete"
      | "promote"
      | "demote"
      | "deactivate_membership"
      | "activate_membership"
      | "deactivate_user"
      | "activate_user"
      | "change_email"
      | "reset_password";
    targetUserId: number;
    targetEmail: string;
    organizationId?: number;
    organizationName?: string;
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
        organizationName: adminActionLog.organizationName,
        note: adminActionLog.note,
        createdAt: adminActionLog.createdAt,
      })
      .from(adminActionLog)
      .innerJoin(users, eq(users.id, adminActionLog.actorUserId))
      .orderBy(desc(adminActionLog.createdAt))
      .limit(200) as Promise<AdminActionLogEntry[]>;
  }
}
```

- [ ] **Step 4: Update `IStorage`**

Find the platform-admin section of the interface:

```ts
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

Change to:

```ts
  // Platform admin (super-admin only, cross-tenant). Like
  // deleteExpiredUnverifiedRegistrations above, these take no
  // organizationId -- a super-admin isn't scoped to one tenant. The
  // membership/account methods below double as the org-admin implementation
  // too (Task 6) via the optional scopedToOrgId parameter.
  listAllUsersForAdmin(params: { search?: string; limit: number; offset: number }): Promise<{ users: AdminUserListItem[]; total: number }>;
  deleteUnverifiedUserById(userId: number, actorUserId: number): Promise<"deleted" | "not_found" | "already_verified">;
  promoteToSuperAdmin(userId: number): Promise<void>;
  demoteFromSuperAdmin(userId: number): Promise<void>;
  deactivateMembership(membershipId: number, scopedToOrgId?: number): Promise<Membership | undefined>;
  activateMembership(membershipId: number, scopedToOrgId?: number): Promise<Membership | undefined>;
  deactivateAccount(userId: number): Promise<void>;
  reactivateAccount(userId: number): Promise<void>;
  setNewEmailPendingVerification(userId: number, newEmail: string, resetToken: string, resetTokenExpiresAt: Date): Promise<void>;
  logAdminAction(entry: {
    actorUserId: number;
    action:
      | "verify"
      | "delete"
      | "promote"
      | "demote"
      | "deactivate_membership"
      | "activate_membership"
      | "deactivate_user"
      | "activate_user"
      | "change_email"
      | "reset_password";
    targetUserId: number;
    targetEmail: string;
    organizationId?: number;
    organizationName?: string;
    note?: string;
  }): Promise<AdminActionLog>;
  listAdminActionLog(): Promise<AdminActionLogEntry[]>;
}
```

- [ ] **Step 5: Type-check**

Run: `npm run check`
Expected: clean.

- [ ] **Step 6: Add the six routes**

In `server/routes.ts`, immediately after the existing `GET /api/admin/action-log` route and before the `// --- Team ---` comment block, find:

```ts
  app.get("/api/admin/action-log", requireAuth, requireSuperAdmin, async (_req, res) => {
    const entries = await storage.listAdminActionLog();
    return res.json({ entries });
  });

  // -----------------------------------------------------------------------
  // Team -- list members of the caller's org, invite an existing user by
```

Insert the six new routes between them:

```ts
  app.get("/api/admin/action-log", requireAuth, requireSuperAdmin, async (_req, res) => {
    const entries = await storage.listAdminActionLog();
    return res.json({ entries });
  });

  app.post("/api/admin/memberships/:id/deactivate", requireAuth, requireSuperAdmin, async (req, res) => {
    const membershipId = Number(req.params.id);
    if (!Number.isInteger(membershipId) || membershipId <= 0) {
      return res.status(400).json({ message: "Invalid membership id" });
    }
    const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
    if (!note) {
      return res.status(400).json({ message: "A reason is required to deactivate a membership." });
    }
    const updated = await storage.deactivateMembership(membershipId);
    if (!updated) return res.status(404).json({ message: "Membership not found" });
    const target = await storage.getUser(updated.userId);
    const org = await storage.getOrganization(updated.organizationId);
    try {
      await storage.logAdminAction({
        actorUserId: (req.user as { id: number }).id,
        action: "deactivate_membership",
        targetUserId: updated.userId,
        targetEmail: target?.email ?? "",
        organizationId: updated.organizationId,
        organizationName: org?.name,
        note,
      });
    } catch (err) {
      console.error("Failed to write admin action log (deactivate_membership):", err);
    }
    return res.status(200).json({ membership: { id: updated.id, isActive: updated.isActive } });
  });

  app.post("/api/admin/memberships/:id/activate", requireAuth, requireSuperAdmin, async (req, res) => {
    const membershipId = Number(req.params.id);
    if (!Number.isInteger(membershipId) || membershipId <= 0) {
      return res.status(400).json({ message: "Invalid membership id" });
    }
    const updated = await storage.activateMembership(membershipId);
    if (!updated) return res.status(404).json({ message: "Membership not found" });
    const target = await storage.getUser(updated.userId);
    const org = await storage.getOrganization(updated.organizationId);
    try {
      await storage.logAdminAction({
        actorUserId: (req.user as { id: number }).id,
        action: "activate_membership",
        targetUserId: updated.userId,
        targetEmail: target?.email ?? "",
        organizationId: updated.organizationId,
        organizationName: org?.name,
      });
    } catch (err) {
      console.error("Failed to write admin action log (activate_membership):", err);
    }
    return res.status(200).json({ membership: { id: updated.id, isActive: updated.isActive } });
  });

  app.post("/api/admin/users/:id/deactivate", requireAuth, requireSuperAdmin, async (req, res) => {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({ message: "Invalid user id" });
    }
    const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
    if (!note) {
      return res.status(400).json({ message: "A reason is required to deactivate an account." });
    }
    const target = await storage.getUser(targetId);
    if (!target) return res.status(404).json({ message: "User not found" });
    if (!target.emailVerified) {
      return res.status(400).json({ message: "This account isn't verified yet. Use delete instead." });
    }
    await storage.deactivateAccount(target.id);
    try {
      await storage.logAdminAction({
        actorUserId: (req.user as { id: number }).id,
        action: "deactivate_user",
        targetUserId: target.id,
        targetEmail: target.email,
        note,
      });
    } catch (err) {
      console.error("Failed to write admin action log (deactivate_user):", err);
    }
    return res.status(200).json({ user: { id: target.id, email: target.email, isActive: false } });
  });

  app.post("/api/admin/users/:id/reactivate", requireAuth, requireSuperAdmin, async (req, res) => {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({ message: "Invalid user id" });
    }
    const target = await storage.getUser(targetId);
    if (!target) return res.status(404).json({ message: "User not found" });
    await storage.reactivateAccount(target.id);
    try {
      await storage.logAdminAction({
        actorUserId: (req.user as { id: number }).id,
        action: "activate_user",
        targetUserId: target.id,
        targetEmail: target.email,
      });
    } catch (err) {
      console.error("Failed to write admin action log (activate_user):", err);
    }
    return res.status(200).json({ user: { id: target.id, email: target.email, isActive: true } });
  });

  app.post("/api/admin/users/:id/change-email", requireAuth, requireSuperAdmin, async (req, res) => {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({ message: "Invalid user id" });
    }
    const parsed = z.object({ newEmail: z.string().email(), note: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "A new email and a reason are both required." });
    }
    const target = await storage.getUser(targetId);
    if (!target) return res.status(404).json({ message: "User not found" });
    const existing = await storage.getUserByEmail(parsed.data.newEmail);
    if (existing && existing.id !== target.id) {
      return res.status(409).json({ message: "An account with this email already exists" });
    }
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await storage.setNewEmailPendingVerification(target.id, parsed.data.newEmail, token, expiresAt);
    try {
      await sendPasswordResetEmail({
        to: parsed.data.newEmail,
        token,
        requestOrigin: `${req.protocol}://${req.get("host")}`,
      });
    } catch (emailError) {
      console.error("Failed to send password reset email (change-email):", emailError);
    }
    try {
      await storage.logAdminAction({
        actorUserId: (req.user as { id: number }).id,
        action: "change_email",
        targetUserId: target.id,
        targetEmail: parsed.data.newEmail,
        note: parsed.data.note,
      });
    } catch (err) {
      console.error("Failed to write admin action log (change_email):", err);
    }
    return res.status(200).json({ user: { id: target.id, email: parsed.data.newEmail } });
  });

  app.post("/api/admin/users/:id/reset-password", requireAuth, requireSuperAdmin, async (req, res) => {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({ message: "Invalid user id" });
    }
    const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
    if (!note) {
      return res.status(400).json({ message: "A reason is required to reset a password." });
    }
    const target = await storage.getUser(targetId);
    if (!target) return res.status(404).json({ message: "User not found" });
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await storage.setPasswordResetToken(target.id, token, expiresAt);
    try {
      await sendPasswordResetEmail({
        to: target.email,
        token,
        requestOrigin: `${req.protocol}://${req.get("host")}`,
      });
    } catch (emailError) {
      console.error("Failed to send password reset email (admin reset-password):", emailError);
    }
    try {
      await storage.logAdminAction({
        actorUserId: (req.user as { id: number }).id,
        action: "reset_password",
        targetUserId: target.id,
        targetEmail: target.email,
        note,
      });
    } catch (err) {
      console.error("Failed to write admin action log (reset_password):", err);
    }
    return res.status(200).json({ message: "Password reset email sent." });
  });

  // -----------------------------------------------------------------------
  // Team -- list members of the caller's org, invite an existing user by
```

- [ ] **Step 7: Type-check**

Run: `npm run check`
Expected: clean.

- [ ] **Step 8: Manual verification against the running server**

With the dev server running and a super-admin session cookie (same technique as prior tasks), exercise each route: deactivate/activate a scratch membership, deactivate a verified scratch account (confirm login now fails with `reason: "deactivated"`) then reactivate it (confirm login works again), change a scratch account's email (confirm the old email no longer resolves, and following the emailed token through `/reset-password` both sets a password AND marks the account verified), and admin-trigger a password reset (confirm the token lets the target log in with a new password). Confirm `GET /api/admin/action-log` shows all six new action types with correct `note`/`organizationName` fields.

- [ ] **Step 9: Commit**

```bash
git add server/storage.ts server/routes.ts
git commit -m "feat: add super-admin membership/account deactivate, reactivate, change-email, reset-password routes"
```

---

### Task 5: Client — Admin.tsx extensions

**Files:**
- Modify: `client/src/pages/Admin.tsx`

**Interfaces:**
- Consumes: Task 4's 6 new routes and extended `AdminUserListItem`/`AdminActionLogEntry` shapes.
- Produces: nothing further consumed by later tasks (Task 6/7 build the parallel org-admin surface independently).

- [ ] **Step 1: Update the local type definitions**

In `client/src/pages/Admin.tsx`, find:

```tsx
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
```

Change to:

```tsx
interface AdminOrgSummary {
  membershipId: number;
  organizationId: number;
  organizationName: string;
  role: string;
  isActive: boolean;
}

interface AdminUserListItem {
  id: number;
  email: string;
  name: string | null;
  emailVerified: boolean;
  isSuperAdmin: boolean;
  isActive: boolean;
  createdAt: string;
  organizations: AdminOrgSummary[];
}

interface AdminActionLogEntry {
  id: number;
  actorEmail: string;
  action:
    | "verify"
    | "delete"
    | "promote"
    | "demote"
    | "deactivate_membership"
    | "activate_membership"
    | "deactivate_user"
    | "activate_user"
    | "change_email"
    | "reset_password";
  targetEmail: string;
  organizationName: string | null;
  note: string | null;
  createdAt: string;
}
```

- [ ] **Step 2: Add state for the new dialogs**

Find:

```tsx
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [offset, setOffset] = useState(0);
  // Per-row draft text for the demote reason, keyed by user id -- each
  // row's AlertDialog is a separate mounted instance, so this needs to be
  // keyed rather than a single shared string.
  const [demoteNotes, setDemoteNotes] = useState<Record<number, string>>({});
```

Change to:

```tsx
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [offset, setOffset] = useState(0);
  // Per-row draft text/state for dialogs that need one, keyed by the row's
  // own id (membership id for membership actions, user id for account
  // actions) -- each row's AlertDialog is a separate mounted instance, so
  // this needs to be keyed rather than a single shared value.
  const [demoteNotes, setDemoteNotes] = useState<Record<number, string>>({});
  const [membershipNotes, setMembershipNotes] = useState<Record<number, string>>({});
  const [deactivateNotes, setDeactivateNotes] = useState<Record<number, string>>({});
  const [resetPasswordNotes, setResetPasswordNotes] = useState<Record<number, string>>({});
  const [changeEmailDrafts, setChangeEmailDrafts] = useState<Record<number, { email: string; note: string }>>({});
```

- [ ] **Step 3: Add the six new mutations**

Immediately after the existing `demote` mutation and before `if (isLoading || !user?.isSuperAdmin) return null;`, find:

```tsx
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
```

Change to:

```tsx
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

  const deactivateMembership = useMutation({
    mutationFn: async ({ membershipId, note }: { membershipId: number; note: string }) => {
      const res = await apiRequest("POST", `/api/admin/memberships/${membershipId}/deactivate`, { note });
      return res.json();
    },
    onSuccess: (_data, { membershipId }) => {
      invalidateAll();
      setMembershipNotes((prev) => {
        const next = { ...prev };
        delete next[membershipId];
        return next;
      });
      toast({ title: "Membership deactivated" });
    },
    onError: (err) => toast({ title: "Could not deactivate membership", description: err.message, variant: "destructive" }),
  });

  const activateMembership = useMutation({
    mutationFn: async (membershipId: number) => {
      const res = await apiRequest("POST", `/api/admin/memberships/${membershipId}/activate`);
      return res.json();
    },
    onSuccess: () => {
      invalidateAll();
      toast({ title: "Membership reactivated" });
    },
    onError: (err) => toast({ title: "Could not reactivate membership", description: err.message, variant: "destructive" }),
  });

  const deactivateAccount = useMutation({
    mutationFn: async ({ id, note }: { id: number; note: string }) => {
      const res = await apiRequest("POST", `/api/admin/users/${id}/deactivate`, { note });
      return res.json();
    },
    onSuccess: (_data, { id }) => {
      invalidateAll();
      setDeactivateNotes((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      toast({ title: "Account deactivated" });
    },
    onError: (err) => toast({ title: "Could not deactivate account", description: err.message, variant: "destructive" }),
  });

  const reactivateAccount = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/admin/users/${id}/reactivate`);
      return res.json();
    },
    onSuccess: () => {
      invalidateAll();
      toast({ title: "Account reactivated" });
    },
    onError: (err) => toast({ title: "Could not reactivate account", description: err.message, variant: "destructive" }),
  });

  const changeEmail = useMutation({
    mutationFn: async ({ id, newEmail, note }: { id: number; newEmail: string; note: string }) => {
      const res = await apiRequest("POST", `/api/admin/users/${id}/change-email`, { newEmail, note });
      return res.json();
    },
    onSuccess: (_data, { id }) => {
      invalidateAll();
      setChangeEmailDrafts((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      toast({ title: "Email changed — a reset link was sent to the new address" });
    },
    onError: (err) => toast({ title: "Could not change email", description: err.message, variant: "destructive" }),
  });

  const resetPassword = useMutation({
    mutationFn: async ({ id, note }: { id: number; note: string }) => {
      const res = await apiRequest("POST", `/api/admin/users/${id}/reset-password`, { note });
      return res.json();
    },
    onSuccess: (_data, { id }) => {
      invalidateAll();
      setResetPasswordNotes((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      toast({ title: "Password reset email sent" });
    },
    onError: (err) => toast({ title: "Could not send password reset", description: err.message, variant: "destructive" }),
  });

  if (isLoading || !user?.isSuperAdmin) return null;
```

- [ ] **Step 4: Expand the membership display and add account-level actions**

Find the `Organization` column cell and the row rendering:

```tsx
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
```

Change to add an `isActive`-aware status badge and expand the organization cell into a per-membership list with a toggle:

```tsx
                  {rows.map((u) => {
                    const isSelf = u.id === user.id;
                    return (
                      <TableRow key={u.id}>
                        <TableCell>{u.email}</TableCell>
                        <TableCell>{u.name ?? "-"}</TableCell>
                        <TableCell>
                          {!u.emailVerified ? (
                            <Badge variant="outline">Pending</Badge>
                          ) : !u.isActive ? (
                            <Badge variant="destructive">Deactivated</Badge>
                          ) : u.isSuperAdmin ? (
                            <Badge variant="default">Super Admin</Badge>
                          ) : (
                            <Badge variant="secondary">Verified</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {u.organizations.length === 0 && "—"}
                          <div className="space-y-1">
                            {u.organizations.map((org) => (
                              <div key={org.membershipId} className="flex items-center gap-2 text-sm">
                                <span>{org.organizationName}</span>
                                <Badge variant={org.isActive ? "secondary" : "outline"} className="capitalize">
                                  {org.role}
                                </Badge>
                                {org.isActive ? (
                                  <AlertDialog>
                                    <AlertDialogTrigger asChild>
                                      <Button variant="ghost" size="sm" className="h-6 px-2 text-xs">
                                        Deactivate
                                      </Button>
                                    </AlertDialogTrigger>
                                    <AlertDialogContent>
                                      <AlertDialogHeader>
                                        <AlertDialogTitle>
                                          Deactivate {u.email}'s access to {org.organizationName}?
                                        </AlertDialogTitle>
                                        <AlertDialogDescription>
                                          This revokes their access to this organization only, not any other org they
                                          belong to. A reason is required.
                                        </AlertDialogDescription>
                                      </AlertDialogHeader>
                                      <div className="py-2 space-y-2">
                                        <Label htmlFor={`membership-note-${org.membershipId}`}>Reason</Label>
                                        <Textarea
                                          id={`membership-note-${org.membershipId}`}
                                          value={membershipNotes[org.membershipId] ?? ""}
                                          onChange={(e) =>
                                            setMembershipNotes((prev) => ({ ...prev, [org.membershipId]: e.target.value }))
                                          }
                                        />
                                      </div>
                                      <AlertDialogFooter>
                                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                                        <AlertDialogAction
                                          disabled={!membershipNotes[org.membershipId]?.trim()}
                                          onClick={() =>
                                            deactivateMembership.mutate({
                                              membershipId: org.membershipId,
                                              note: membershipNotes[org.membershipId]!.trim(),
                                            })
                                          }
                                        >
                                          Deactivate
                                        </AlertDialogAction>
                                      </AlertDialogFooter>
                                    </AlertDialogContent>
                                  </AlertDialog>
                                ) : (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 px-2 text-xs"
                                    onClick={() => activateMembership.mutate(org.membershipId)}
                                    disabled={activateMembership.isPending}
                                  >
                                    Reactivate
                                  </Button>
                                )}
                              </div>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell>{new Date(u.createdAt).toLocaleDateString()}</TableCell>
```

- [ ] **Step 5: Add account-level actions to the actions cell**

Find the closing of the actions `<TableCell>` (the block with Verify/Delete, Promote, Demote, and the `(you)` label):

```tsx
                          {u.emailVerified && u.isSuperAdmin && isSelf && (
                            <p className="text-xs text-neutral-400 text-right">(you)</p>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
```

Change to add a new block for verified, non-self accounts (deactivate/reactivate, change-email, reset-password) right after the existing three action blocks, before the `(you)` label:

```tsx
                          {u.emailVerified && u.isSuperAdmin && isSelf && (
                            <p className="text-xs text-neutral-400 text-right">(you)</p>
                          )}
                          {u.emailVerified && !isSelf && (
                            <div className="flex flex-wrap gap-2 justify-end mt-1">
                              {u.isActive ? (
                                <AlertDialog>
                                  <AlertDialogTrigger asChild>
                                    <Button variant="ghost" size="sm" className="text-destructive">
                                      Deactivate account
                                    </Button>
                                  </AlertDialogTrigger>
                                  <AlertDialogContent>
                                    <AlertDialogHeader>
                                      <AlertDialogTitle>Deactivate {u.email}'s account?</AlertDialogTitle>
                                      <AlertDialogDescription>
                                        This blocks login entirely, regardless of which organizations they belong to.
                                        A reason is required and is recorded in the activity log.
                                      </AlertDialogDescription>
                                    </AlertDialogHeader>
                                    <div className="py-2 space-y-2">
                                      <Label htmlFor={`deactivate-note-${u.id}`}>Reason</Label>
                                      <Textarea
                                        id={`deactivate-note-${u.id}`}
                                        value={deactivateNotes[u.id] ?? ""}
                                        onChange={(e) =>
                                          setDeactivateNotes((prev) => ({ ...prev, [u.id]: e.target.value }))
                                        }
                                      />
                                    </div>
                                    <AlertDialogFooter>
                                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                                      <AlertDialogAction
                                        disabled={!deactivateNotes[u.id]?.trim()}
                                        onClick={() =>
                                          deactivateAccount.mutate({ id: u.id, note: deactivateNotes[u.id]!.trim() })
                                        }
                                      >
                                        Deactivate
                                      </AlertDialogAction>
                                    </AlertDialogFooter>
                                  </AlertDialogContent>
                                </AlertDialog>
                              ) : (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => reactivateAccount.mutate(u.id)}
                                  disabled={reactivateAccount.isPending}
                                >
                                  Reactivate account
                                </Button>
                              )}
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button variant="ghost" size="sm">
                                    Change email
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>Change {u.email}'s email?</AlertDialogTitle>
                                    <AlertDialogDescription>
                                      A password-set link is emailed to the new address — nobody types or shares a
                                      password. The account is re-verified when they use it. A reason is required.
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <div className="py-2 space-y-3">
                                    <div className="space-y-2">
                                      <Label htmlFor={`new-email-${u.id}`}>New email</Label>
                                      <Input
                                        id={`new-email-${u.id}`}
                                        type="email"
                                        value={changeEmailDrafts[u.id]?.email ?? ""}
                                        onChange={(e) =>
                                          setChangeEmailDrafts((prev) => ({
                                            ...prev,
                                            [u.id]: { email: e.target.value, note: prev[u.id]?.note ?? "" },
                                          }))
                                        }
                                      />
                                    </div>
                                    <div className="space-y-2">
                                      <Label htmlFor={`change-email-note-${u.id}`}>Reason</Label>
                                      <Textarea
                                        id={`change-email-note-${u.id}`}
                                        value={changeEmailDrafts[u.id]?.note ?? ""}
                                        onChange={(e) =>
                                          setChangeEmailDrafts((prev) => ({
                                            ...prev,
                                            [u.id]: { email: prev[u.id]?.email ?? "", note: e.target.value },
                                          }))
                                        }
                                      />
                                    </div>
                                  </div>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction
                                      disabled={
                                        !changeEmailDrafts[u.id]?.email?.trim() || !changeEmailDrafts[u.id]?.note?.trim()
                                      }
                                      onClick={() =>
                                        changeEmail.mutate({
                                          id: u.id,
                                          newEmail: changeEmailDrafts[u.id]!.email.trim(),
                                          note: changeEmailDrafts[u.id]!.note.trim(),
                                        })
                                      }
                                    >
                                      Change email
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button variant="ghost" size="sm">
                                    Reset password
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>Send {u.email} a password reset link?</AlertDialogTitle>
                                    <AlertDialogDescription>
                                      Nobody types or sees their new password — they set it themselves via the emailed
                                      link. A reason is required.
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <div className="py-2 space-y-2">
                                    <Label htmlFor={`reset-password-note-${u.id}`}>Reason</Label>
                                    <Textarea
                                      id={`reset-password-note-${u.id}`}
                                      value={resetPasswordNotes[u.id] ?? ""}
                                      onChange={(e) =>
                                        setResetPasswordNotes((prev) => ({ ...prev, [u.id]: e.target.value }))
                                      }
                                    />
                                  </div>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction
                                      disabled={!resetPasswordNotes[u.id]?.trim()}
                                      onClick={() =>
                                        resetPassword.mutate({ id: u.id, note: resetPasswordNotes[u.id]!.trim() })
                                      }
                                    >
                                      Send reset link
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
```

- [ ] **Step 6: Add the Note/Organization columns to the activity log table**

Find:

```tsx
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
```

Change to add an Organization column (blank for cross-tenant actions):

```tsx
                <TableHeader>
                  <TableRow>
                    <TableHead>Actor</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Organization</TableHead>
                    <TableHead>Note</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell>{e.actorEmail}</TableCell>
                      <TableCell className="capitalize">{e.action.replace(/_/g, " ")}</TableCell>
                      <TableCell>{e.targetEmail}</TableCell>
                      <TableCell>{e.organizationName ?? "—"}</TableCell>
                      <TableCell>{e.note ?? "—"}</TableCell>
                      <TableCell>{new Date(e.createdAt).toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
```

- [ ] **Step 7: Type-check**

Run: `npm run check`
Expected: clean.

- [ ] **Step 8: Manual browser verification**

Log in as the seeded super-admin. On `/admin`, confirm every account row now shows its full membership list (not just "first org +N more"), each with a Deactivate/Reactivate control. Deactivate a scratch membership, confirm its badge and control flip, confirm the activity log shows the org name. Deactivate a scratch account entirely, confirm its status badge shows "Deactivated" and confirm that account can no longer log in; reactivate it and confirm login works again. Change a scratch account's email through the dialog, confirm the activity log entry, and confirm the flow from Task 3/4's manual checks (reset-password link both verifies and sets a password) still works end to end from this UI path. Trigger an admin password reset and confirm the email/token flow works.

- [ ] **Step 9: Commit**

```bash
git add client/src/pages/Admin.tsx
git commit -m "feat: add membership/account lifecycle controls to the Admin page"
```

---

### Task 6: Server — org-admin routes (`/api/team/...`)

**Files:**
- Modify: `server/routes.ts` (new `/api/team/...` routes, extend `GET /api/team`)

**Interfaces:**
- Consumes: Task 2's `isUsersSoleOrganization`; Task 4's `deactivateMembership`/`activateMembership`/`deactivateAccount`/`reactivateAccount`/`setNewEmailPendingVerification`/`logAdminAction`.
- Produces: `POST /api/team/memberships/:id/deactivate` `{ note }`, `POST /api/team/memberships/:id/activate`, `POST /api/team/members/:id/deactivate` `{ note }`, `POST /api/team/members/:id/reactivate`, `POST /api/team/members/:id/change-email` `{ newEmail, note }`, `POST /api/team/members/:id/reset-password` `{ note }`, `GET /api/team/action-log`.

- [ ] **Step 1: Extend `GET /api/team` to include `isActive`**

In `server/storage.ts`, `listMembershipsForOrganization` currently reads:

```ts
  async listMembershipsForOrganization(
    organizationId: number,
  ): Promise<(Membership & { userEmail: string; userName: string | null })[]> {
    const rows = await db
      .select({
        id: memberships.id,
        userId: memberships.userId,
        organizationId: memberships.organizationId,
        role: memberships.role,
        createdAt: memberships.createdAt,
        userEmail: users.email,
        userName: users.name,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.organizationId, organizationId))
      .orderBy(desc(memberships.createdAt));
    return rows;
  }
```

Unchanged in signature — `Membership` already includes `isActive` from Task 1's schema change, and `db.select({...})` needs it added explicitly to the projection. Change to:

```ts
  async listMembershipsForOrganization(
    organizationId: number,
  ): Promise<(Membership & { userEmail: string; userName: string | null })[]> {
    const rows = await db
      .select({
        id: memberships.id,
        userId: memberships.userId,
        organizationId: memberships.organizationId,
        role: memberships.role,
        isActive: memberships.isActive,
        createdAt: memberships.createdAt,
        userEmail: users.email,
        userName: users.name,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.organizationId, organizationId))
      .orderBy(desc(memberships.createdAt));
    return rows;
  }
```

In `server/routes.ts`, `GET /api/team` currently reads:

```ts
  app.get("/api/team", requireAuth, requireOrg, async (req, res) => {
    const members = await storage.listMembershipsForOrganization(req.organizationId!);
    return res.json({
      members: members.map((m) => ({ id: m.id, userId: m.userId, email: m.userEmail, name: m.userName, role: m.role, createdAt: m.createdAt })),
    });
  });
```

Change to:

```ts
  app.get("/api/team", requireAuth, requireOrg, async (req, res) => {
    const members = await storage.listMembershipsForOrganization(req.organizationId!);
    return res.json({
      members: members.map((m) => ({
        id: m.id,
        userId: m.userId,
        email: m.userEmail,
        name: m.userName,
        role: m.role,
        isActive: m.isActive,
        createdAt: m.createdAt,
      })),
    });
  });
```

- [ ] **Step 2: Type-check**

Run: `npm run check`
Expected: clean.

- [ ] **Step 3: Add the org-admin routes**

In `server/routes.ts`, immediately after the existing `POST /api/team/invite` route and before the `// --- Emission factors ---` comment block, find:

```ts
  app.post("/api/team/invite", requireAuth, requireOrg, async (req, res) => {
    if (req.membership!.role !== "owner" && req.membership!.role !== "admin") {
      return res.status(403).json({ message: "Only an owner or admin can invite team members" });
    }
    try {
      const { email, role } = parseBody(inviteSchema, req.body);
      const user = await storage.getUserByEmail(email);
      if (!user) {
        return res.status(404).json({
          message: "No account exists for that email yet. They need to register before you can add them to your organization.",
        });
      }
      const existing = await storage.getMembership(user.id, req.organizationId!);
      if (existing) {
        return res.status(409).json({ message: "This person is already a member of your organization" });
      }
      const membership = await storage.createMembership({ userId: user.id, organizationId: req.organizationId!, role });
      return res.status(201).json({ membership: { id: membership.id, email: user.email, name: user.name, role: membership.role } });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid invite payload" });
    }
  });

  // -----------------------------------------------------------------------
  // Emission factors -- persisted, tenant-scoped
```

Insert the new routes between them:

```ts
  app.post("/api/team/invite", requireAuth, requireOrg, async (req, res) => {
    if (req.membership!.role !== "owner" && req.membership!.role !== "admin") {
      return res.status(403).json({ message: "Only an owner or admin can invite team members" });
    }
    try {
      const { email, role } = parseBody(inviteSchema, req.body);
      const user = await storage.getUserByEmail(email);
      if (!user) {
        return res.status(404).json({
          message: "No account exists for that email yet. They need to register before you can add them to your organization.",
        });
      }
      const existing = await storage.getMembership(user.id, req.organizationId!);
      if (existing) {
        return res.status(409).json({ message: "This person is already a member of your organization" });
      }
      const membership = await storage.createMembership({ userId: user.id, organizationId: req.organizationId!, role });
      return res.status(201).json({ membership: { id: membership.id, email: user.email, name: user.name, role: membership.role } });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid invite payload" });
    }
  });

  // -----------------------------------------------------------------------
  // Team lifecycle -- org owner/admin self-service, scoped to their own
  // tenant. Membership-level actions (deactivate/activate) can never affect
  // another org by construction (scopedToOrgId on the storage call). For
  // account-wide actions (deactivate/reactivate the account, change its
  // email, trigger a password reset), an org-admin's authority is limited
  // to targets whose ONLY membership -- active or not -- is this org; the
  // moment a user belongs to a second org, only a super-admin can act. See
  // docs/superpowers/specs/2026-09-04-membership-lifecycle-management-design.md.
  // -----------------------------------------------------------------------
  app.post("/api/team/memberships/:id/deactivate", requireAuth, requireOrg, async (req, res) => {
    if (req.membership!.role !== "owner" && req.membership!.role !== "admin") {
      return res.status(403).json({ message: "Only an owner or admin can deactivate a membership" });
    }
    const membershipId = Number(req.params.id);
    if (!Number.isInteger(membershipId) || membershipId <= 0) {
      return res.status(400).json({ message: "Invalid membership id" });
    }
    const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
    if (!note) {
      return res.status(400).json({ message: "A reason is required to deactivate a membership." });
    }
    const updated = await storage.deactivateMembership(membershipId, req.organizationId!);
    if (!updated) return res.status(404).json({ message: "Membership not found" });
    const target = await storage.getUser(updated.userId);
    const org = await storage.getOrganization(updated.organizationId);
    try {
      await storage.logAdminAction({
        actorUserId: (req.user as { id: number }).id,
        action: "deactivate_membership",
        targetUserId: updated.userId,
        targetEmail: target?.email ?? "",
        organizationId: updated.organizationId,
        organizationName: org?.name,
        note,
      });
    } catch (err) {
      console.error("Failed to write admin action log (deactivate_membership, org-admin):", err);
    }
    return res.status(200).json({ membership: { id: updated.id, isActive: updated.isActive } });
  });

  app.post("/api/team/memberships/:id/activate", requireAuth, requireOrg, async (req, res) => {
    if (req.membership!.role !== "owner" && req.membership!.role !== "admin") {
      return res.status(403).json({ message: "Only an owner or admin can activate a membership" });
    }
    const membershipId = Number(req.params.id);
    if (!Number.isInteger(membershipId) || membershipId <= 0) {
      return res.status(400).json({ message: "Invalid membership id" });
    }
    const updated = await storage.activateMembership(membershipId, req.organizationId!);
    if (!updated) return res.status(404).json({ message: "Membership not found" });
    const target = await storage.getUser(updated.userId);
    const org = await storage.getOrganization(updated.organizationId);
    try {
      await storage.logAdminAction({
        actorUserId: (req.user as { id: number }).id,
        action: "activate_membership",
        targetUserId: updated.userId,
        targetEmail: target?.email ?? "",
        organizationId: updated.organizationId,
        organizationName: org?.name,
      });
    } catch (err) {
      console.error("Failed to write admin action log (activate_membership, org-admin):", err);
    }
    return res.status(200).json({ membership: { id: updated.id, isActive: updated.isActive } });
  });

  app.post("/api/team/members/:id/deactivate", requireAuth, requireOrg, async (req, res) => {
    if (req.membership!.role !== "owner" && req.membership!.role !== "admin") {
      return res.status(403).json({ message: "Only an owner or admin can deactivate a member's account" });
    }
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({ message: "Invalid user id" });
    }
    const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
    if (!note) {
      return res.status(400).json({ message: "A reason is required to deactivate an account." });
    }
    if (!(await storage.isUsersSoleOrganization(targetId, req.organizationId!))) {
      return res.status(403).json({
        message: "This account belongs to more than one organization. Only a super-admin can deactivate it.",
      });
    }
    const target = await storage.getUser(targetId);
    if (!target) return res.status(404).json({ message: "User not found" });
    if (!target.emailVerified) {
      return res.status(400).json({ message: "This account isn't verified yet." });
    }
    await storage.deactivateAccount(target.id);
    const org = await storage.getOrganization(req.organizationId!);
    try {
      await storage.logAdminAction({
        actorUserId: (req.user as { id: number }).id,
        action: "deactivate_user",
        targetUserId: target.id,
        targetEmail: target.email,
        organizationId: req.organizationId!,
        organizationName: org?.name,
        note,
      });
    } catch (err) {
      console.error("Failed to write admin action log (deactivate_user, org-admin):", err);
    }
    return res.status(200).json({ user: { id: target.id, email: target.email, isActive: false } });
  });

  app.post("/api/team/members/:id/reactivate", requireAuth, requireOrg, async (req, res) => {
    if (req.membership!.role !== "owner" && req.membership!.role !== "admin") {
      return res.status(403).json({ message: "Only an owner or admin can reactivate a member's account" });
    }
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({ message: "Invalid user id" });
    }
    if (!(await storage.isUsersSoleOrganization(targetId, req.organizationId!))) {
      return res.status(403).json({
        message: "This account belongs to more than one organization. Only a super-admin can reactivate it.",
      });
    }
    const target = await storage.getUser(targetId);
    if (!target) return res.status(404).json({ message: "User not found" });
    await storage.reactivateAccount(target.id);
    const org = await storage.getOrganization(req.organizationId!);
    try {
      await storage.logAdminAction({
        actorUserId: (req.user as { id: number }).id,
        action: "activate_user",
        targetUserId: target.id,
        targetEmail: target.email,
        organizationId: req.organizationId!,
        organizationName: org?.name,
      });
    } catch (err) {
      console.error("Failed to write admin action log (activate_user, org-admin):", err);
    }
    return res.status(200).json({ user: { id: target.id, email: target.email, isActive: true } });
  });

  app.post("/api/team/members/:id/change-email", requireAuth, requireOrg, async (req, res) => {
    if (req.membership!.role !== "owner" && req.membership!.role !== "admin") {
      return res.status(403).json({ message: "Only an owner or admin can change a member's email" });
    }
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({ message: "Invalid user id" });
    }
    const parsed = z.object({ newEmail: z.string().email(), note: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "A new email and a reason are both required." });
    }
    if (!(await storage.isUsersSoleOrganization(targetId, req.organizationId!))) {
      return res.status(403).json({
        message: "This account belongs to more than one organization. Only a super-admin can change its email.",
      });
    }
    const target = await storage.getUser(targetId);
    if (!target) return res.status(404).json({ message: "User not found" });
    const existing = await storage.getUserByEmail(parsed.data.newEmail);
    if (existing && existing.id !== target.id) {
      return res.status(409).json({ message: "An account with this email already exists" });
    }
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await storage.setNewEmailPendingVerification(target.id, parsed.data.newEmail, token, expiresAt);
    try {
      await sendPasswordResetEmail({
        to: parsed.data.newEmail,
        token,
        requestOrigin: `${req.protocol}://${req.get("host")}`,
      });
    } catch (emailError) {
      console.error("Failed to send password reset email (change-email, org-admin):", emailError);
    }
    const org = await storage.getOrganization(req.organizationId!);
    try {
      await storage.logAdminAction({
        actorUserId: (req.user as { id: number }).id,
        action: "change_email",
        targetUserId: target.id,
        targetEmail: parsed.data.newEmail,
        organizationId: req.organizationId!,
        organizationName: org?.name,
        note: parsed.data.note,
      });
    } catch (err) {
      console.error("Failed to write admin action log (change_email, org-admin):", err);
    }
    return res.status(200).json({ user: { id: target.id, email: parsed.data.newEmail } });
  });

  app.post("/api/team/members/:id/reset-password", requireAuth, requireOrg, async (req, res) => {
    if (req.membership!.role !== "owner" && req.membership!.role !== "admin") {
      return res.status(403).json({ message: "Only an owner or admin can reset a member's password" });
    }
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({ message: "Invalid user id" });
    }
    const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
    if (!note) {
      return res.status(400).json({ message: "A reason is required to reset a password." });
    }
    if (!(await storage.isUsersSoleOrganization(targetId, req.organizationId!))) {
      return res.status(403).json({
        message: "This account belongs to more than one organization. Only a super-admin can reset its password.",
      });
    }
    const target = await storage.getUser(targetId);
    if (!target) return res.status(404).json({ message: "User not found" });
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await storage.setPasswordResetToken(target.id, token, expiresAt);
    try {
      await sendPasswordResetEmail({
        to: target.email,
        token,
        requestOrigin: `${req.protocol}://${req.get("host")}`,
      });
    } catch (emailError) {
      console.error("Failed to send password reset email (admin reset-password, org-admin):", emailError);
    }
    const org = await storage.getOrganization(req.organizationId!);
    try {
      await storage.logAdminAction({
        actorUserId: (req.user as { id: number }).id,
        action: "reset_password",
        targetUserId: target.id,
        targetEmail: target.email,
        organizationId: req.organizationId!,
        organizationName: org?.name,
        note,
      });
    } catch (err) {
      console.error("Failed to write admin action log (reset_password, org-admin):", err);
    }
    return res.status(200).json({ message: "Password reset email sent." });
  });

  app.get("/api/team/action-log", requireAuth, requireOrg, async (req, res) => {
    const entries = await storage.listAdminActionLogForOrganization(req.organizationId!);
    return res.json({ entries });
  });

  // -----------------------------------------------------------------------
  // Emission factors -- persisted, tenant-scoped
```

- [ ] **Step 4: Add the org-scoped action-log query to storage**

`GET /api/team/action-log` above calls `storage.listAdminActionLogForOrganization`, which doesn't exist yet. In `server/storage.ts`, immediately after `listAdminActionLog`, find:

```ts
  async listAdminActionLog(): Promise<AdminActionLogEntry[]> {
    return db
      .select({
        id: adminActionLog.id,
        actorEmail: users.email,
        action: adminActionLog.action,
        targetEmail: adminActionLog.targetEmail,
        organizationName: adminActionLog.organizationName,
        note: adminActionLog.note,
        createdAt: adminActionLog.createdAt,
      })
      .from(adminActionLog)
      .innerJoin(users, eq(users.id, adminActionLog.actorUserId))
      .orderBy(desc(adminActionLog.createdAt))
      .limit(200) as Promise<AdminActionLogEntry[]>;
  }
}
```

Change to:

```ts
  async listAdminActionLog(): Promise<AdminActionLogEntry[]> {
    return db
      .select({
        id: adminActionLog.id,
        actorEmail: users.email,
        action: adminActionLog.action,
        targetEmail: adminActionLog.targetEmail,
        organizationName: adminActionLog.organizationName,
        note: adminActionLog.note,
        createdAt: adminActionLog.createdAt,
      })
      .from(adminActionLog)
      .innerJoin(users, eq(users.id, adminActionLog.actorUserId))
      .orderBy(desc(adminActionLog.createdAt))
      .limit(200) as Promise<AdminActionLogEntry[]>;
  }

  async listAdminActionLogForOrganization(organizationId: number): Promise<AdminActionLogEntry[]> {
    return db
      .select({
        id: adminActionLog.id,
        actorEmail: users.email,
        action: adminActionLog.action,
        targetEmail: adminActionLog.targetEmail,
        organizationName: adminActionLog.organizationName,
        note: adminActionLog.note,
        createdAt: adminActionLog.createdAt,
      })
      .from(adminActionLog)
      .innerJoin(users, eq(users.id, adminActionLog.actorUserId))
      .where(eq(adminActionLog.organizationId, organizationId))
      .orderBy(desc(adminActionLog.createdAt))
      .limit(200) as Promise<AdminActionLogEntry[]>;
  }
}
```

Add its signature to `IStorage` right after `listAdminActionLog(): Promise<AdminActionLogEntry[]>;`:

```ts
  listAdminActionLog(): Promise<AdminActionLogEntry[]>;
  listAdminActionLogForOrganization(organizationId: number): Promise<AdminActionLogEntry[]>;
}
```

- [ ] **Step 5: Type-check**

Run: `npm run check`
Expected: clean.

- [ ] **Step 6: Manual verification against the running server**

With the dev server running, log in as a regular org owner (not super-admin) and, using their session cookie, exercise each `/api/team/...` route against a scratch member of their own org: deactivate/activate a membership, deactivate/reactivate the account, change its email, trigger a password reset. Confirm `GET /api/team/action-log` shows only that org's entries. Then set up a second scratch user with memberships in TWO different orgs (via `/api/team/invite`, mirroring the earlier Critical-bug regression test) and confirm every account-wide `/api/team/members/:id/...` route returns `403` for that user from either org's admin session, while the membership-level routes still work fine.

- [ ] **Step 7: Commit**

```bash
git add server/storage.ts server/routes.ts
git commit -m "feat: add org-admin self-service routes (/api/team/...) for membership/account lifecycle"
```

---

### Task 7: Client — TeamPanel.tsx rewrite

**Files:**
- Modify: `client/src/components/TeamPanel.tsx`

**Interfaces:**
- Consumes: Task 6's `/api/team/...` routes and extended `GET /api/team` shape.
- Produces: nothing further consumed by later tasks (last client task).

- [ ] **Step 1: Rewrite the component**

Replace the full contents of `client/src/components/TeamPanel.tsx` (currently 94 lines, shown in full above for reference) with:

```tsx
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { useToast } from "@/hooks/use-toast";

interface TeamMember {
  id: number;
  userId: number;
  email: string;
  name: string | null;
  role: "owner" | "admin" | "member";
  isActive: boolean;
  createdAt: string;
}

interface TeamActionLogEntry {
  id: number;
  actorEmail: string;
  action: string;
  targetEmail: string;
  note: string | null;
  createdAt: string;
}

export default function TeamPanel() {
  const { organizations } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [inviteEmail, setInviteEmail] = useState("");
  const [membershipNotes, setMembershipNotes] = useState<Record<number, string>>({});
  const [deactivateNotes, setDeactivateNotes] = useState<Record<number, string>>({});
  const [resetPasswordNotes, setResetPasswordNotes] = useState<Record<number, string>>({});
  const [changeEmailDrafts, setChangeEmailDrafts] = useState<Record<number, { email: string; note: string }>>({});

  const role = organizations[0]?.role;
  const canManage = role === "owner" || role === "admin";

  const teamQuery = useQuery<{ members: TeamMember[] }>({ queryKey: ["/api/team"] });
  const actionLogQuery = useQuery<{ entries: TeamActionLogEntry[] }>({
    queryKey: ["/api/team/action-log"],
    enabled: canManage,
  });

  function invalidateAll() {
    queryClient.invalidateQueries({ queryKey: ["/api/team"] });
    queryClient.invalidateQueries({ queryKey: ["/api/team/action-log"] });
  }

  const invite = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/team/invite", { email: inviteEmail });
      return res.json();
    },
    onSuccess: () => {
      setInviteEmail("");
      invalidateAll();
      toast({ title: "Added to team" });
    },
    onError: (err) => toast({ title: "Could not add member", description: err.message, variant: "destructive" }),
  });

  const deactivateMembership = useMutation({
    mutationFn: async ({ membershipId, note }: { membershipId: number; note: string }) => {
      const res = await apiRequest("POST", `/api/team/memberships/${membershipId}/deactivate`, { note });
      return res.json();
    },
    onSuccess: (_data, { membershipId }) => {
      invalidateAll();
      setMembershipNotes((prev) => {
        const next = { ...prev };
        delete next[membershipId];
        return next;
      });
      toast({ title: "Membership deactivated" });
    },
    onError: (err) => toast({ title: "Could not deactivate membership", description: err.message, variant: "destructive" }),
  });

  const activateMembership = useMutation({
    mutationFn: async (membershipId: number) => {
      const res = await apiRequest("POST", `/api/team/memberships/${membershipId}/activate`);
      return res.json();
    },
    onSuccess: () => {
      invalidateAll();
      toast({ title: "Membership reactivated" });
    },
    onError: (err) => toast({ title: "Could not reactivate membership", description: err.message, variant: "destructive" }),
  });

  const deactivateAccount = useMutation({
    mutationFn: async ({ userId, note }: { userId: number; note: string }) => {
      const res = await apiRequest("POST", `/api/team/members/${userId}/deactivate`, { note });
      return res.json();
    },
    onSuccess: (_data, { userId }) => {
      invalidateAll();
      setDeactivateNotes((prev) => {
        const next = { ...prev };
        delete next[userId];
        return next;
      });
      toast({ title: "Account deactivated" });
    },
    onError: (err) => toast({ title: "Could not deactivate account", description: err.message, variant: "destructive" }),
  });

  const reactivateAccount = useMutation({
    mutationFn: async (userId: number) => {
      const res = await apiRequest("POST", `/api/team/members/${userId}/reactivate`);
      return res.json();
    },
    onSuccess: () => {
      invalidateAll();
      toast({ title: "Account reactivated" });
    },
    onError: (err) => toast({ title: "Could not reactivate account", description: err.message, variant: "destructive" }),
  });

  const changeEmail = useMutation({
    mutationFn: async ({ userId, newEmail, note }: { userId: number; newEmail: string; note: string }) => {
      const res = await apiRequest("POST", `/api/team/members/${userId}/change-email`, { newEmail, note });
      return res.json();
    },
    onSuccess: (_data, { userId }) => {
      invalidateAll();
      setChangeEmailDrafts((prev) => {
        const next = { ...prev };
        delete next[userId];
        return next;
      });
      toast({ title: "Email changed — a reset link was sent to the new address" });
    },
    onError: (err) => toast({ title: "Could not change email", description: err.message, variant: "destructive" }),
  });

  const resetPassword = useMutation({
    mutationFn: async ({ userId, note }: { userId: number; note: string }) => {
      const res = await apiRequest("POST", `/api/team/members/${userId}/reset-password`, { note });
      return res.json();
    },
    onSuccess: (_data, { userId }) => {
      invalidateAll();
      setResetPasswordNotes((prev) => {
        const next = { ...prev };
        delete next[userId];
        return next;
      });
      toast({ title: "Password reset email sent" });
    },
    onError: (err) => toast({ title: "Could not send password reset", description: err.message, variant: "destructive" }),
  });

  const members = teamQuery.data?.members ?? [];
  const entries = actionLogQuery.data?.entries ?? [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Team</CardTitle>
          <CardDescription>
            {canManage
              ? "Add, deactivate, or manage members of your organization."
              : "Members of your organization."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {members.length === 0 && !teamQuery.isLoading && (
            <p className="text-sm text-neutral-500">No team members found.</p>
          )}
          {members.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  {canManage && <TableHead />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell>{m.name || "-"}</TableCell>
                    <TableCell>{m.email}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="capitalize">{m.role}</Badge>
                    </TableCell>
                    <TableCell>
                      {m.isActive ? (
                        <Badge variant="secondary">Active</Badge>
                      ) : (
                        <Badge variant="destructive">Deactivated</Badge>
                      )}
                    </TableCell>
                    {canManage && (
                      <TableCell>
                        <div className="flex flex-wrap gap-2 justify-end">
                          {m.isActive ? (
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button variant="ghost" size="sm" className="text-destructive">
                                  Deactivate membership
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Deactivate {m.email}'s membership?</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    This revokes their access to your organization only. A reason is required.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <div className="py-2 space-y-2">
                                  <Label htmlFor={`membership-note-${m.id}`}>Reason</Label>
                                  <Textarea
                                    id={`membership-note-${m.id}`}
                                    value={membershipNotes[m.id] ?? ""}
                                    onChange={(e) =>
                                      setMembershipNotes((prev) => ({ ...prev, [m.id]: e.target.value }))
                                    }
                                  />
                                </div>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                                  <AlertDialogAction
                                    disabled={!membershipNotes[m.id]?.trim()}
                                    onClick={() =>
                                      deactivateMembership.mutate({ membershipId: m.id, note: membershipNotes[m.id]!.trim() })
                                    }
                                  >
                                    Deactivate
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => activateMembership.mutate(m.id)}
                              disabled={activateMembership.isPending}
                            >
                              Reactivate membership
                            </Button>
                          )}
                          {m.isActive ? (
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button variant="ghost" size="sm" className="text-destructive">
                                  Deactivate account
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Deactivate {m.email}'s account?</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    This blocks their login entirely. Only available if they belong to no other
                                    organization — otherwise a super-admin is required. A reason is required.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <div className="py-2 space-y-2">
                                  <Label htmlFor={`deactivate-note-${m.userId}`}>Reason</Label>
                                  <Textarea
                                    id={`deactivate-note-${m.userId}`}
                                    value={deactivateNotes[m.userId] ?? ""}
                                    onChange={(e) =>
                                      setDeactivateNotes((prev) => ({ ...prev, [m.userId]: e.target.value }))
                                    }
                                  />
                                </div>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                                  <AlertDialogAction
                                    disabled={!deactivateNotes[m.userId]?.trim()}
                                    onClick={() =>
                                      deactivateAccount.mutate({ userId: m.userId, note: deactivateNotes[m.userId]!.trim() })
                                    }
                                  >
                                    Deactivate
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => reactivateAccount.mutate(m.userId)}
                              disabled={reactivateAccount.isPending}
                            >
                              Reactivate account
                            </Button>
                          )}
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button variant="ghost" size="sm">
                                Change email
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Change {m.email}'s email?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  A password-set link is emailed to the new address — nobody types or shares a
                                  password. Only available if they belong to no other organization. A reason is
                                  required.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <div className="py-2 space-y-3">
                                <div className="space-y-2">
                                  <Label htmlFor={`new-email-${m.userId}`}>New email</Label>
                                  <Input
                                    id={`new-email-${m.userId}`}
                                    type="email"
                                    value={changeEmailDrafts[m.userId]?.email ?? ""}
                                    onChange={(e) =>
                                      setChangeEmailDrafts((prev) => ({
                                        ...prev,
                                        [m.userId]: { email: e.target.value, note: prev[m.userId]?.note ?? "" },
                                      }))
                                    }
                                  />
                                </div>
                                <div className="space-y-2">
                                  <Label htmlFor={`change-email-note-${m.userId}`}>Reason</Label>
                                  <Textarea
                                    id={`change-email-note-${m.userId}`}
                                    value={changeEmailDrafts[m.userId]?.note ?? ""}
                                    onChange={(e) =>
                                      setChangeEmailDrafts((prev) => ({
                                        ...prev,
                                        [m.userId]: { email: prev[m.userId]?.email ?? "", note: e.target.value },
                                      }))
                                    }
                                  />
                                </div>
                              </div>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction
                                  disabled={
                                    !changeEmailDrafts[m.userId]?.email?.trim() || !changeEmailDrafts[m.userId]?.note?.trim()
                                  }
                                  onClick={() =>
                                    changeEmail.mutate({
                                      userId: m.userId,
                                      newEmail: changeEmailDrafts[m.userId]!.email.trim(),
                                      note: changeEmailDrafts[m.userId]!.note.trim(),
                                    })
                                  }
                                >
                                  Change email
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button variant="ghost" size="sm">
                                Reset password
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Send {m.email} a password reset link?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  Nobody types or sees their new password — they set it themselves via the emailed
                                  link. A reason is required.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <div className="py-2 space-y-2">
                                <Label htmlFor={`reset-password-note-${m.userId}`}>Reason</Label>
                                <Textarea
                                  id={`reset-password-note-${m.userId}`}
                                  value={resetPasswordNotes[m.userId] ?? ""}
                                  onChange={(e) =>
                                    setResetPasswordNotes((prev) => ({ ...prev, [m.userId]: e.target.value }))
                                  }
                                />
                              </div>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction
                                  disabled={!resetPasswordNotes[m.userId]?.trim()}
                                  onClick={() =>
                                    resetPassword.mutate({ userId: m.userId, note: resetPasswordNotes[m.userId]!.trim() })
                                  }
                                >
                                  Send reset link
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {canManage && (
            <div className="flex gap-2 pt-2 border-t border-neutral-100">
              <Input
                type="email"
                placeholder="teammate@example.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                className="max-w-xs"
              />
              <Button onClick={() => invite.mutate()} disabled={!inviteEmail || invite.isPending}>
                {invite.isPending ? "Adding..." : "Add"}
              </Button>
            </div>
          )}
          <p className="text-xs text-neutral-400">
            The person must already have an account. There's no email invite yet, they need to register themselves first,
            then you can add them here.
          </p>
        </CardContent>
      </Card>

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent activity</CardTitle>
            <CardDescription>The most recent admin actions within your organization.</CardDescription>
          </CardHeader>
          <CardContent>
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
                      <TableCell className="capitalize">{e.action.replace(/_/g, " ")}</TableCell>
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
      )}
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npm run check`
Expected: clean.

- [ ] **Step 3: Manual browser verification**

Log in as a regular org owner. On the Team section, confirm the member table shows role and active/inactive status, and confirm the invite flow still works exactly as before. Deactivate a scratch member's membership, confirm their badge flips and login (as that member) now fails to reach this org's data (while their other org, if any, is untouched). Deactivate their whole account (a single-org member), confirm login fails entirely; reactivate it. Change a member's email and confirm the same verify-and-set-password flow from Task 4/5 works from this UI too. Confirm "Recent activity" only shows this org's rows. Finally, confirm a member who belongs to a second org (set up via `/api/team/invite` from two different org sessions) shows only "Deactivate membership" working — the account-wide buttons should surface the `403` boundary message as a toast when attempted.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/TeamPanel.tsx
git commit -m "feat: rewrite TeamPanel with membership/account lifecycle controls and org-scoped activity log"
```

---

### Task 8: Testing

**Files:**
- Modify: `scripts/verify-admin-panel.mjs` (extend with the new scenarios) — or split into a sibling script if it grows past a comfortable single-file size; use your judgment once you see the current line count, but keep the same standalone-and-destructive convention either way.
- Modify: `scripts/verify-branch.mjs` (extend `step3_dbPush` for the new columns)

**Interfaces:**
- Consumes: Tasks 1-7 fully in place.
- Produces: automated regression coverage; no new interfaces (last task).

- [ ] **Step 1: Extend `verify-branch.mjs`'s schema check**

In `scripts/verify-branch.mjs`, `step3_dbPush`'s column query currently includes `'is_super_admin'` in the `users` column-name list and a separate `admin_action_log` table-existence check (from the prior admin-panel plan). Add the four new columns from Task 1 to the same pattern: extend the `users` column-name list with `'is_active'`, `'password_reset_token'`, `'password_reset_token_expires_at'`, add a `(table_name = 'memberships' AND column_name = 'is_active')` clause to the same query, add `"users.is_active"`, `"users.password_reset_token"`, `"users.password_reset_token_expires_at"`, `"memberships.is_active"` to the `required` array, and add `admin_action_log.organization_id`/`admin_action_log.organization_name` to both the query and `required` array the same way (these are column checks on an existing table, not a new table-existence check like `admin_action_log` itself needed). Read the current file to get the exact surrounding lines before editing — it was last touched by the prior admin-panel plan's Task 4, so match its exact current structure rather than the older version shown in that plan's own text.

- [ ] **Step 2: Run the full smoke test**

Run: `npm run verify`
Expected: all steps pass, including the extended schema check, exit code 0.

- [ ] **Step 3: Extend the standalone admin-panel test script**

Read the current `scripts/verify-admin-panel.mjs` in full first (it already has 15 scenarios from the prior plan, using `registerAndVerify`/`registerOnly`/`login`/`getUserId` helpers and a `RUN_TAG`/`createdEmails` cleanup convention). Add new scenarios, reusing those exact helpers, covering:

1. **Membership deactivate blocks `requireOrg` access, reactivate restores it.** Register+verify a scratch user with their own org (they're its owner). Log in as them, confirm a tenant-scoped call (e.g. `GET /api/setup-status`) succeeds. As the super-admin, deactivate that membership via `POST /api/admin/memberships/:id/deactivate` with a note. Retry the SAME tenant-scoped call with the SAME (already-issued) session cookie — assert it now fails (403, "No organization membership found"), proving `requireOrg` re-resolves fresh rather than trusting a cached session. Reactivate the membership, retry, assert it succeeds again.
2. **Account deactivate blocks login, reactivate restores it.** Deactivate a verified scratch account via `POST /api/admin/users/:id/deactivate` with a note, attempt login, assert `401` with `reason: "deactivated"`. Reactivate, attempt login again, assert `200`.
3. **Deactivating an unverified account is rejected.** Register a scratch user, leave it unverified, attempt `POST /api/admin/users/:id/deactivate`, assert `400`.
4. **Change-email end to end.** Change a scratch account's email via `POST /api/admin/users/:id/change-email`, pull the new `password_reset_token` directly from the DB (by the NEW email), call `POST /api/auth/reset-password` with it and a new password, assert `200`, then assert via DB read that `email_verified = true` and the old password no longer authenticates while the new one does.
5. **Admin-triggered reset-password end to end.** Similar to #4 but via `POST /api/admin/users/:id/reset-password`, confirming the same token mechanism works for a reset that doesn't also change the email.
6. **Self-service forgot-password end to end.** `POST /api/auth/forgot-password` for a verified scratch account, pull the token from the DB, complete via `POST /api/auth/reset-password`, confirm login with the new password.
7. **Forgot-password generic response, verified-only.** Assert `POST /api/auth/forgot-password` returns the identical response shape for a nonexistent email, an unverified account's email, and a verified account's email — and assert via DB read that only the verified account actually got a token written.
8. **Org-admin membership deactivate/activate, scoped correctly.** Using a scratch org owner's session (not super-admin), deactivate/activate a membership within their own org via `/api/team/memberships/:id/...`, assert success; attempt the same against a membership in a DIFFERENT org (created for another scratch owner), assert `404` (out of scope, not found).
9. **Org-admin account-wide boundary rule.** Set up a scratch user with memberships in two different orgs (via `/api/team/invite`, mirroring the existing Critical-bug regression scenario already in this file). From either org's admin session, attempt `POST /api/team/members/:id/deactivate`, `.../reactivate`, `.../change-email`, `.../reset-password` — assert all four return `403`. Then deactivate ONE of the two memberships (leaving the user in only one org), retry the SAME account-wide actions from that remaining org's admin session, assert they now succeed (the boundary rule is based on ALL memberships, so confirm this specific transition works as designed).
10. **Non-owner/admin org member is rejected.** Using a scratch "member"-role (not owner/admin) session, attempt any `/api/team/...` lifecycle route, assert `403`.
11. **`GET /api/team/action-log` is org-scoped; `GET /api/admin/action-log` sees everything.** After several of the above scenarios have run, confirm the org-admin's action-log view contains only their own org's rows (checked by asserting a known cross-tenant super-admin action, e.g. one from an earlier scenario, is ABSENT), while the super-admin's view contains rows from multiple orgs.

Extend the cleanup `finally` block to track and remove every new scratch account/org this task's scenarios create, following the exact same `createdEmails`/`admin_action_log`-before-`users` ordering already established in the file.

- [ ] **Step 4: Run it**

With the dev server running: `node scripts/verify-admin-panel.mjs`
Expected: all scenarios (existing 15 plus the new ones from Step 3) pass, exit code 0. Report the exact new total.

- [ ] **Step 5: Full regression check**

Run: `npm run check` then `npm run verify`
Expected: both clean, 0 failed.

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-admin-panel.mjs scripts/verify-branch.mjs
git commit -m "test: add membership/account lifecycle coverage (deactivate/activate, email-change, password reset, org-admin boundary rule)"
```

---

## Self-Review

**Spec coverage:** every section of `docs/superpowers/specs/2026-09-04-membership-lifecycle-management-design.md` maps to a task — Data model → Task 1, the self-service password-reset mechanism → Tasks 2-3, super-admin server/client → Tasks 4-5, org-admin server/client → Tasks 6-7, Testing → Task 8. All Decisions are reflected: membership vs. account independence (separate columns, separate routes), the two-tier permission model with the sole-organization boundary rule (`isUsersSoleOrganization`, checked in every `/api/team/members/...` route before the DB mutation), notes required exactly where specified (validated per-route, matching the existing demote precedent), and the no-admin-typed-password guarantee (change-email and admin-reset-password both route through `setPasswordResetToken`/`sendPasswordResetEmail`, never touching `passwordHash` directly). Tenant lifecycle, MFA, and log-analysis automation are correctly absent from every task, matching the spec's Out of scope.

**Placeholder scan:** no TBD/TODO, no "add appropriate error handling," no "write tests for the above" without real scenarios — every step has complete code or a concretely described test scenario. Task 8 Step 1 and Step 3 describe extending existing files by pattern-matching their current (already-once-extended) structure rather than showing a stale full-file diff, since both files were already modified by the prior admin-panel plan after this plan's research pass began drafting; this is a deliberate choice, not a placeholder, and is flagged explicitly as "read the current file first" rather than assuming stale line numbers.

**Type consistency:** `AdminUserListItem.organizations[]`'s `{ membershipId, organizationId, organizationName, role, isActive }` shape is defined once in Task 4 Step 1 and produced identically by `listAllUsersForAdmin` (Task 4 Step 2) and consumed identically by `Admin.tsx` (Task 5 Step 1). `AdminActionLogEntry`'s action union and `organizationName` field are defined once (Task 4 Step 1) and used identically by both `listAdminActionLog`/`listAdminActionLogForOrganization` (Task 4/6) and both `Admin.tsx`/`TeamPanel.tsx` (Task 5/7). `deactivateMembership`/`activateMembership`'s `scopedToOrgId?: number` optional parameter is defined once (Task 4 Step 3) and used with `undefined` (super-admin, Task 4 Step 6) vs. `req.organizationId!` (org-admin, Task 6 Step 3) at its two call sites — the org-scoping behavior is identical code, just a different argument, not a forked implementation. `isUsersSoleOrganization`'s signature (Task 2 Step 2) matches its four call sites in Task 6 Step 3 exactly. `logAdminAction`'s `organizationId?`/`organizationName?` optional fields are consistently omitted (super-admin cross-tenant actions in Task 4) or populated (org-admin actions in Task 6) — never mismatched.
