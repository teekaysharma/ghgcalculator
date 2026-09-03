# Registration Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add password complexity rules and mandatory email verification to registration (via Resend), with an automated daily cleanup of unverified registrations that expire before anyone confirms them.

**Architecture:** Registration creates the user/org/membership as today but with `emailVerified: false` and a 24h token, sends a verification email instead of starting a session, and requires that token to be redeemed (via a real app page, not a raw API link) before login succeeds. A daily Vercel Cron job hits a route in the same Express app to delete anything still unverified past its token's expiry.

**Tech Stack:** Express, Passport (`passport-local`), Drizzle ORM + Neon Postgres, Resend (new dependency), React + `wouter` + `@tanstack/react-query`, `zod`.

**Spec:** `docs/superpowers/specs/2026-09-03-registration-hardening-design.md` — read it for the *why* behind each decision below; this plan covers only the *what/how*.

## Global Constraints

- Password: min 8 chars, at least one uppercase, one lowercase, one number. No forced special character.
- Verification token: 24 hours from issuance. No session (`req.login()`) is created at registration — only after a successful verify.
- Verification email must state the 24-hour deadline and its consequence explicitly, in both the email body and the on-screen "check your email" copy.
- Existing `users` rows are grandfathered as `email_verified = true` by the migration itself — never re-verify pre-existing accounts.
- The verification link is `${origin}/verify-email?token=<token>&email=<email>` — both params, always, and `${origin}` is built from the request (`req.protocol`/`req.get("host")`), never a hardcoded env var.
- `resend-verification-email` always returns the same generic `200` response regardless of whether the email exists or is already verified — never leak account existence.
- Cleanup: `GET /api/cron/cleanup-unverified-users`, requires `Authorization: Bearer <CRON_SECRET>`, scheduled once daily in `vercel.json`. Deletes `organizations` + (cascaded) `memberships` + `users` for every row where `email_verified = false AND email_verification_token_expires_at < now()`.
- The 48-hour recovery-copy threshold (24h token expiry + up to 24h until the next daily sweep) is the number used anywhere the UI tells a visitor how to self-diagnose an expired link.
- All new required env vars — `RESEND_API_KEY`, `EMAIL_FROM` (optional, defaults to `onboarding@resend.dev`), `CRON_SECRET` — get documented in `.env.example` in the task that introduces them.

---

## Task 1: Schema migration — verification columns + password complexity

**Files:**
- Modify: `shared/schema.ts` (users table, `insertUserSchema`, `registerSchema`)
- Create: `scripts/manual-migration-012.mjs`

**Interfaces:**
- Produces: `User` type gains `emailVerified: boolean`, `emailVerificationToken: string | null`, `emailVerificationTokenExpiresAt: Date | null`. `InsertUser` type gains the same three as insertable fields. Later tasks (2, 3, 5) depend on these exact field names.

- [ ] **Step 1: Add the three columns to the `users` table definition**

In `shared/schema.ts`, replace the existing `users` table block:

```ts
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

with:

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

- [ ] **Step 2: Include the new columns in `insertUserSchema`**

Replace:

```ts
export const insertUserSchema = createInsertSchema(users).pick({
  email: true,
  passwordHash: true,
  name: true,
});
```

with:

```ts
export const insertUserSchema = createInsertSchema(users).pick({
  email: true,
  passwordHash: true,
  name: true,
  emailVerified: true,
  emailVerificationToken: true,
  emailVerificationTokenExpiresAt: true,
});
```

- [ ] **Step 3: Add password complexity to `registerSchema`**

Replace:

```ts
export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  name: z.string().min(1).optional(),
  organizationName: z.string().min(1, "Organization name is required"),
});
```

with:

```ts
export const registerSchema = z.object({
  email: z.string().email(),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .regex(/[a-z]/, "Password must include a lowercase letter")
    .regex(/[A-Z]/, "Password must include an uppercase letter")
    .regex(/[0-9]/, "Password must include a number"),
  name: z.string().min(1).optional(),
  organizationName: z.string().min(1, "Organization name is required"),
});
```

- [ ] **Step 4: Run the type checker**

Run: `npm run check`
Expected: no errors. (This will surface any other file that destructures `User`/`InsertUser` and needs the new fields — there shouldn't be any yet, since nothing consumes them until Task 3.)

- [ ] **Step 5: Write the migration script**

Create `scripts/manual-migration-012.mjs`:

```js
// scripts/manual-migration-012.mjs
//
// Registration hardening: adds email_verified, email_verification_token,
// and email_verification_token_expires_at to users, then grandfathers
// every existing row as already-verified. See
// docs/superpowers/specs/2026-09-03-registration-hardening-design.md.
//
// Order matters and both steps run in one transaction:
//   1. ADD COLUMN IF NOT EXISTS for all three (email_verified defaults to
//      false at the DB level, so it applies to existing rows too until...)
//   2. ...step 2 explicitly sets email_verified = true for every row that
//      was NOT verified yet -- this is what grandfathers pre-existing
//      users. Safe to run against a fresh, empty users table too.
//
// Idempotent like every other migration in this project: checks
// information_schema before any DDL change, safe to re-run.
//
// Usage: node scripts/manual-migration-012.mjs

