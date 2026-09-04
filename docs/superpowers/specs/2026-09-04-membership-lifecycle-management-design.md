# Membership & account lifecycle management — design

## Context

The final whole-branch review of the platform super-admin panel (`docs/superpowers/specs/2026-09-04-super-admin-panel-design.md`) found and fixed a Critical bug: deleting a "pending" account could destroy an unrelated live tenant's organization, because an unverified account can hold a membership in a different org via `POST /api/team/invite` (no verification check there), and the delete logic picked an arbitrary membership to act on.

That exposed a real design gap, not just a bug: the panel only ever offered whole-account, largely destructive actions (verify, delete, promote, demote), with no visibility into an account's memberships across tenants and no reversible way to correct access without deleting anything. Standard access-control practice — and specifically ISO/IEC 27001:2022, checked against this project's own RAG-indexed copy of the standard — expects access to be *provisioned, reviewed, modified, and removed* as a managed lifecycle, not a binary exists/deleted state. This design closes that gap.

## Decisions

- **Membership-level active/inactive**, not just account-level. A `memberships.isActive` flag lets a specific org-access grant be revoked and restored without touching the account or any other membership. `requireOrg` (resolved fresh on every request already) filters to active memberships only, so a deactivation takes effect on the user's very next request — no session invalidation needed.
- **Account-level active/inactive is a separate, independent concept from membership-level.** `users.isActive` blocks login entirely, regardless of which orgs the account belongs to. Deactivating one membership never touches the account; deactivating the account never touches a tenant's org (the org itself has no lifecycle change here — see Out of scope).
- **Two permission tiers on the same mechanism.** A super-admin can act on anything, cross-tenant, unrestricted. An org's own owner/admin can deactivate/reactivate a *membership* in their own org freely (it only ever affects their own org's access). For *account-wide* actions (deactivate/reactivate the account, change its email, reset its password) — actions that affect the user's access everywhere, not just one org — an org-admin's authority is restricted to users whose **sole** membership is in their own tenant. The moment a target belongs to a second org, only a super-admin can act, since only the super-admin has authority spanning both tenants.
- **Change email and password reset never involve an admin typing or knowing a credential.** Both trigger the same token-based "set a new password" link already proven by email verification (random token, expiry, one-time use), sent to the account's (new, if changing) email. This closes a real ISO 27001 gap (5.17, Authentication information: allocation of credentials must be a controlled process) more completely than an admin-set temporary password would — no password ever exists that two people know, and nothing needs to be relayed out-of-band.
- **Delete stays exactly as it is** (pending/unverified accounts only, per the already-shipped Critical fix). This design doesn't change it — deactivation is the new tool for everything that isn't "a registration that never completed."
- **Every action that revokes or changes access requires a note**, recorded on the audit log: deactivate-membership, deactivate-account, change-email, admin-triggered reset-password. Reactivation doesn't require one (restoring access is the lower-risk direction).
- **Tenant (organization) lifecycle is explicitly out of scope for this pass.** A tenant is never a side effect of a user- or membership-level action. Archive/unarchive and a properly governed, multi-step, fully-logged deletion process for an organization itself are real, wanted capabilities — deferred to a dedicated design pass (see Out of scope).

## Data model

Three schema changes, applied via the next `scripts/manual-migration-NNN.mjs` (idempotent, transaction-wrapped, `information_schema` checks — same convention as every prior migration):

