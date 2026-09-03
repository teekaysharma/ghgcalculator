# Registration Hardening: Password Complexity + Email Verification — Design

Session date: 2026-09-03. Branch to be created off `main` (post-merge of the Vercel serverless adaptation and the auth-page redesign). Triggered by a direct request after reviewing the redesigned login/register pages: prevent bogus/spam registrations by requiring password complexity and email verification before an account is fully active.

## Context and decisions made during brainstorming

- **No email-sending infrastructure exists in this codebase at all** — confirmed by grepping `package.json` for nodemailer/resend/sendgrid/postmark/mailgun/ses (zero matches) before designing anything. This is new infrastructure, not a wire-up of something half-built.
- **Email provider: Resend.** User's choice among Resend / SendGrid / AWS SES / other. User already has an API key as of this session (value not requested or stored in chat — goes into `.env` locally and Vercel's environment variables, Preview + Production, the same way `DATABASE_URL`/`SESSION_SECRET` were added earlier this session).
- **Password complexity: "Standard."** At least 8 characters (unchanged) plus at least one uppercase letter, one lowercase letter, and one number. No required special character — deliberately not "Strict," since forced special characters mostly just push people toward predictable substitutions (`P@ssw0rd`) rather than real entropy.
- **Verification gating: no session until verified.** Registration creates the user (and their organization + membership, unchanged) but does **not** call `req.login()` — no session, no immediate access. `Register.tsx` shows a "check your email" screen instead of redirecting into the app. This was chosen over "logged in immediately but limited" specifically because it maps most directly onto the stated goal (stop bogus registrations from ever getting a working session), and avoids needing to gate every API route by verification status.
- **Verification mechanism: click-through link, not a 6-digit code.** Zero typing, standard pattern for account verification (as opposed to login MFA codes, which is where code-entry is more common).
- **Existing users are grandfathered as already-verified.** The production database already has real registered users from before this feature. The migration marks every pre-existing row `email_verified = true`; the gate only applies going forward. (User explicitly rejected the alternative — forcing every existing user to re-verify — as unnecessarily disruptive with no specific suspicion behind it.)
- **Unverified registrations are garbage-collected, not left to accumulate forever.** Added after the initial design pass: any account still unverified once its 24-hour token window has passed — whether because the verification email failed to send, or it sent fine but nobody clicked it — gets deleted outright (user, organization, and membership), not just left dangling. One expiry condition covers both triggers named in the request ("email fails to send" and "not verified in 24 hours"): both eventually show up as the same state, `emailVerified = false` past its `emailVerificationTokenExpiresAt`. The user asked for this explicitly to free up space rather than let failed/abandoned signups pile up.

## Data model

One migration, following this project's established hand-written-idempotent-script convention (`MIGRATIONS.md`; `drizzle-kit push` was abandoned earlier in this project's history as unreliable for this schema — not revisited here). Three new columns on `users`:

```ts
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name"),
  emailVerified: boolean("email_verified").notNull().default(false),
  emailVerificationToken: text("email_verification_token"),
  emailVerificationTokenExpiresAt: timestamp("email_verification_token_expires_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

Migration script order (must run in this sequence, in one transaction):
1. `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;` (and the two companion nullable columns)
2. `UPDATE users SET email_verified = true WHERE email_verified = false;` — grandfathers every row that existed before this migration ran. Safe to also run against a fresh table with zero rows.

`registerSchema`'s password field gains complexity `.regex()` checks (see below); no other schema changes.

## Password complexity

`shared/schema.ts`, `registerSchema`:

```ts
password: z.string()
  .min(8, "Password must be at least 8 characters")
  .regex(/[a-z]/, "Password must include a lowercase letter")
  .regex(/[A-Z]/, "Password must include an uppercase letter")
  .regex(/[0-9]/, "Password must include a number"),
```

Enforced server-side (the schema already gates `POST /api/auth/register`) and mirrored client-side in `Register.tsx`'s own zod schema (kept in sync manually — this project doesn't currently share the client and server auth schemas, and introducing that coupling is out of scope here).

## Email sending

New `server/email.ts`, using the `resend` npm package (new dependency). One exported function:

```ts
export async function sendVerificationEmail(params: {
  to: string;
  token: string;
  requestOrigin: string; // e.g. "https://ghgcalculator.vercel.app", built from the request, not an env var
}): Promise<void>
```

**The verification link's base URL comes from the incoming request** (`${req.protocol}://${req.get("host")}`), not a hardcoded `APP_URL` env var. This app now genuinely runs from more than one origin — local dev, Vercel Preview (a new URL per branch), and Production — and a fixed env var would silently build broken links in at least two of those three. `req.get("host")` already reflects the real public host on Vercel because `trust proxy` is set (confirmed working this session for the secure-cookie fix; the same trust-proxy setting is what makes `req.protocol` correctly report `https` behind Vercel's TLS-terminating proxy too).