import "dotenv/config";
import { Pool } from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL not set. Run this from the project folder with .env filled in.");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const applied = [];
const skipped = [];

async function addColumnIfMissing(client, columnName, ddl) {
  const res = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = $1`,
    [columnName],
  );
  if (res.rowCount > 0) {
    skipped.push(`users.${columnName} (already exists)`);
    return;
  }
  await client.query(ddl);
  applied.push(`ALTER TABLE users ADD COLUMN ${columnName}`);
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await addColumnIfMissing(
      client,
      "email_verified",
      `ALTER TABLE users ADD COLUMN email_verified boolean NOT NULL DEFAULT false`,
    );
    await addColumnIfMissing(
      client,
      "email_verification_token",
      `ALTER TABLE users ADD COLUMN email_verification_token text`,
    );
    await addColumnIfMissing(
      client,
      "email_verification_token_expires_at",
      `ALTER TABLE users ADD COLUMN email_verification_token_expires_at timestamp`,
    );

    const backfill = await client.query(`UPDATE users SET email_verified = true WHERE email_verified = false`);
    if (backfill.rowCount > 0) {
      applied.push(`grandfathered ${backfill.rowCount} existing user(s) as email_verified = true`);
    } else {
      skipped.push("grandfather backfill (no unverified rows found)");
    }

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

Run: `node scripts/manual-migration-012.mjs`
Expected: prints 3 "Applied" lines for the new columns, plus either an "Applied ... grandfathered N existing user(s)" line (if any users already exist) or a "Skipped ... no unverified rows found" line (fresh database).

- [ ] **Step 7: Run it a second time to confirm idempotency**

Run: `node scripts/manual-migration-012.mjs`
Expected: all 3 columns now report "Skipped ... (already exists)", and the backfill line reports "Skipped ... (no unverified rows found)" (everything is already `true` from the first run).

- [ ] **Step 8: Commit**

```bash
git add shared/schema.ts scripts/manual-migration-012.mjs
git commit -m "feat: add email verification columns and password complexity rules"
```

---

## Task 2: Email sending module

**Files:**
- Create: `server/email.ts`
- Modify: `package.json` (new dependency), `.env.example`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `sendVerificationEmail(params: { to: string; token: string; requestOrigin: string }): Promise<void>` — thrown on any send failure (Resend API error, network error), never swallowed internally. Task 3's registration handler wraps the call in its own try/catch.

- [ ] **Step 1: Install the Resend SDK**

Run: `npm install resend`
Expected: `package.json`'s `dependencies` gains a `"resend"` entry; `package-lock.json` updates.

- [ ] **Step 2: Add the new env vars to `.env.example`**

Add these lines to `.env.example` (after the existing `SESSION_SECRET` block):

```
# Resend API key for sending verification emails. Get one at resend.com.
RESEND_API_KEY=

# Optional. Sender address for verification emails. Defaults to Resend's
# onboarding@resend.dev if unset, which works immediately with no domain
# verification -- fine for development and initial testing. Sending from
# your own domain later requires verifying it in the Resend dashboard.
EMAIL_FROM=
```

- [ ] **Step 3: Add your real `RESEND_API_KEY` to your local `.env`**

This is a manual step, not a code change: open `.env` (not `.env.example`) and set `RESEND_API_KEY` to the real key. **If it's not already there, stop and ask the user for it rather than guessing or skipping the real-send test in Step 6.**

- [ ] **Step 4: Write `server/email.ts`**

Create `server/email.ts`:

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

- [ ] **Step 5: Run the type checker**

Run: `npm run check`
Expected: no errors.

- [ ] **Step 6: Manually verify a real send**

Create a throwaway script (do not commit it) to prove the module actually works against the real Resend API:

```js
// scratch-test-email.mjs -- throwaway, do not commit
import "dotenv/config";
import { sendVerificationEmail } from "./server/email.ts";

await sendVerificationEmail({
  to: "YOUR_OWN_EMAIL_HERE@example.com",
  token: "test-token-123",
  requestOrigin: "http://localhost:5000",
});
console.log("Sent without throwing.");
```

Run: `npx tsx scratch-test-email.mjs` (replace the placeholder email with a real inbox you can check first). Expected: prints "Sent without throwing." with no error. Then open the [Resend dashboard](https://resend.com/emails) and confirm the send shows up in the Emails log with a non-error status. Delete `scratch-test-email.mjs` afterward — it's a manual verification aid, not part of the codebase.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json server/email.ts .env.example
git commit -m "feat: add Resend-based verification email sending"
```

---

## Task 3: Registration gating + verify/resend endpoints + login gate

**Files:**
- Modify: `server/storage.ts` (interface + implementation), `server/routes.ts` (register handler rewrite, two new endpoints, login response), `server/auth.ts` (LocalStrategy check), `scripts/verify-branch.mjs` (extend the smoke test)

**Interfaces:**
- Consumes: `sendVerificationEmail` from Task 2 (`server/email.ts`). `User.emailVerified` / `emailVerificationToken` / `emailVerificationTokenExpiresAt` from Task 1.
- Produces:
  - `storage.getUserByVerificationToken(token: string): Promise<User | undefined>`
  - `storage.verifyUserEmail(userId: number): Promise<void>` — sets `emailVerified = true`, clears both token columns.
  - `storage.setEmailVerificationToken(userId: number, token: string, expiresAt: Date): Promise<void>`
  - `POST /api/auth/register` now returns `201 { status: "pending_verification", email: string, emailSendFailed: boolean }` and sets **no** session cookie.
  - `POST /api/auth/verify-email { token }` → `204` on success, `400 { message }` on failure (token not found or expired — same response shape either way).
  - `POST /api/auth/resend-verification-email { email }` → always `200 { message }`.
  - `POST /api/auth/login` failure response gains an optional `reason: "unverified"` field alongside the existing `message`. Task 4 depends on this exact field name.

- [ ] **Step 1: Add the new storage interface methods**

In `server/storage.ts`, inside the `IStorage` interface, immediately after the existing `getUserByEmail(email: string): Promise<User | undefined>;` line, add:

```ts
  getUserByVerificationToken(token: string): Promise<User | undefined>;
  verifyUserEmail(userId: number): Promise<void>;
  setEmailVerificationToken(userId: number, token: string, expiresAt: Date): Promise<void>;
```

- [ ] **Step 2: Implement them in `DbStorage`**

In `server/storage.ts`, inside the `DbStorage` class, immediately after the existing `getUserByEmail` method, add:

```ts
  async getUserByVerificationToken(token: string): Promise<User | undefined> {
    const [row] = await db.select().from(users).where(eq(users.emailVerificationToken, token));
    return row;
  }

  async verifyUserEmail(userId: number): Promise<void> {
    await db
      .update(users)
      .set({ emailVerified: true, emailVerificationToken: null, emailVerificationTokenExpiresAt: null })
      .where(eq(users.id, userId));
  }

  async setEmailVerificationToken(userId: number, token: string, expiresAt: Date): Promise<void> {
    await db
      .update(users)
      .set({ emailVerificationToken: token, emailVerificationTokenExpiresAt: expiresAt })
      .where(eq(users.id, userId));
  }
```

- [ ] **Step 3: Add the `emailVerified` check to the login strategy**

In `server/auth.ts`, replace:

```ts
      const valid = await comparePassword(password, user.passwordHash);
      if (!valid) {
        return done(null, false, { message: "Invalid email or password" });
      }
      return done(null, user);
```

with:

```ts
      const valid = await comparePassword(password, user.passwordHash);
      if (!valid) {
        return done(null, false, { message: "Invalid email or password" });
      }
      if (!user.emailVerified) {
        return done(null, false, { message: "Please verify your email before logging in.", reason: "unverified" });
      }
      return done(null, user);
```

- [ ] **Step 4: Rewrite the register handler**

In `server/routes.ts`, add this import alongside the existing ones at the top of the file:

```ts
import crypto from "crypto";
import { sendVerificationEmail } from "./email";
```

Then replace the entire `app.post("/api/auth/register", ...)` handler:

```ts
  app.post("/api/auth/register", registerLimiter, async (req, res) => {
    try {
      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid input", errors: parsed.error.flatten() });
      }
      const { email, password, name, organizationName } = parsed.data;

      const existing = await storage.getUserByEmail(email);
      if (existing) {
        return res.status(409).json({ message: "An account with this email already exists" });
      }

      const passwordHash = await hashPassword(password);
      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const user = await storage.createUser({
        email,
        passwordHash,
        name: name ?? null,
        emailVerified: false,
        emailVerificationToken: token,
        emailVerificationTokenExpiresAt: expiresAt,
      });

      let slug = slugify(organizationName);
      let org = await storage.getOrganizationBySlug(slug);
      if (org) {
        // Slug collision: append the new user's id to keep it unique rather
        // than fail signup over a cosmetic slug clash.
        slug = `${slug}-${user.id}`;
      }
      const organization = await storage.createOrganization({ name: organizationName, slug });
      await storage.createMembership({ userId: user.id, organizationId: organization.id, role: "owner" });

      let emailSendFailed = false;
      try {
        await sendVerificationEmail({
          to: email,
          token,
          requestOrigin: `${req.protocol}://${req.get("host")}`,
        });
      } catch (emailError) {
        console.error("Failed to send verification email:", emailError);
        emailSendFailed = true;
      }

      return res.status(201).json({ status: "pending_verification", email, emailSendFailed });
    } catch (error) {
      console.error("Registration error:", error);
      return res.status(500).json({ message: "Failed to register" });
    }
  });