- `memberships.is_active boolean not null default true`.
- `users.is_active boolean not null default true` (independent of `emailVerified` — unverified+active is today's normal pending state; verified+inactive is a suspended account).
- `users.password_reset_token text`, `users.password_reset_token_expires_at timestamp` — mirrors `emailVerificationToken`/`emailVerificationTokenExpiresAt` exactly: random bytes, an expiry, cleared on successful use.
- `admin_action_log` gains `organization_id integer` (nullable, **not** a foreign key — same rationale as `target_user_id`: a denormalized reference that must survive whatever it points to being changed or removed later, not a constraint that could fight a write) plus a denormalized `organization_name text` snapshot alongside it, and six new `action` values: `deactivate_membership`, `activate_membership`, `deactivate_user`, `activate_user`, `change_email`, `reset_password`. `organization_id`/`organization_name` are null for a cross-tenant super-admin action, set for an org-scoped org-admin action — this is what lets a new org-scoped read endpoint filter to "my org's rows" while the super-admin's existing endpoint keeps seeing everything.

## Server

**Authorization helper** (new): given a target user id and the acting session (super-admin, or an org-admin's `req.organizationId`), resolves whether an *account-wide* action is permitted — super-admin: always; org-admin: only if the target's memberships resolve to exactly one organization, and it's the acting org-admin's own. *Membership-wide* actions (deactivate/activate one membership) don't need this check — an org-admin can always act on a membership row that belongs to their own org, full stop, since it can never affect another tenant.

**Login** (`server/auth.ts`): gains a check after the existing `emailVerified` check — `if (!user.isActive) return done(null, false, { reason: "deactivated" })`, mirroring the existing `reason: "unverified"` pattern exactly.

**`requireOrg`** (`server/middleware/tenant.ts`): its membership lookup filters to `isActive = true`. An inactive membership is invisible to this resolution — the same as not existing, from the tenant-access point of view.

**New routes, super-admin** (`requireAuth, requireSuperAdmin`, existing `/api/admin/...` namespace):
- `POST /api/admin/memberships/:id/deactivate` `{ note }`, `POST /api/admin/memberships/:id/activate`
- `POST /api/admin/users/:id/deactivate` `{ note }` (400 if the target isn't verified yet — deactivating a pending registration isn't a meaningful state; use delete instead), `POST /api/admin/users/:id/reactivate`
- `POST /api/admin/users/:id/change-email` `{ newEmail, note }` — checks uniqueness, generates a fresh email-verification token for the new address, sends the verification email, and **also** generates a password-reset token in the same step so the one link the new occupant clicks does both.
- `POST /api/admin/users/:id/reset-password` `{ note }` — generates a password-reset token, sends the same reset email `POST /api/auth/forgot-password` would send.
- `GET /api/admin/users` and `GET /api/admin/action-log` (existing) extended to surface `isActive` per membership/account and the new action types/`organizationId`.

**New routes, org-admin** (new `/api/team/...` namespace, `requireAuth, requireOrg`, owner/admin role check — same pattern as the existing `/api/team/invite`):
- `POST /api/team/memberships/:id/deactivate` `{ note }` / `.../activate` — 404 if the membership isn't in the caller's org.
- `POST /api/team/members/:id/deactivate` `{ note }` / `.../reactivate` / `.../change-email` `{ newEmail, note }` / `.../reset-password` `{ note }` — each runs the authorization helper first; `403` if the target belongs to more than one organization.
- `GET /api/team/action-log` — same shape as the super-admin's, filtered to `organizationId = req.organizationId`.
- Existing `GET /api/team` extended to include `isActive` per member.

**New self-service auth routes** (`server/routes.ts`, alongside the existing auth routes, no auth required):
- `POST /api/auth/forgot-password` `{ email }` — generic response regardless of outcome (matches the existing `resend-verification-email` anti-enumeration convention), rate-limited (same 5/hour shape as the existing limiters). Only issues a token for a verified account.
- `POST /api/auth/reset-password` `{ token, newPassword }` — validates the token and expiry, sets the new password hash, clears the reset token, and marks `emailVerified = true` (a no-op if already true; this is what lets the same endpoint serve both a plain forgot-password reset and an email-change's combined verify-and-set-password step). Does not start a session — same "no auto-login" convention as verify-email; the person logs in fresh afterward.

## Client

**Super-admin `/admin` page**: each account row's membership display expands to list every membership (organization, role, active/inactive badge, a toggle per row) instead of the current "first org + N more" label. Four new account-level actions, each behind an `AlertDialog`: Deactivate account / Reactivate account, Change email, Reset password — the three that revoke or change access include the same required-reason `Textarea` pattern already built for Demote.

**`client/src/components/TeamPanel.tsx`** (currently add-only): becomes a real member-management view — a table (not the current manual `<div>` list) showing each member's role and active/inactive status, a deactivate/activate toggle per membership (always available to the owner/admin), and the four account-wide actions gated client-side to members whose only org is this one (the server is the real authority; the client hint just avoids offering a control that would 403). Gains its own "Recent activity" table, scoped to the org via `GET /api/team/action-log`.

**New pages**: `/forgot-password` (email input, generic "if that account exists..." result, same shape as the resend-verification UX) and `/reset-password` (reads `token`/`email` from the URL exactly like `VerifyEmail.tsx`, a new-password form, success/invalid-expired phases).

**`Login.tsx`**: a "Forgot password?" link next to the password field; the existing error-handling branch gains a `reason === "deactivated"` case with its own message (no resend/self-service action makes sense here — direct them to contact their org admin or support).

## Testing

Extends the existing standalone `scripts/verify-admin-panel.mjs` (and/or a new sibling script if the file grows unwieldy — a call for the implementation plan to make) with: membership deactivate/reactivate via both the super-admin and org-admin paths; `requireOrg` actually rejecting access through a deactivated membership; account deactivate/reactivate; login rejecting a deactivated account with `reason: "deactivated"`; change-email and reset-password issuing a working token and the old password/old email no longer working afterward; the org-admin boundary rule (`403` when the target belongs to a second org); and the forgot-password endpoint's generic response plus real token issuance for a verified account only.

## Compliance alignment (ISO/IEC 27001:2022, sourced from the RAG-indexed standard)

| Design element | Clause |
|---|---|
| Deactivate/reactivate instead of delete, for both memberships and accounts | **5.16 Identity management** — "the full life cycle of identities shall be managed" |
| Provision (registration), review (the panel + activity log), modify (promote/demote, membership toggle), remove (deactivate) | **5.18 Access rights** — "provisioned, reviewed, modified and removed" |
| Credentials never admin-typed or shared; token-based, controlled process | **5.17 Authentication information** |
| Promote/demote/deactivate require a note, are logged, self-demote blocked | **8.2 Privileged access rights** |
| Org-admin strictly scoped to their own tenant; cross-tenant requires super-admin | **8.3 Information access restriction** |
| `admin_action_log` append-only, no update/delete route | **8.15 Logging**, **5.33 Protection of records** |

Explicitly **not** addressed by this design, carried forward as named gaps for the BRD's next-version section: MFA on privileged accounts; automated log review/alerting (today: protected storage, not active analysis); platform-wide anomaly/intrusion monitoring; a written, formal access-control policy document (the BRD itself is this artifact); and tenant (organization) lifecycle governance (archive/unarchive/governed deletion).

## Out of scope

- Tenant (organization) archive/unarchive/deletion governance — a distinct, larger piece of work with its own design pass, deliberately not touched by any action in this design.
- MFA, automated log analysis/alerting, platform-wide anomaly monitoring — flagged above, next-version.
- Self-serve creation of additional super-admins beyond promotion (unchanged from the existing design) — not affected by this pass.
- A formal written access-control policy document — that's BRD content, not this spec's job.
