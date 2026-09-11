---
name: api-conventions
description: Use when adding or modifying an Express route in server/routes.ts, including its auth, rate limiting, validation, or response shape
---

# API Conventions

## Overview

How routes get written in this codebase, including the security-relevant parts (auth, rate limiting, password handling) folded in directly — at this project's actual scale (solo developer, MVP stage), the real security rules mostly ARE about how a route is written.

## Rules

### 1. Every tenant-scoped route: `requireAuth` + `requireOrg`, no exceptions

Cross-tenant (super-admin) routes use `requireAuth` + `requireSuperAdmin` instead (`server/middleware/tenant.ts`, `server/middleware/admin.ts`) — never both together on the same route. A route is one or the other, not a hybrid.

### 2. Before any write to a reporting-boundary-scoped resource, check `finalizedLockMessage`

The practical enforcement of `ghg-domain-conventions`' immutability rule. Call `finalizedLockMessage(organizationId, reportingBoundaryId)` (`server/routes.ts:396`) before the write; if it returns a non-null message, reject with `409`. Real usages: `server/routes.ts:1882, 1903, 1958, 2443, 2463`.

### 3. Response envelope keys are singular-camelCase, matching the resource

`{ sourceStream }` / `{ sourceStreams }`, `{ calculationApproach }`, `{ measurementApproach }`, `{ dataQualityRecord }` (`server/routes.ts:2398, 2476, 2613, 2720`) — singular for a single resource, plural for a list, named after the resource, not a generic `data`/`result` wrapper.

### 4. Optional-but-sent-as-empty-string fields use the trim+transform pattern

Never bare `.min(1).optional()` — a controlled form input's default value is `""`, not `undefined`, so `.optional()` alone still rejects an empty string with "must contain at least 1 character." Trim first and fold `""`/whitespace-only into `undefined` so a genuinely blank field passes, while a name that's just spaces still doesn't get stored as one:

```ts
z.string().trim().optional().transform((v) => (v && v.length > 0 ? v : undefined))
```

(`shared/schema.ts:120-124`, where a real registration bug shipped from getting this wrong.)

### 5. Server-side validation always duplicates client-side validation

A client-side check is never the only gate — the server re-validates independently.

### 6. Security baseline for auth-sensitive routes

bcrypt hashing, `SALT_ROUNDS = 12` (`server/auth.ts:6`); rate limiting via `express-rate-limit` on register/login/forgot-password/resend-verification (`registerLimiter`, `loginLimiter`, `forgotPasswordLimiter`, `resendVerificationLimiter` in `server/routes.ts`); every access-control action logged regardless of actor tier; no admin route ever sets or sees a user's actual password.