```

- [ ] **Step 5: Add `verify-email` and `resend-verification-email` endpoints**

In `server/routes.ts`, immediately after the register handler (before the `app.post("/api/auth/login", ...)` block), add a rate limiter and the two new routes:

```ts
  const resendVerificationLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many requests, try again later." },
  });

  app.post("/api/auth/verify-email", async (req, res) => {
    const parsed = z.object({ token: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid input" });
    }
    const user = await storage.getUserByVerificationToken(parsed.data.token);
    if (!user) {
      return res.status(400).json({ message: "This verification link is invalid or has expired." });
    }
    if (!user.emailVerificationTokenExpiresAt || user.emailVerificationTokenExpiresAt < new Date()) {
      return res.status(400).json({ message: "This verification link is invalid or has expired." });
    }
    await storage.verifyUserEmail(user.id);
    return res.status(204).end();
  });

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
```

- [ ] **Step 6: Forward `reason` from the login handler**

In `server/routes.ts`, replace the existing login handler:

```ts
  app.post("/api/auth/login", loginLimiter, (req, res, next) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid input", errors: parsed.error.flatten() });
    }
    passport.authenticate("local", (err: unknown, user: Express.User | false, info: { message?: string }) => {
      if (err) return next(err);
      if (!user) return res.status(401).json({ message: info?.message || "Invalid email or password" });
      req.login(user, (loginErr) => {
        if (loginErr) return next(loginErr);
        return res.json({ user: { id: user.id, email: user.email, name: user.name } });
      });
    })(req, res, next);
  });
