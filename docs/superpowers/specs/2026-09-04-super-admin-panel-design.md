# Platform super-admin panel — design

## Context

Registration hardening (merged into `main` this session) gates every new account behind email verification via Resend. That surfaced a real operational gap: the live Resend account is in sandbox mode and can only deliver to its own account-owner address, so any other real user's verification email currently fails to send. Today the only fix is a raw SQL `UPDATE` against the live Neon database — there is no in-app way to view accounts across tenants, manually verify a stuck one, or clean up a pending registration outright.

This adds that capability: a platform-wide `isSuperAdmin` flag (distinct from the existing per-organization `owner`/`admin`/`member` roles in `memberships.role`, which are scoped to one tenant), a small internal `/admin` page listing every account across every tenant, and two actions — manually verify a pending account, or delete one.

Confirmed via full-repo grep that no super-admin/platform-admin/`isAdmin` concept exists anywhere today — this is genuinely new, not an extension of something partially built.

## Decisions

- **Delete is scoped to pending/unverified accounts only.** A verified/active tenant's organization cascades through all 19 tenant-scoped tables, and two tables (`emission_factors.uploaded_by`, `emission_records.created_by`) reference `users.id` with no cascade or null-out — deleting a user who's created data would hit a hard foreign-key failure. Removing a live tenant is a materially different, riskier problem, left out of scope.
- **A lightweight audit log is included, and is now readable in the UI** (revised from the original write-only decision — see below). Every verify/delete/promote records who did it, to which account, when.
- **A super-admin can promote another verified account to super-admin**, from the panel itself (revised from the original hardcoded-single-seed-only decision). This is a real privilege escalation, so it requires an explicit confirmation dialog stating exactly what the grantee gains, and — like verify/delete — is written to the audit log. Only verified accounts can be promoted (an unverified account can't even log in yet). There is still no self-serve *first* super-admin: the very first one is always seeded by the migration, hardcoded by email; promotion only lets an already-seeded super-admin create more.
- **The account list supports search and pagination** (revised from the original "fine at current volume" decision, since promotion means the list is expected to be browsed more deliberately, not just skimmed for pending rows).

## Data model

Two schema changes, applied via `scripts/manual-migration-013.mjs` (idempotent, transaction-wrapped, `information_schema` checks — same convention as every prior migration in this project):

- `users.is_super_admin boolean not null default false`. Excluded from `insertUserSchema`'s pick list — self-serve registration can never set it. The migration seeds it to `true` for the user whose email is the project owner's, gated on "column was just added this run" (same grandfather-backfill gate `manual-migration-012.mjs` used for `email_verified`, so it fires exactly once, ever). This remains the only way to create the *first* super-admin; every subsequent one comes from the in-panel promote action below.
- `admin_action_log` (new table): `id`, `actor_user_id` (FK → `users.id`, no cascade — the actor is always an authenticated super-admin session), `action` (`"verify" | "delete" | "promote"`, plain text like `memberships.role`), `target_user_id` (int, **not** an FK — a delete's whole point is removing that row, so a hard FK would fight the delete rather than survive it), `target_email` (denormalized snapshot, keeps the row legible after the target is gone), `created_at`.

## Server

**`server/middleware/admin.ts`** (new): `requireSuperAdmin` — checks `req.user.isSuperAdmin`, 403 if false. Runs after `requireAuth`, never paired with `requireOrg` (a super-admin isn't scoped to one tenant) — matches the existing `requireAuth`-only precedent already used by the reference-data routes.

**`server/storage.ts`** additions:
- `listAllUsersForAdmin(params: { search?: string; limit: number; offset: number }): Promise<{ users: AdminUserListItem[]; total: number }>` — a `COUNT(*)` query plus a `LIMIT`/`OFFSET` select, both filtered by an optional case-insensitive `ilike` match on email or name, then a second pass stitching in each returned page's memberships (grouped in JS, matching `deleteExpiredUnverifiedRegistrations`'s existing style of resolving relations in JS rather than a fan-out join).
- `deleteUnverifiedUserById(userId, actorUserId): Promise<"deleted" | "not_found" | "already_verified">` — one `db.batch([...])` containing the audit-log insert + org delete + user delete, atomic (so "the row is gone" and "there's a record of who removed it" are one fact). Must use `db.batch`, never `db.transaction` — this project's `drizzle-orm/neon-http` driver throws at runtime on `.transaction()`.
- `promoteToSuperAdmin(userId): Promise<void>` — a plain `UPDATE users SET is_super_admin = true`, mirroring `verifyUserEmail`'s shape.
- `logAdminAction(entry): Promise<AdminActionLog>` — thin insert, used standalone by the verify and promote routes.
- `listAdminActionLog(): Promise<AdminActionLogEntry[]>` — the most recent 200 entries (a simple cap, not full pagination — this is a lower-traffic view than the account list), joined to `users` for the actor's email so the log reads as "who did what to whom," ordered newest-first.
- `verifyUserEmail(userId)` (existing) is reused unmodified for the admin verify action.

Audit-log placement is intentionally asymmetric: verify and promote call their respective state-changing operation, then a separate `logAdminAction` in its own try/catch, so a logging hiccup never turns a successful action into a 500 (baking an actor-aware log write into the shared `verifyUserEmail` itself would wrongly log ordinary self-service verifications too, since that method is also called from the public `/api/auth/verify-email` flow). Delete's log write is folded into its `db.batch` because delete is irreversible; losing the "who did this" record to a transient failure is a worse outcome there.

**`server/routes.ts`** — five new routes, `requireAuth, requireSuperAdmin`, no `requireOrg`, no rate limiter (authenticated + role-gated already, no unauthenticated attack surface to throttle — matches the existing `requireAuth`-only reference-data routes, which also carry none):

| Route | Success | Failure |
|---|---|---|
| `GET /api/admin/users?search=&limit=&offset=` | `200 { users: AdminUserListItem[], total }` | — |
| `POST /api/admin/users/:id/verify` | `200 { user }` | `404` unknown id. Idempotent. |
| `DELETE /api/admin/users/:id` | `204` | `404` unknown id; `409 { message, reason: "already_verified" }` if target is verified — checked at the route and re-checked in storage (closes the verify-then-delete race; storage check is authoritative) |
| `POST /api/admin/users/:id/promote` | `200 { user }` | `404` unknown id; `400` if target isn't verified yet (can't promote an account that can't even log in). Idempotent if already a super-admin. |
| `GET /api/admin/action-log` | `200 { entries: AdminActionLogEntry[] }` | — |

The `409`+`reason` shape matches the existing `/api/auth/verify-email` `already_verified` precedent, which the client's `throwIfResNotOk` already surfaces as `.reason` — no new client-side error contract needed.

`GET /api/auth/me` and the login success response both gain `isSuperAdmin` on the returned user object.

## Client

**`client/src/pages/Admin.tsx`** (new) — standalone top-level page at `/admin`, wrapped in `ProtectedRoute` plus its own inline redirect-if-not-super-admin. Not an `AppShell` section — those are all scoped to "your organization," this is cross-tenant.

Account list: a `<Table>` (following `FacilityProfile.tsx`'s table+row-action precedent), columns Email / Name / Status badge (Pending / Verified / Super Admin) / Organization(s) / Registered / actions, above a search input (debounced) and Previous/Next pagination controls (25 per page). Actions depend on status: **pending** rows get **Verify** (immediate-fire, matches `FacilityProfile`'s no-confirmation pattern for a reversible action) and **Delete** (behind an `AlertDialog` confirmation — destroys a *different* organization's only user and data with no undo); **verified, non-admin** rows get **Promote to super-admin**, behind an `AlertDialog` that states plainly what the grantee gains and that there's no undo button for it; **already-super-admin** rows get no action. `AlertDialog` (a shadcn primitive that previously had zero usage in this codebase) is now used for both destructive-delete and privilege-grant confirmations — the two classes of action serious enough to warrant it.

Because the list is now paginated/searched, its query key carries `{ search, limit, offset }` (a deliberate, documented departure from this codebase's usual "queryKey[0] is the literal fetch URL" convention, needed so `invalidateQueries({ queryKey: ["/api/admin/users"] })` still matches every page/search variant via TanStack Query's prefix matching).

A second, read-only "Recent activity" table on the same page lists the most recent `admin_action_log` entries (actor, action, target, when) — this is the audit log the "no read endpoint" decision above was revised to include.

`use-auth.tsx`'s `AuthUser` gains `isSuperAdmin: boolean`. `Home.tsx` gets a conditionally-rendered `Admin` nav link next to logout. `App.tsx` gets the new `/admin` route.

## Testing

`scripts/verify-admin-panel.mjs` (new, standalone like `verify-cleanup-cron.mjs` — kept out of `npm run verify` since it deletes real data). Becomes an authenticated super-admin session by registering+verifying+logging in a tagged test user through the real HTTP flow, then promoting it via direct SQL (the already-established session cookie picks up the flag on its next request, since `deserializeUser` re-fetches the user row every time).

Covers: non-admin gets 403 on all routes; admin's list includes its own row; search actually filters; verify flips DB state and logs an action; delete removes a pending user and still leaves an audit row behind (`target_user_id` survives as a non-FK reference); deleting a verified user is rejected with 409 and changes nothing; promoting a verified user flips `is_super_admin` and logs it; promoting an unverified user is rejected with 400; the action-log endpoint returns the entries just created; unknown ids 404 across the relevant routes.

`scripts/verify-branch.mjs`'s `step3_dbPush` schema-precondition check is extended to also require `users.is_super_admin` and the `admin_action_log` table, per this project's own established convention.

## Out of scope

- Deleting a verified/active tenant account (bigger blast radius, hits FK constraints on any data they've created — a separate, more careful design if ever needed).
- Demoting a super-admin back to a normal account (promotion has no inverse in this feature — matches the "no undo" warning shown at promote time).
- Self-serve creation of the *first* super-admin — that always requires the migration's hardcoded seed; promotion only extends an already-seeded super-admin's access to others.