`EMAIL_FROM` env var, defaulting to Resend's `onboarding@resend.dev` sender if unset — works immediately with no domain verification, sufficient to build and test this feature. Sending from a custom domain later is a Resend dashboard step (domain verification + DNS records), not a code change, and stays out of this spec's scope.

The email body itself states the 24-hour deadline and its consequence explicitly — not just the on-screen copy (see Cleanup below) — e.g. *"This link expires in 24 hours. If you don't verify by then, this registration will be automatically removed and you'll need to sign up again."* Someone who reads the email later than they read the app (a very normal way to encounter this) should still learn the deadline from the one artifact they still have open.

New required env var: `RESEND_API_KEY`. Needs to be added to local `.env` and to both Preview and Production in Vercel's project settings, the same two-environment pattern already used for `DATABASE_URL`/`SESSION_SECRET`.

## Registration flow

`server/routes.ts`, `POST /api/auth/register` — same validation, user/org/membership creation as today, then:

1. Generate `token = crypto.randomBytes(32).toString("hex")` and `expiresAt = now + 24h`.
2. `storage.createUser(...)` gains `emailVerified: false`, `emailVerificationToken: token`, `emailVerificationTokenExpiresAt: expiresAt`.
3. `await sendVerificationEmail({ to: email, token, requestOrigin: ... })`, wrapped in try/catch. The account is never rolled back over a transient email-provider failure — it already exists in the database at this point, and the resend endpoint (below) gives the user a way to recover regardless of why the first send failed.
4. **No `req.login()` call.** Response becomes `201 { status: "pending_verification", email, emailSendFailed: boolean }` — deliberately not the `{ user, organization }` shape used today, since that shape implied an active session in the pre-existing frontend code. `emailSendFailed` is `true` only when the `sendVerificationEmail` call in step 3 threw; `Register.tsx`'s "check your email" screen checks this flag and, when true, leads with "we couldn't send that email — try resending" (the resend form, shown immediately) instead of "check your inbox." Either way, this screen states the same 24-hour deadline as the email (see Email sending above): *"Verify within 24 hours, or this registration will be removed and you'll need to sign up again."*

## Verification

New endpoint `POST /api/auth/verify-email { token }`:
- Looks up the user by `emailVerificationToken`. Token not found → `400`. Token found but `emailVerificationTokenExpiresAt` in the past → `400` with a distinct "expired" reason.
- On success: sets `emailVerified = true`, clears both token columns (single-use), returns `204`.
- **"Not found" and "expired" render the same message to the user**, even though the server distinguishes them. Once the cleanup job (below) has run, a genuinely expired token's row is simply gone, so a late click on that link reaches the "not found" branch, not "expired" — from the visitor's perspective these are the same outcome (the link no longer works) regardless of which side of that race they land on, so the frontend doesn't need to, and shouldn't, tell them apart.

New endpoint `POST /api/auth/resend-verification-email { email }`:
- Regardless of whether the email exists or is already verified, returns the same generic `200` response (`{ message: "If an account with that email needs verification, we've sent a new link." }`) — avoids confirming account existence to an unauthenticated caller.
- If the email does exist and is unverified: generates a new token + expiry (invalidating any old one), sends a new email.
- Rate-limited the same way `registerLimiter`/`loginLimiter` already rate-limit their routes (existing `express-rate-limit` pattern in `server/routes.ts`, reused rather than reinvented).

New frontend page `client/src/pages/VerifyEmail.tsx`, routed at `/verify-email` (new route added wherever `/login`/`/register` are registered): reads `?token=` from the URL on mount, immediately calls `POST /api/auth/verify-email`, and renders one of three states — verifying (spinner), success (confirmation + link to `/login`), or failed (one merged "not found or expired" message — see above — plus both a "resend verification email" form and a "register again" link, since a genuinely cleaned-up account needs the latter, not the former, and the page has no way to tell which one applies). The email itself links here — a real app page — rather than pointing directly at the API endpoint, because plain `GET` links get pre-fetched by corporate email-security scanners in many environments, which would silently burn a one-time token before the real recipient ever clicks it. Routing through a page that only fires the mutation from client-side JS on deliberate load avoids that.

`Register.tsx`: on the new `pending_verification` response, replace the `setLocation("/")` redirect with an inline "check your email" success state (same page, not a separate route — no form to show anymore, just confirmation + a resend link) instead of navigating away.