```

with:

```ts
  app.post("/api/auth/login", loginLimiter, (req, res, next) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid input", errors: parsed.error.flatten() });
    }
    passport.authenticate(
      "local",
      (err: unknown, user: Express.User | false, info: { message?: string; reason?: string }) => {
        if (err) return next(err);
        if (!user) {
          return res.status(401).json({ message: info?.message || "Invalid email or password", reason: info?.reason });
        }
        req.login(user, (loginErr) => {
          if (loginErr) return next(loginErr);
          return res.json({ user: { id: user.id, email: user.email, name: user.name } });
        });
      },
    )(req, res, next);
  });
```

- [ ] **Step 7: Run the type checker**

Run: `npm run check`
Expected: no errors.

- [ ] **Step 8: Update `scripts/verify-branch.mjs` to exercise the new gate**

In `scripts/verify-branch.mjs`, replace the `// --- register ---` block inside `step5_smokeTest`:

```js
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
```

with:

```js
  // --- register (no session until verified) ---
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
    const body = await res.json().catch(() => ({}));
    const noCookie = !res.headers.get("set-cookie");
    if (res.status === 201 && body.status === "pending_verification" && noCookie) {
      ok("POST /api/auth/register", "201, pending_verification, no session cookie");
    } else {
      fail("POST /api/auth/register", `status ${res.status}, body ${JSON.stringify(body)}`);
    }
  }

  // --- verify email (token pulled directly from the DB -- this script has
  // no inbox to click a real link from) ---
  {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    let token;
    try {
      const res = await pool.query("SELECT email_verification_token FROM users WHERE email = $1", [TEST_EMAIL]);
      token = res.rows[0]?.email_verification_token;
    } finally {
      await pool.end();
    }
    if (!token) {
      fail("verify-email setup", "no email_verification_token found for the test user");
    } else {
      const res = await fetch(`${BASE_URL}/api/auth/verify-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (res.status === 204) ok("POST /api/auth/verify-email", "204");
      else fail("POST /api/auth/verify-email", `expected 204, got ${res.status}`);
    }
  }

  // --- login (register no longer starts a session -- this is now the
  // only way this script gets a session cookie) ---
  {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    if (res.status === 200 && cookie) ok("POST /api/auth/login", "200, session cookie received");
    else fail("POST /api/auth/login", `expected 200 + cookie, got ${res.status}`);
  }
