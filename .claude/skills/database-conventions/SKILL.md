---
name: database-conventions
description: Use when touching shared/schema.ts, writing or modifying a scripts/manual-migration-NNN.mjs script, or adding/editing a method in server/storage.ts
---

# Database Conventions

## Overview

This project's data layer (Drizzle ORM + Neon Postgres, multi-tenant) has five non-negotiable rules, each traced to a real bug or incident. Follow them exactly; don't "improve" around them.

## Rules

### 1. Every tenant-scoped query filters on `organizationId` — no exceptions

Six `upsertX` methods in `server/storage.ts` shipped without this in their conflict condition and had to be fixed after the fact. Two real patterns are in use — pick the one that matches your conflict target:

- **Composite unique target** (target already includes `organizationId`):
  ```ts
  .onConflictDoUpdate({
    target: [emissionFactorsTable.organizationId, emissionFactorsTable.name],
    set: { /* ... */ },
  })
  ```
  (`server/storage.ts:740-741`)

- **Single-column target** (the target is a bare id/foreign key; `organizationId` isn't part of it): add a `setWhere` guard and check the result exists, since a matching row from a *different* org would otherwise silently update:
  ```ts
  .onConflictDoUpdate({
    target: emissionRecordsTable.calculationApproachId,
    set: data,
    setWhere: eq(emissionRecordsTable.organizationId, data.organizationId),
  })
  .returning();
  if (!row) {
    throw new Error("...: conflicting row belongs to a different organization");
  }
  ```
  (`server/storage.ts:813-820`)

Every new `upsertX`/conflict-handling method: check which pattern applies before writing it — don't assume the composite-target case is the only one.

### 2. Idempotent hand-written migrations only — `drizzle-kit push` is retired

Confirmed broken across three early attempts against this schema/environment. Every migration is `scripts/manual-migration-NNN.mjs` (find the highest existing `NNN` on disk and use the next integer), following the same shape: `information_schema` check before any DDL change, `applied`/`skipped` tracking per step, wrapped in one transaction, safe to re-run against a database that's already partway through.

### 3. `db.batch()`, never `.transaction()`

`drizzle-orm/neon-http` throws at runtime on `.transaction()` — this has bitten prior work. `db.batch([...])` is the only atomic multi-statement primitive this driver supports.

### 4. `undefined` omits, `null` clears — know which one you're sending

`onConflictDoUpdate`'s `set` filters `undefined` keys out of the `SET` clause entirely but writes an explicit `null` as-is. Getting this backwards on a field like `gasBreakdown` silently wipes a persisted per-gas audit trail on an unrelated partial re-save (see the rationale comment at `server/storage.ts:306-310`). When building a partial update object, be deliberate about which fields are `undefined` (leave untouched) vs. `null` (clear).

### 5. Destructive operations are two genuinely separate steps

Dry-run that prints exactly what will be affected → hard stop to actually read that output → separate execution step, only after confirming nothing unexpected showed up. Never chain check-then-delete in one script run. Established after a real incident (2026-09-09): a chained dry-run+delete script removed an organization without pausing to react to its own diagnostic output.