## Cleanup: expired unverified registrations

New endpoint `GET /api/cron/cleanup-unverified-users` in the same Express app as everything else (`server/routes.ts`) — no separate serverless function needed, since Vercel already routes all of `/api/*` to the one function (`api/index.js`) via the existing `/api/:path*` rewrite.

- Deletes every row where `email_verified = false AND email_verification_token_expires_at < now()`, and their dependent `memberships`/`organizations` rows — same dependency order already used by `scripts/verify-branch.mjs`'s own cleanup step (memberships and their org, then the user). Registration always creates a brand-new org for the registering user (no join-existing-org path exists yet — see the "future scope" comment already in `server/routes.ts` above the register handler), so an unverified user's org can never be shared with anyone else; deleting it alongside the user is always safe, not just usually safe.
- **Authenticated via Vercel's own cron convention**, not left open: reads the `CRON_SECRET` env var and requires the request's `Authorization: Bearer <CRON_SECRET>` header to match before doing anything. Vercel sends this header automatically on invocations it triggers itself once `CRON_SECRET` is set; without this check, the endpoint would be a public, unauthenticated bulk-delete trigger.
- Scheduled via `vercel.json`'s `crons` array, once daily:
  ```json
  "crons": [{ "path": "/api/cron/cleanup-unverified-users", "schedule": "0 3 * * *" }]
  ```
  Once a day is both sufficient (the window being enforced is 24 hours; nothing is gained by sweeping more often) and the practical ceiling on Vercel's Hobby plan, which this project is currently on (confirmed from the "Hobby" badge visible in this session's own dashboard screenshots) — Hobby-tier cron jobs cannot run more frequently than once per day.
- New required env var: `CRON_SECRET`, added to Vercel's Production environment (cron jobs only ever run against Production, never Preview, so it doesn't need to go in Preview's env vars the way `DATABASE_URL`/`SESSION_SECRET`/`RESEND_API_KEY` did).

This job's existence is also why the on-screen and email copy (above) can state the 24-hour deadline as a real, enforced consequence — "this registration will be automatically removed" — rather than an idle threat.

## Login

`server/auth.ts`, `LocalStrategy` — one added check, after password comparison succeeds and before `done(null, user)`:

```ts
if (!user.emailVerified) {
  return done(null, false, { message: "Please verify your email before logging in.", reason: "unverified" });
}
```

`Login.tsx` distinguishes this `reason: "unverified"` case from generic invalid-credentials failures and shows a "Resend verification email" link/button in that specific error state (pre-filled with the email they just typed), rather than the plain destructive alert used for wrong password.

## Test impact

`scripts/verify-branch.mjs`'s current flow (`POST /api/auth/register` → immediately expects a session cookie) breaks under the new gating by design — that's the whole point of the change. The script already opens a direct `pg.Pool` connection for its own cleanup step, so it gains one more step between register and the existing "me" check: `SELECT email_verification_token FROM users WHERE email = $1`, then `POST /api/auth/verify-email` with that token, then proceed to `POST /api/auth/login` (a call the script doesn't currently make at all, since register used to log in directly) before the existing `/api/auth/me` assertion. This exercises the real gate end-to-end rather than bypassing it, and keeps `npm run verify` as this project's actual regression gate for the auth flow, not a weakened stand-in for it.

The cleanup endpoint gets its own dedicated coverage, separate from the main smoke test (it deletes data — not something to run casually against real data on every `npm run verify` pass): register a second tagged test user, directly `UPDATE` its `email_verification_token_expires_at` to a past timestamp (no need to actually wait 24 hours), hit `GET /api/cron/cleanup-unverified-users` with the correct `CRON_SECRET` bearer token, and assert the user/membership/organization rows are gone. Also assert the endpoint rejects a request with a missing or wrong bearer token (`401`), and that it leaves a still-within-window unverified registration untouched (register a third user, don't expire it, confirm the cleanup run doesn't delete it).

## Out of scope

- Custom email domain / DKIM setup in Resend (dashboard work for later, not blocking this build).
- Sharing one zod schema between client and server for the password rule (currently duplicated by convention across this codebase's auth forms; not changing that pattern here).
- Rate-limiting or CAPTCHA on registration beyond what `registerLimiter` already does today — this spec's job is closing the "no verification at all" gap, not building broader anti-abuse tooling.
- Gating any existing API routes on `emailVerified` beyond login itself — chosen explicitly over "logged in but limited" during brainstorming.
- Configurable expiry window or cleanup schedule. Both are fixed (24 hours, once daily) rather than env-var-driven — nothing in this feature's requirements calls for tuning them, and Vercel Hobby's cron limits cap how often the sweep could even run.
