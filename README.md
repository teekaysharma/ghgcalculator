# GHG Emissions Calculator

A comprehensive tool for tracking and analyzing Scope 1, 2, and 3 carbon emissions with support for advanced features like multi-year comparisons, product intensity metrics, and waste management tracking.

## `saas-multitenant` branch

This branch rebuilds the persistence and identity layer on top of the working calculator (calculation logic, UI, xlsx upload, and CSV export are unchanged from `main`). What changed:

- **Multi-tenancy**: `organizations`, `users`, and `memberships` (join table, roles: owner/admin/member). Every tenant-scoped table carries `organization_id`; every query in `server/storage.ts` filters on it.
- **Persistence**: `MemStorage` (in-memory, discarded on every request) is replaced with `DbStorage`, backed by Postgres via `@neondatabase/serverless` + `drizzle-orm`. Emission factors (`emission_factors` table) and calculation results (`emission_records` table) now persist, scoped to tenant.
- **Auth**: `passport-local` + `express-session` + `connect-pg-simple`, previously installed but unused. Passwords are hashed with bcrypt. Sessions are stored in Postgres, not memory.
- **API**: every route now requires authentication (`requireAuth`) and resolves the caller's organization (`requireOrg`) before touching any tenant-scoped data.

### Setup

1. Create a free Neon project at [console.neon.tech](https://console.neon.tech) and copy the connection string from **Connection Details**.
2. `cp .env.example .env` and fill in `DATABASE_URL` and a generated `SESSION_SECRET` (command is in the file's comments). Also fill in `RESEND_API_KEY` (from [resend.com](https://resend.com), used to send registration-verification emails — see "Registration hardening" below) and `CRON_SECRET` (any random string; authorizes the daily cleanup cron). `EMAIL_FROM` is optional, defaults to `onboarding@resend.dev`.
3. `npm install`
4. Apply the schema: `node scripts/manual-migration-001.mjs`. This creates/updates all tables (`organizations`, `users`, `memberships`, `emission_factors`, `emission_records`, `reporting_entities`, `facilities`, `reporting_boundaries`) directly against `DATABASE_URL`, idempotent, safe to re-run. **Do not use `npm run db:push`** — see [MIGRATIONS.md](./MIGRATIONS.md) for why (`drizzle-kit push` failed repeatedly against this schema in testing, confirmed to be a tool issue, not a data or state issue). The `session` table used by `connect-pg-simple` is created automatically on first server start (`createTableIfMissing: true`), no separate step needed.
5. `npm run dev`

### One-shot verification: `npm run verify`

Runs `npm install`, verifies the schema matches `shared/schema.ts` (does not apply migrations itself, run `node scripts/manual-migration-001.mjs` first if this is a fresh database), starts the dev server, then runs a real end-to-end smoke test against the live server (register, fetch session, create a reporting entity/facility/reporting boundary, confirm setup status, create an emission factor, list it back, run a calculation with `persist: true`, confirm it was actually saved, log out), then reverts: stops the server and deletes only the rows that specific run created, tagged by a unique per-run identifier. It does not touch your schema or any other data.

Requires `.env` to already exist and be filled in (step 1-2 above are still manual, on purpose, since `DATABASE_URL` is a live credential this script deliberately never generates or guesses). Exits non-zero if any step fails, with the specific failing step printed.

Works on Windows, macOS, and Linux (uses `taskkill /T` to fully stop the server process tree on Windows, since a plain kill leaves the underlying node process running under Windows' `cmd.exe` wrapper).

### New endpoints

- `POST /api/auth/register` — `{ email, password, name?, organizationName }`. Creates a user, an organization, and an owner membership in one call. Password must be 8+ chars with upper/lower/number. Does not start a session — see "Registration hardening" below.
- `POST /api/auth/verify-email` — `{ token }`. Marks the account verified; required before login succeeds.
- `POST /api/auth/resend-verification-email` — `{ email }`. Always returns a generic 200 (no account-enumeration signal), rate-limited to 5/hour.
- `POST /api/auth/login` — `{ email, password }`. Rejects with `401 { reason: "unverified" }` if the account hasn't verified its email yet, or `401 { reason: "deactivated" }` if the account has been deactivated.
- `POST /api/auth/logout`
- `GET /api/auth/me` — current user + the organizations they have **active** access to (a deactivated membership is filtered out here exactly as `requireOrg` filters it, so the client can never label a page with an org it isn't actually being served).
- `POST /api/auth/forgot-password` — `{ email }`. Always returns a generic 200 (no account-enumeration signal), rate-limited to 5/hour; only issues a token for a verified account.
- `POST /api/auth/reset-password` — `{ token, newPassword }`. Sets the new password and marks the account verified, which is also how a changed email address gets claimed. See "Membership and account lifecycle" below.
- `GET /api/cron/cleanup-unverified-users` — deletes registrations left unverified 24h+. Requires `Authorization: Bearer <CRON_SECRET>`; triggered daily by Vercel Cron (`vercel.json`), Production only.
- `GET /api/emission-factors`, `POST /api/emission-factors`, `DELETE /api/emission-factors/:id` — tenant-scoped, requires auth
- `GET /api/emission-records` — tenant-scoped, requires auth
- `GET/POST/PUT/DELETE /api/reporting-entities` — the entity being measured (e.g. the client company a tenant is reporting GHG data for). Tenant-scoped.
- `GET/POST/PUT/DELETE /api/facilities` — belongs to a reporting entity, unique name per entity.
- `GET/POST/PUT/DELETE /api/reporting-boundaries` — belongs to a reporting entity, one per (entity, reportingYear).
- `GET /api/setup-status` — `{ reportingEntityCount, facilityCount, boundaryCount, readyForCalculation }` for the caller's tenant.
- `GET /api/team` — list org members. `POST /api/team/invite` — `{ email, role? }`, adds an existing user to the org, owner/admin only.
- Existing `/api/calculate`, `/api/download-csv`, `/api/yearly-comparison`, `/api/product-intensity` are unchanged in behavior but now require auth. `/api/calculate` additionally accepts `persist: true` in the request body to save results to `emission_records`; the existing calculator UI does not send this flag yet, so current behavior (compute and return, nothing saved) is preserved unless a caller opts in. **`/api/calculate` now also requires setup completeness**: at least one reporting entity, facility, and reporting boundary must exist for the tenant, or it returns 400. See "Reconciled from codex" below.
- `GET /api/admin/users` — search/paginate accounts across every tenant (`?search=&limit=&offset=`). Super-admin only.
- `POST /api/admin/users/:id/verify` — manually mark a pending account verified. Super-admin only.
- `DELETE /api/admin/users/:id` — delete a pending/unverified account (and its own solo-owned organization); `409` if the account has ever been verified (`users.has_been_verified`, not its current `email_verified` — see "Membership and account lifecycle" below). Super-admin only.
- `POST /api/admin/users/:id/promote` — grant another verified account super-admin access. Super-admin only.
- `POST /api/admin/users/:id/demote` — `{ note }`. Revoke a super-admin's access; requires a non-empty `note` explaining why, and a super-admin can never demote themselves. Super-admin only.
- `GET /api/admin/action-log` — the most recent admin actions (actor, target, organization, note, timestamp). Super-admin only.
- `POST /api/admin/memberships/:id/deactivate` — `{ note }` — / `POST /api/admin/memberships/:id/activate` — revoke or restore one user's access to one organization, without touching their login. Super-admin only.
- `POST /api/admin/users/:id/deactivate` — `{ note }` — / `POST /api/admin/users/:id/reactivate` — block or restore the login itself, across every organization. Deactivate rejects a self-target (`403`) and an unverified account (`400`, delete it instead). Super-admin only.
- `POST /api/admin/users/:id/change-email` — `{ newEmail, note }`. Reassigns the address and emails a set-a-password link to it; nobody ever types or shares a password. Super-admin only.
- `POST /api/admin/users/:id/reset-password` — `{ note }`. Emails a password-reset link to the account's current address. Super-admin only.
- `GET /api/team` — now also reports each member's account-level `accountIsActive` alongside their membership `isActive`.
- `POST /api/team/memberships/:id/deactivate|activate`, `POST /api/team/members/:id/deactivate|reactivate|change-email|reset-password`, `GET /api/team/action-log` — the org-admin self-service tier of the above, scoped to the caller's own organization. See "Membership and account lifecycle" below for the boundary rules.

### Reconciled from `codex/review-code-for-gaps-and-improvements`

That branch (32 commits) independently built ISO 14064-1 boundary-setting concepts (reporting entity, facility, reporting boundary, consolidation approach) on top of `MemStorage` + a JSON-file snapshot, no tenant scoping, no real DB tables. Ported here as real Postgres tables, tenant-scoped like everything else on this branch.

**Naming collision, resolved:** that branch called the entity being measured "Organization", which collides with this branch's `organizations` table (the SaaS tenant / paying customer account). These are different concepts — one tenant can report on one or more reporting entities (e.g. a consultancy tenant reporting for several client companies). Renamed to `ReportingEntity` / `reporting_entities` here to keep them permanently distinct. If you're comparing against the `codex` branch directly, `Organization` there = `ReportingEntity` here.

Also ported: `scope3Category` on emission inputs/records, `source`/`year` on emission factors, and a CSV-escaping fix (commas/quotes/newlines in values were previously unescaped, which could corrupt exported CSVs or, worse, enable CSV injection if opened in Excel).

**Not yet ported:** the `SetupBoundaryPanel.tsx` UI (478 lines on `codex`) that gates the calculator UI on setup completeness. The backend gate above is live; nothing in the current UI creates a reporting entity/facility/boundary yet, so the existing calculator will get a 400 from `/api/calculate` until either that UI is ported and adapted for auth/tenancy, or a new one is built against these endpoints.

### New frontend (this session)

- `/login`, `/register` pages, `useAuth()` context, and `ProtectedRoute` gating `/`. This was the actual blocker for using the app in a browser at all, closed now.
- `SetupPanel` — walks through creating a reporting entity, facility, and reporting boundary, matches `/api/setup-status`'s `readyForCalculation` logic exactly, renders the calculator once complete. Not a port of `codex`'s `SetupBoundaryPanel.tsx` — that one predates auth/tenancy and targeted a different API shape, this is a fresh implementation against the current endpoints.
- `TeamPanel` — lists org members, lets owner/admin add an *existing* user by email. No email delivery, no invite tokens, the invited person has to register themselves first. Stated in the UI itself, not hidden.
- `EmissionCalculator` now sends `persist: true` on every calculation — previously computed and discarded even after the backend supported persistence.
- `/admin` — standalone, cross-tenant page (not part of any organization's UI) visible only to a super-admin, reachable via a nav link next to logout that only renders when `user.isSuperAdmin`. See "Platform admin panel" below.

### Registration hardening (redesign-auth-pages branch, merged into main)

Two related changes shipped together: a branded redesign of `/login` and `/register` (shared `AuthLayout`, value-prop copy — was previously a bare unstyled form), and hardening of registration itself:

- **Password complexity**: 8+ chars, at least one uppercase, one lowercase, one number. Enforced client- and server-side (`shared/schema.ts`'s `registerSchema`).
- **Email verification, required before login**: registering no longer starts a session. A 24h-expiring verification link is emailed via [Resend](https://resend.com) (`server/email.ts`); `/verify-email` handles success, an already-verified re-click (distinct "you're already verified" message, doesn't imply removal), and invalid/expired links (auto-resend + honest state-gated messaging, not a false "we sent it" claim). Login returns `401 { reason: "unverified" }` until the link is clicked.
- **Expired-registration cleanup**: a Vercel Cron job (`vercel.json`, daily, `GET /api/cron/cleanup-unverified-users`) deletes any registration left unverified past 24h — the organization and membership cascade-delete with the user (`shared/schema.ts`'s `onDelete: "cascade"`). Auth'd via `CRON_SECRET`, fails closed if unset.
- **Existing users grandfathered**: the migration (`scripts/manual-migration-012.mjs`) marks all pre-existing accounts as already-verified; only newly registered accounts are gated.

Built via this project's Subagent-Driven Development process (see `docs/superpowers/plans/2026-09-03-registration-hardening.md` and the paired design spec for the full history: task-by-task implementation, review, and one whole-branch review + fix wave before merge).

**Operational note:** the live Resend account is in sandbox/test mode — it can only deliver to its own account-owner email address until a sending domain is verified at [resend.com/domains](https://resend.com/domains). Until that's done, real registrants (anyone other than the account owner) will get `emailSendFailed: true` on the register response and no email.

### Platform admin panel (`super-admin-panel` branch)

Adds a platform-wide `isSuperAdmin` flag on `users`, distinct from the existing per-organization `owner`/`admin`/`member` roles in `memberships.role` (those are scoped to one tenant; `isSuperAdmin` isn't). A super-admin gets a new `/admin` page — not part of any organization's UI — listing every account across every tenant, searchable and paginated, with actions to manually verify a stuck pending registration, delete one outright (pending/unverified accounts only, never a verified/active tenant), promote another verified account to super-admin, or demote a super-admin back to a normal account (a required note is recorded with every demotion; a super-admin can never demote themselves). Every verify/delete/promote/demote action is written to `admin_action_log`, readable via `GET /api/admin/action-log` and shown in the panel itself.

**Operational note:** there is no self-serve way to create the very first super-admin — it must be seeded manually. Register an account with the exact email `teekaysharma@googlemail.com` through the running app, then run `node scripts/manual-migration-013.mjs` (idempotent, safe to re-run) to seed `isSuperAdmin = true` for that account. The seed is self-healing (it fires whenever no super-admin currently exists), so re-running the script after that account registers — or after the platform is ever reset back to zero super-admins — will seed it; it will not fire again, and will not overwrite anyone's status, once at least one super-admin already exists. Once seeded, that account can promote any other verified account to super-admin from the panel.

### Membership and account lifecycle (`super-admin-panel` branch)

The second feature on this branch, layered on the admin panel above: two tiers of control over who can get in and where, plus the password-reset mechanism both tiers depend on. Design spec: `docs/superpowers/specs/2026-09-04-membership-lifecycle-management-design.md`.

**Membership vs account — two different switches.** A *membership* (`memberships.is_active`) is one user's access to one organization; an *account* (`users.is_active`) is the login itself. Deactivating a membership revokes access to that organization only, leaves any others intact, and is re-resolved on every single request (`requireOrg` reads active memberships fresh, never anything cached on the session). Deactivating an account blocks login platform-wide and also drops any session that is already open, on its very next request (`deserializeUser` refuses to hydrate an inactive account). Neither is a delete: both have an explicit reactivate, and no tenant data is touched either way.

**Super-admin tier** (`/admin`, gated by `requireSuperAdmin`, cross-tenant): deactivate/reactivate a membership, deactivate/reactivate an account, change an account's email, or trigger a password reset for it — the `/api/admin/...` routes listed above. Every destructive action requires a non-empty note and is written to `admin_action_log` with the actor, target, organization and note, shown in the panel's own activity table. A super-admin cannot deactivate (or demote) their own account, so the platform can't be locked out of its own panel.

**Org-admin self-service tier** (`/api/team/...`, owner or admin of the caller's own organization). Membership actions here are scoped by organization id in the query itself, so a membership belonging to another tenant simply never matches (`404`, not `403`). Account-wide actions — deactivate, reactivate, change-email, reset-password — are additionally bounded by two rules:

- **The sole-organization rule.** An org-admin may only take account-wide action on a target whose memberships — active *or* inactive — resolve to exactly this one organization. The moment someone belongs to a second organization, only a super-admin can act on their account, because an org-admin has no authority over the other tenant that would also be affected. Deactivating the second membership does not reopen this: a relationship with another org, even a dormant one, is permanently out of an org-admin's reach.
- **The rank ceiling.** Never a platform super-admin (`users.is_super_admin`), and an org `admin` may never act on their own organization's `owner`. Without this, an admin invited into an org could change the owner's — or a resident super-admin's — email address, receive the set-a-password link, and take the account over.

Self-targeting is rejected on both tiers, and `TeamPanel` renders no action controls at all against your own row.

**Password reset, and how change-email uses it.** `/forgot-password` and `/reset-password` are the two new user-facing pages. A reset issues a single-use 24h token (`users.password_reset_token`); `POST /api/auth/reset-password` consumes it, sets the new password, and marks the account verified. Admin-triggered resets use the same mechanism, so an admin never types, sees, or transmits a password. change-email leans on it too: the address is reassigned, `email_verified` goes false, and the same set-a-password link is mailed to the new address — claiming it proves control of the new inbox and re-verifies the account in one step. All four notification routes report `emailSendFailed: true` rather than claiming success when the mail can't be delivered (see the Resend sandbox note above), and change-email sends its own copy, not the forgot-password body, because by then the account has already been altered.

**`users.has_been_verified`.** Because change-email deliberately sets `email_verified = false`, that column alone can't distinguish "never verified, disposable registration" from "verified years ago, mid re-verification". `has_been_verified` is the sticky answer to the first question: set the first time an account is ever verified and never cleared, untouched by change-email. Both hard-delete paths — `DELETE /api/admin/users/:id` and the daily unverified-registration cron sweep — gate on it, so a live tenant can't be dropped into the state either one reads as "safe to delete". Applied by `scripts/manual-migration-015.mjs`, which backfills every currently-verified account. The admin panel shows the two states as separate badges and offers no delete button for the second.

### Known gaps in this branch (not done, scoped honestly)

- No real invite flow (email delivery + signup-by-token). Current invite only attaches an already-registered account to an org.
- No rate limiting on `/api/team/invite` or other authenticated write endpoints (login/register/resend-verification are covered).
- The `X-Organization-Id` header path in `requireOrg` (for a user in more than one org) has no UI — not needed while it's one-org-per-user in practice, only relevant once someone's in multiple orgs.
- No UI test coverage — `npm run verify` exercises the API end-to-end but doesn't drive a browser. The UI changes in this session were type-checked and build-verified (`tsc --noEmit`, `npm run build`) but not click-tested by a human yet.
- No self-service way for a user to change their own email address, or to see that an admin changed it. Both tiers of change-email are admin-initiated only.
- No route for changing a member's *role* within an organization (owner/admin/member is set at invite time), and no route for deleting a membership outright — only deactivating it.
- Account deactivation withholds access from an existing session and passport clears that session's user on the next request, but the session rows themselves aren't purged from `connect-pg-simple`'s table; they age out naturally.
- Compliance/framework layer beyond ISO 14064-1 boundary setup (DEFRA integration, GHG Protocol/CDP/GRI/TCFD/BRSR-specific fields) is still out of scope per the project instructions.

## Features

- **Multi-Scope Emissions Tracking**: Calculate and track Scope 1, 2, and 3 greenhouse gas emissions
- **Multi-Year Comparison**: Track and visualize emissions trends over time
- **Product Intensity Metrics**: Calculate emissions per unit of production for various products
- **Waste Analysis**: Track emissions by waste type and disposal method
- **Flexible Data Import**: Support for various Excel file formats and column naming conventions
- **Visualization**: Charts and graphs for emissions data analysis

## Getting Started

### Prerequisites

- Node.js (v16 or higher)
- npm or yarn

### Installation

1. Unzip the downloaded file to a directory of your choice
2. Open a terminal/command prompt and navigate to the project directory
3. Install dependencies:

```bash
npm install
```

or if you use yarn:

```bash
yarn
```

### Running the Application

To start the development server:

```bash
npm run dev
```

This will launch both the backend server and the frontend application. The application will be available at `http://localhost:5000` in your web browser.

### Using the Application

1. **Upload Emission Factors**: Use the "Upload Emission Factors" section to import your Excel file with emission factors
2. **Enter Activity Data**: Enter your activity data in the appropriate scope tabs
3. **View Results**: The Results section will display your calculated emissions and visualizations

## Emission Factor File Format

The application supports various emission factor file formats:

1. **Standard format**: A simple table with columns for Activity Type, Emission Factor, and Unit
2. **Multi-scope format**: Data organized by scope (1, 2, or 3) using sheet names or a Scope column
3. **Waste-specific format**: Detailed tracking of waste types and disposal methods

For detailed format instructions, click the "Waste Factor Format Guide" button in the application.

## Support

# My Vite + Express App

This is a full-stack application using Vite (React) and Express.js backend.

## Scripts

- `npm run dev` — start development server
- `npm run build` — build client
- `npm start` — serve in production mode

## Deployment

Runs on port `5000`. Make sure `dist/public` exists before running in production.

## Build

```bash
npm install
npm run build
npm start





For questions or issues, please contact the development team.

## License

This project is licensed under the MIT License.