```

- [ ] **Step 9: Run the smoke test**

Run: `npm run verify`
Expected: all steps pass (one more than before: the new verify-email step). Look for `[verify] N passed, 0 failed` with `N` one higher than the previous baseline of 17 (18 — register, verify-email, login, me, and the rest unchanged).

- [ ] **Step 10: Commit**

```bash
git add server/storage.ts server/routes.ts server/auth.ts scripts/verify-branch.mjs
git commit -m "feat: gate registration behind email verification"
```

---

## Task 4: Frontend — check-email state, verify page, login gate UI

**Files:**
- Modify: `client/src/lib/queryClient.ts`, `client/src/hooks/use-auth.tsx`, `client/src/pages/Register.tsx`, `client/src/pages/Login.tsx`, `client/src/App.tsx`
- Create: `client/src/pages/VerifyEmail.tsx`

**Interfaces:**
- Consumes: `POST /api/auth/register` → `{ status, email, emailSendFailed }`; `POST /api/auth/verify-email { token }`; `POST /api/auth/resend-verification-email { email }`; login 401 body's `reason` field — all from Task 3.
- Produces: nothing consumed by a later task (this is the last task in the chain).

- [ ] **Step 1: Attach the `reason` field to thrown API errors**

In `client/src/lib/queryClient.ts`, replace `throwIfResNotOk`:

```ts
async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    let message = `${res.status}: ${text}`;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.message === "string") {
        message = parsed.message;
      }
    } catch {
      // not JSON, or no .message field -- keep the raw text fallback above
    }
    throw new Error(message);
  }
}
```

with:

```ts
async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    let message = `${res.status}: ${text}`;
    let reason: string | undefined;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.message === "string") {
        message = parsed.message;
      }
      if (parsed && typeof parsed.reason === "string") {
        reason = parsed.reason;
      }
    } catch {
      // not JSON, or no .message field -- keep the raw text fallback above
    }
    const error = new Error(message) as Error & { reason?: string };
    if (reason) error.reason = reason;
    throw error;
  }
}
```

- [ ] **Step 2: Update `use-auth.tsx`'s register mutation to return the response body**

In `client/src/hooks/use-auth.tsx`, add this interface near the other input interfaces (after `LoginInput`):

```ts
interface RegisterResult {
  status: "pending_verification";
  email: string;
  emailSendFailed: boolean;
}
```

Change the `register` field's type in `AuthContextValue`:

```ts
  register: (input: RegisterInput) => Promise<void>;
```

to:

```ts
  register: (input: RegisterInput) => Promise<RegisterResult>;
```

Replace the `registerMutation` definition:

```ts
  const registerMutation = useMutation({
    mutationFn: async (input: RegisterInput) => {
      const res = await apiRequest("POST", "/api/auth/register", input);
      return res.json();
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
    },
  });
```

with:

```ts
  const registerMutation = useMutation({
    mutationFn: async (input: RegisterInput): Promise<RegisterResult> => {
      const res = await apiRequest("POST", "/api/auth/register", input);
      return res.json();
    },
    // No /api/auth/me invalidation here -- registration no longer starts a
    // session (see server/routes.ts), so there is nothing new for that
    // query to pick up until the user actually verifies and logs in.
  });
```

Replace the `register` entry inside the returned `value` object:

```ts
    register: async (input) => {
      await registerMutation.mutateAsync(input);
    },
```

with:

```ts
    register: async (input) => {
      return await registerMutation.mutateAsync(input);
    },
```

- [ ] **Step 3: Rewrite `Register.tsx` to show a check-email state**

Replace the entire contents of `client/src/pages/Register.tsx`:

```tsx
import { useState } from "react";
import { Link } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { MailCheck } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import AuthLayout from "@/components/auth/AuthLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { apiRequest } from "@/lib/queryClient";

