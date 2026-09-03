# Platform super-admin panel — design

## Context

Registration hardening (merged into `main` this session) gates every new account behind email verification via Resend. That surfaced a real operational gap: the live Resend account is in sandbox mode and can only deliver to its own account-owner address, so any other real user's verification email currently fails to send. Today the only fix is a raw SQL `UPDATE` against the live Neon database — there is no in-app way to view accounts across tenants, manually verify a stuck one, or clean up a pending registration outright.

This adds that capability: a platform-wide `isSuperAdmin` flag (distinct from the existing per-organization `owner`/`admin`/`member` roles in `memberships.role`, which are scoped to one tenant), a small internal `/admin` page listing every account across every tenant, and two actions — manually verify a pending account, or delete one.

Confirmed via full-repo grep that no super-admin/platform-admin/`isAdmin` concept exists anywhere today — this is genuinely new, not an extension of something partially built.

## Decisions

- **Delete is scoped to pending/unverified accounts only.** A verified/active tenant's organization cascades through all 19 tenant-scoped tables, and two tables (`emission_factors.uploaded_by`, `emission_records.created_by`) reference `users.id` with no cascade or null-out — deleting a user who's created data would hit a hard foreign-key failure. Removing a live tenant is a materially different, riskier problem, left out of scope.
- **A lightweight audit log is included.** Every verify/delete records who did it, to which account, when — this feature acts across other tenants' data, so that trail is worth having from day one.
- **Only one super-admin is seeded**, hardcoded by email (the project owner's account) in the migration. No self-serve promotion path — matches this project's existing vendor-only precedent for privileged operations (`scripts/grant-module.mjs`/`revoke-module.mjs`, deliberately no HTTP route). Promoting additional super-admins later needs a follow-up script or migration, not this feature's UI.
- **`admin_action_log` is write-only in v1** — no list/read endpoint. Matches the same precedent (`organization_modules` has no HTTP route either). Can be added later without any breaking change.
- **No pagination/search** on the account list — fine at current account volume.

## Data model

Two schema changes, applied via `scripts/manual-migration-013.mjs` (idempotent, transaction-wrapped, `information_schema` checks — same convention as every prior migration in this project):

- `users.is_super_admin boolean not null default false`. Excluded from `insertUserSchema`'s pick list — self-serve registration can never set it. The migration seeds it to `true` for the user whose email is the project owner's, gated on "column was just added this run" (same grandfather-backfill gate `manual-migration-012.mjs` used for `email_verified`, so it fires exactly once, ever).
- `admin_action_log` (new table): `id`, `actor_user_id` (FK → `users.id`, no cascade — the actor is always an authenticated super-admin session), `action` (`"verify" | "delete"`, plain text like `memberships.role`), `target_user_id` (int, **not** an FK — a delete's whole point is removing that row, so a hard FK would fight the delete rather than survive it), `target_email` (denormalized snapshot, keeps the row legible after the target is gone), `created_at`.

## Server

**`server/middleware/admin.ts`** (new): `requireSuperAdmin` — checks `req.user.isSuperAdmin`, 403 if false. Runs after `requireAuth`, never paired with `requireOrg` (a super-admin isn't scoped to one tenant) — matches the existing `requireAuth`-only precedent already used by the reference-data routes.

**`server/storage.ts`** additions:
- `listAllUsersForAdmin(): Promise<AdminUserListItem[]>` — two plain queries (all users; all membership+org rows), stitched in JS by grouping memberships per user into an array. Matches `deleteExpiredUnverifiedRegistrations`'s existing style of resolving relations in JS rather than a fan-out join.
- `deleteUnverifiedUserById(userId, actorUserId): Promise<"deleted" | "not_found" | "already_verified">` — one `db.batch([...])` containing the audit-log insert + org delete + user delete, atomic (so "the row is gone" and "there's a record of who removed it" are one fact). Must use `db.batch`, never `db.transaction` — this project's `drizzle-orm/neon-http` driver throws at runtime on `.transaction()`.
- `logAdminAction(entry): Promise<AdminActionLog>` — thin insert, used standalone by the verify route.
- `verifyUserEmail(userId)` (existing) is reused unmodified for the admin verify action.

Audit-log placement is intentionally asymmetric: verify calls the existing (shared) `verifyUserEmail` then a separate `logAdminAction` in its own try/catch, so a logging hiccup never turns a successful verify into a 500 — baking an actor-aware log write into `verifyUserEmail` itself would wrongly log ordinary self-service verifications too, since that method is also called from the public `/api/auth/verify-email` flow. Delete's log write is folded into its `db.batch` because delete is irreversible; losing the "who did this" record to a transient failure is a worse outcome there.

**`server/routes.ts`** — three new routes, `requireAuth, requireSuperAdmin`, no `requireOrg`, no rate limiter (authenticated + role-gated already, no unauthenticated attack surface to throttle — matches the existing `requireAuth`-only reference-data routes, which also carry none):

| Route | Success | Failure |
|---|---|---|
| `GET /api/admin/users` | `200 { users: AdminUserListItem[] }` | — |
| `POST /api/admin/users/:id/verify` | `200 { user }` | `404` unknown id. Idempotent. |
| `DELETE /api/admin/users/:id` | `204` | `404` unknown id; `409 { message, reason: "already_verified" }` if target is verified — checked at the route and re-checked in storage (closes the verify-then-delete race; storage check is authoritative) |

The `409`+`reason` shape matches the existing `/api/auth/verify-email` `already_verified` precedent, which the client's `throwIfResNotOk` already surfaces as `.reason` — no new client-side error contract needed.

`GET /api/auth/me` and the login success response both gain `isSuperAdmin` on the returned user object.

## Client

**`client/src/pages/Admin.tsx`** (new) — standalone top-level page at `/admin`, wrapped in `ProtectedRoute` plus its own inline redirect-if-not-super-admin. Not an `AppShell` section — those are all scoped to "your organization," this is cross-tenant.

List: a `<Table>` (following `FacilityProfile.tsx`'s table+row-action precedent), columns Email / Name / Status badge (Verified / Pending) / Organization(s) / Registered / actions. Actions render only for unverified rows: **Verify** (immediate-fire, matches `FacilityProfile`'s no-confirmation pattern for a reversible action) and **Delete** (behind an `AlertDialog` confirmation — the first real use of that existing-but-unused primitive, justified because this permanently destroys a *different* organization's only user and data with no undo).

`use-auth.tsx`'s `AuthUser` gains `isSuperAdmin: boolean`. `Home.tsx` gets a conditionally-rendered `Admin` nav link next to logout. `App.tsx` gets the new `/admin` route.

## Testing

`scripts/verify-admin-panel.mjs` (new, standalone like `verify-cleanup-cron.mjs` — kept out of `npm run verify` since it deletes real data). Becomes an authenticated super-admin session by registering+verifying+logging in a tagged test user through the real HTTP flow, then promoting it via direct SQL (the already-established session cookie picks up the flag on its next request, since `deserializeUser` re-fetches the user row every time).

Covers: non-admin gets 403 on all three routes; admin's list includes its own row; verify flips DB state and logs an action; delete removes a pending user and still leaves an audit row behind (`target_user_id` survives as a non-FK reference); deleting a verified user is rejected with 409 and changes nothing; both routes 404 on an unknown id.

`scripts/verify-branch.mjs`'s `step3_dbPush` schema-precondition check is extended to also require `users.is_super_admin` and the `admin_action_log` table, per this project's own established convention.

## Out of scope

- Deleting a verified/active tenant account (bigger blast radius, hits FK constraints on any data they've created — a separate, more careful design if ever needed).
- A read/list endpoint for `admin_action_log`.
- Pagination or search on the account list.
- Self-serve promotion of additional super-admins.