const registerFormSchema = z.object({
  organizationName: z.string().min(1, "Organization name is required"),
  name: z.string().optional(),
  email: z.string().email("Enter a valid email"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .regex(/[a-z]/, "Password must include a lowercase letter")
    .regex(/[A-Z]/, "Password must include an uppercase letter")
    .regex(/[0-9]/, "Password must include a number"),
});

type RegisterFormValues = z.infer<typeof registerFormSchema>;

export default function Register() {
  const { register, registerPending } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [emailSendFailed, setEmailSendFailed] = useState(false);
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent">("idle");

  const form = useForm<RegisterFormValues>({
    resolver: zodResolver(registerFormSchema),
    defaultValues: { organizationName: "", name: "", email: "", password: "" },
  });

  const onSubmit = async (values: RegisterFormValues) => {
    setError(null);
    try {
      const result = await register(values);
      setPendingEmail(result.email);
      setEmailSendFailed(result.emailSendFailed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to register");
    }
  };

  const resend = async () => {
    if (!pendingEmail) return;
    setResendState("sending");
    try {
      await apiRequest("POST", "/api/auth/resend-verification-email", { email: pendingEmail });
    } finally {
      setResendState("sent");
    }
  };

  if (pendingEmail) {
    return (
      <AuthLayout heading="Check your email" subheading="One more step before your account is ready.">
        <div className="space-y-4">
          <div className="flex items-center gap-3 text-neutral-700">
            <MailCheck className="h-8 w-8 text-primary shrink-0" />
            {emailSendFailed ? (
              <p>
                We couldn't send that email just now. Use the button below to try sending it again to{" "}
                <span className="font-medium">{pendingEmail}</span>.
              </p>
            ) : (
              <p>
                We've sent a verification link to <span className="font-medium">{pendingEmail}</span>. Verify
                within 24 hours, or this registration will be removed and you'll need to sign up again.
              </p>
            )}
          </div>
          <Button
            type="button"
            variant={emailSendFailed ? "default" : "outline"}
            className="w-full"
            onClick={resend}
            disabled={resendState === "sending"}
          >
            {resendState === "sending" ? "Sending..." : resendState === "sent" ? "Sent — check your inbox" : "Resend email"}
          </Button>
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
    <AuthLayout
      heading="Create your account"
      subheading="Set up your organization and start tracking Scope 1, 2 & 3 emissions in minutes."
    >
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="space-y-2">
          <Label htmlFor="organizationName">Organization name</Label>
          <Input id="organizationName" autoComplete="organization" {...form.register("organizationName")} />
          {form.formState.errors.organizationName && (
            <p className="text-sm text-destructive">{form.formState.errors.organizationName.message}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="name">Your name (optional)</Label>
          <Input id="name" autoComplete="name" {...form.register("name")} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="email" {...form.register("email")} />
          {form.formState.errors.email && (
            <p className="text-sm text-destructive">{form.formState.errors.email.message}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" autoComplete="new-password" {...form.register("password")} />
          {form.formState.errors.password ? (
            <p className="text-sm text-destructive">{form.formState.errors.password.message}</p>
          ) : (
            <p className="text-xs text-neutral-500">At least 8 characters, with uppercase, lowercase, and a number.</p>
          )}
        </div>
        <Button type="submit" className="w-full" disabled={registerPending}>
          {registerPending ? "Creating account..." : "Create account"}
        </Button>
      </form>
      <p className="text-sm text-neutral-600 mt-6 text-center">
        Already have an account?{" "}
        <Link href="/login" className="text-primary font-medium hover:underline">
          Log in
        </Link>
      </p>
    </AuthLayout>
  );
}
```

- [ ] **Step 4: Create `VerifyEmail.tsx`**

Create `client/src/pages/VerifyEmail.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, Loader2 } from "lucide-react";
import AuthLayout from "@/components/auth/AuthLayout";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { apiRequest } from "@/lib/queryClient";

type Phase = "verifying" | "success" | "failed";

export default function VerifyEmail() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const email = searchParams.get("email") ?? "";
  const [phase, setPhase] = useState<Phase>("verifying");
  const firedRef = useRef(false);

  const verifyMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/auth/verify-email", { token });
    },
  });

  const resendMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/auth/resend-verification-email", { email });
    },
  });

  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    if (!token) {
      setPhase("failed");
      return;
    }
    verifyMutation.mutate(undefined, {
      onSuccess: () => setPhase("success"),
      onError: () => {
        setPhase("failed");
        if (email) resendMutation.mutate();
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase === "verifying") {
    return (
      <AuthLayout heading="Verifying your email" subheading="This will just take a moment.">
        <div className="flex justify-center py-8">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </AuthLayout>
    );
  }

  if (phase === "success") {
    return (
      <AuthLayout heading="Email verified" subheading="Your account is ready.">
        <div className="space-y-4">
          <div className="flex items-center gap-3 text-neutral-700">
            <CheckCircle2 className="h-8 w-8 text-primary shrink-0" />
            <p>You're all set — you can log in now.</p>
          </div>
          <Button asChild className="w-full">
            <Link href="/login">Log in</Link>
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout heading="That link has expired" subheading="Here's how to get back on track.">
      <div className="space-y-4">
        <Alert>
          <AlertDescription>
            {email
              ? `We've sent a fresh verification link to ${email} — check your inbox (and spam folder).`
              : "This verification link is invalid."}
          </AlertDescription>
        </Alert>
        <p className="text-sm text-neutral-600">
          Registered more than 2 days ago? That one's already been cleaned up — you'll need to start over.
        </p>
        <Button asChild className="w-full">
          <Link href="/register">Create a new account</Link>
        </Button>
        <p className="text-sm text-neutral-600 text-center">
          <Link href="/login" className="text-primary font-medium hover:underline">
            Back to log in
          </Link>
        </p>
      </div>
    </AuthLayout>
  );
}
```

- [ ] **Step 5: Add the `/verify-email` route**

In `client/src/App.tsx`, add the import:

```ts
import VerifyEmail from "@/pages/VerifyEmail";
```

and add the route above the existing `/register` route:

```tsx
      <Route path="/login" component={Login} />
      <Route path="/register" component={Register} />
      <Route path="/verify-email" component={VerifyEmail} />
```

- [ ] **Step 6: Add the "unverified" case to `Login.tsx`**

Replace the entire contents of `client/src/pages/Login.tsx`:

```tsx
import { useState } from "react";
import { useLocation, Link } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useAuth } from "@/hooks/use-auth";
import AuthLayout from "@/components/auth/AuthLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { apiRequest } from "@/lib/queryClient";

const loginFormSchema = z.object({
  email: z.string().email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});

type LoginFormValues = z.infer<typeof loginFormSchema>;

export default function Login() {
  const [, setLocation] = useLocation();
  const { login, loginPending } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent">("idle");

  const form = useForm<LoginFormValues>({
    resolver: zodResolver(loginFormSchema),
    defaultValues: { email: "", password: "" },
  });

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

  const resend = async () => {
    if (!unverifiedEmail) return;
    setResendState("sending");
    try {
      await apiRequest("POST", "/api/auth/resend-verification-email", { email: unverifiedEmail });
    } finally {
      setResendState("sent");
    }
  };

  return (
    <AuthLayout heading="Welcome back" subheading="Sign in to continue tracking your organization's emissions.">
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {unverifiedEmail && (
          <Alert>
            <AlertDescription className="space-y-2">
              <p>Please verify your email before logging in.</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={resend}
                disabled={resendState === "sending"}
              >
                {resendState === "sending" ? "Sending..." : resendState === "sent" ? "Sent — check your inbox" : "Resend verification email"}
              </Button>
            </AlertDescription>
          </Alert>
        )}
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="email" {...form.register("email")} />
          {form.formState.errors.email && (
            <p className="text-sm text-destructive">{form.formState.errors.email.message}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" autoComplete="current-password" {...form.register("password")} />
          {form.formState.errors.password && (
            <p className="text-sm text-destructive">{form.formState.errors.password.message}</p>
          )}
        </div>
        <Button type="submit" className="w-full" disabled={loginPending}>
          {loginPending ? "Signing in..." : "Log in"}
        </Button>
      </form>
      <p className="text-sm text-neutral-600 mt-6 text-center">
        Don't have an account?{" "}
        <Link href="/register" className="text-primary font-medium hover:underline">
          Create one
        </Link>
      </p>
    </AuthLayout>
  );
}
```

- [ ] **Step 7: Run the type checker**

Run: `npm run check`
Expected: no errors.

- [ ] **Step 8: Manual browser verification — full loop with a real token**

1. Start the dev server: `npm run dev`
2. In a browser, go to `http://localhost:5000/register` and submit the form with a real, reachable test email and a valid-per-the-new-rules password (e.g. `TestPass123`).
3. Confirm the page switches to the "Check your email" state showing that email address.
4. In a separate terminal, pull the real token: `node -e "require('dotenv').config(); const {Pool}=require('pg'); const p=new Pool({connectionString:process.env.DATABASE_URL}); p.query(\"SELECT email_verification_token FROM users WHERE email=$1\", [process.argv[1]]).then(r=>{console.log(r.rows[0].email_verification_token); p.end();})" YOUR_TEST_EMAIL@example.com`
5. Navigate to `http://localhost:5000/verify-email?token=<token from step 4>&email=YOUR_TEST_EMAIL@example.com`. Confirm the "Email verified" success state renders, with a working "Log in" link.
6. Navigate to `http://localhost:5000/login`, log in with that email/password. Confirm it succeeds and lands on `/`.
7. Navigate to `http://localhost:5000/verify-email?token=not-a-real-token&email=YOUR_TEST_EMAIL@example.com`. Confirm the "That link has expired" failure state renders, with the resend confirmation message showing that email, plus the "Registered more than 2 days ago?" line and "Create a new account" button.
8. Clean up the test user afterward: `node -e "require('dotenv').config(); const {Pool}=require('pg'); const p=new Pool({connectionString:process.env.DATABASE_URL}); (async()=>{const u=await p.query('SELECT id FROM users WHERE email=$1',[process.argv[1]]); const uid=u.rows[0].id; const m=await p.query('SELECT organization_id FROM memberships WHERE user_id=$1',[uid]); const oid=m.rows[0].organization_id; await p.query('DELETE FROM organizations WHERE id=$1',[oid]); await p.query('DELETE FROM users WHERE id=$1',[uid]); await p.end();})()" YOUR_TEST_EMAIL@example.com`

- [ ] **Step 9: Commit**

```bash
git add client/src/lib/queryClient.ts client/src/hooks/use-auth.tsx client/src/pages/Register.tsx client/src/pages/Login.tsx client/src/pages/VerifyEmail.tsx client/src/App.tsx
git commit -m "feat: add check-email, verify-email, and unverified-login UI"
```

---

## Task 5: Cleanup cron endpoint + Vercel scheduling

**Files:**
- Modify: `server/storage.ts` (interface + implementation), `server/routes.ts` (new route), `vercel.json`, `.env.example`
- Create: `scripts/verify-cleanup-cron.mjs`

**Interfaces:**
- Consumes: `users`/`organizations`/`memberships` schema from Task 1 (already in place).
- Produces: `storage.deleteExpiredUnverifiedRegistrations(): Promise<number>`. `GET /api/cron/cleanup-unverified-users` → `200 { deletedCount: number }` (with a valid bearer token) or `401 { message }` (without one).

- [ ] **Step 1: Add the `lt` import and the cleanup storage method**

In `server/storage.ts`, change the top import line:

```ts
import { and, desc, eq, inArray, sql } from "drizzle-orm";
```

to:

```ts
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
```

Add to the `IStorage` interface, after `setEmailVerificationToken`:

```ts
  deleteExpiredUnverifiedRegistrations(): Promise<number>;
```

Add to the `DbStorage` class, after `setEmailVerificationToken`:

```ts
  async deleteExpiredUnverifiedRegistrations(): Promise<number> {
    const now = new Date();
    const expired = await db
      .select({ userId: users.id, organizationId: memberships.organizationId })
      .from(users)
      .innerJoin(memberships, eq(memberships.userId, users.id))
      .where(and(eq(users.emailVerified, false), lt(users.emailVerificationTokenExpiresAt, now)));

    if (expired.length === 0) return 0;

    const orgIds = [...new Set(expired.map((r) => r.organizationId))];
    const userIds = [...new Set(expired.map((r) => r.userId))];

    // organizations.id cascades to memberships (see shared/schema.ts), so
    // deleting the org already clears its membership row(s). Deleting the
    // users afterward is defensive -- in case a user row ever exists
    // without a membership, which shouldn't happen given registration
    // always creates exactly one, but this keeps the sweep correct even if
    // that ever changes.
    await db.delete(organizations).where(inArray(organizations.id, orgIds));
    await db.delete(users).where(inArray(users.id, userIds));

    return userIds.length;
  }
```

- [ ] **Step 2: Add the cron endpoint**

In `server/routes.ts`, add this route — placement doesn't matter relative to the auth routes, but keep it grouped with them since it also touches `users`/`organizations`. Add it right after the `resend-verification-email` route from Task 3:

```ts
  app.get("/api/cron/cleanup-unverified-users", async (req, res) => {
    const expected = process.env.CRON_SECRET;
    const authHeader = req.get("authorization");
    if (!expected || authHeader !== `Bearer ${expected}`) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const deletedCount = await storage.deleteExpiredUnverifiedRegistrations();
    return res.status(200).json({ deletedCount });
  });
```

- [ ] **Step 3: Schedule it in `vercel.json`**

Read the current `vercel.json`, then add a `"crons"` array alongside the existing keys:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "buildCommand": "vite build && esbuild server/vercel-entry.ts --platform=node --packages=external --external:./vite-dev --bundle --format=esm --outfile=api/index.js",
  "outputDirectory": "dist/public",
  "rewrites": [
    { "source": "/api/:path*", "destination": "/api" },
    { "source": "/((?!api/).*)", "destination": "/index.html" }
  ],
  "crons": [{ "path": "/api/cron/cleanup-unverified-users", "schedule": "0 3 * * *" }]
}
```

- [ ] **Step 4: Add `CRON_SECRET` to `.env.example`**

Add to `.env.example`, after the `EMAIL_FROM` line added in Task 2:

```
# Shared secret for the /api/cron/cleanup-unverified-users endpoint. Vercel
# sends this automatically as "Authorization: Bearer <value>" on its own
# scheduled invocations once this is set as a Production env var -- generate
# any random string, e.g.: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
CRON_SECRET=
```

- [ ] **Step 5: Add `CRON_SECRET` to your local `.env`**

Manual step: generate a value with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and add it to `.env` as `CRON_SECRET=<value>`.

- [ ] **Step 6: Run the type checker**

Run: `npm run check`
Expected: no errors.

- [ ] **Step 7: Write the standalone cleanup test script**

Create `scripts/verify-cleanup-cron.mjs`:

```js
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
```

- [ ] **Step 8: Run it**

With `npm run dev` running in another terminal, run: `node scripts/verify-cleanup-cron.mjs`
Expected: `[verify-cleanup-cron] 5 passed, 0 failed`.

- [ ] **Step 9: Run the main smoke test once more to confirm nothing regressed**

Run: `npm run verify`
Expected: `[verify] 18 passed, 0 failed` (unchanged from Task 3's Step 9 — this task didn't touch anything that flow depends on).

- [ ] **Step 10: Commit**

```bash
git add server/storage.ts server/routes.ts vercel.json .env.example scripts/verify-cleanup-cron.mjs
git commit -m "feat: add daily cleanup of expired unverified registrations"
```

---

## After merging: Vercel environment variables

Not a code task — a reminder for whoever merges this branch, since Vercel deployment is entirely external to this plan's file changes:

- Add `RESEND_API_KEY`, `EMAIL_FROM` (optional), and `CRON_SECRET` to the Vercel project's environment variables, same pattern as `DATABASE_URL`/`SESSION_SECRET` earlier in this project's history — `RESEND_API_KEY`/`EMAIL_FROM` go in both Preview and Production; `CRON_SECRET` only needs Production, since Vercel Cron only ever triggers against Production deployments.
- After merging to `main`, confirm the cron job appears under the project's Cron Jobs settings in the Vercel dashboard, and that its schedule reads `0 3 * * *`.
