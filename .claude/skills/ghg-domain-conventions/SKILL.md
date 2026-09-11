---
name: ghg-domain-conventions
description: Use when touching emission-factor selection, GWP values, calculation-approach logic, biogenic CO2 handling, unit conversion, or a reporting boundary's finalized state
---

# GHG Domain Conventions

## Overview

This product's core purpose is producing GHG numbers meant to survive third-party verification. A wrong rule here doesn't just break code — it produces a wrong number in a statement someone else is going to audit. These rules are stricter than typical application logic for that reason.

## Rules

### 1. GWP values are versioned and sourced, never hardcoded

Every gas's GWP-100 comes from the live `gwp_values` table (`shared/schema.ts:1401`), AR6 by default, `gwpVersion` tagged at the schema level (`shared/schema.ts:1406`) — not typed into a script or component twice. If a calculation needs a GWP, query the table; don't inline a remembered value.

### 2. Emission factor sourcing hierarchy, enforced in order

local/site-specific → national → regional → named global agencies (IEA, IPCC EFDB, UNFCCC, GHG Protocol, DEFRA) → IPCC generic defaults. Any IPCC-default substitution must be flagged via `usedIpccDefaultFactor` + `ipccDefaultSubstitutionReason` (`shared/schema.ts:1145-1146`) — never a silent fallback to IPCC generic.

### 3. Every selected emission factor carries a traceable source

`emissionFactorSourceUrl` + `emissionFactorAuthorityName` (`shared/schema.ts:983-984`) ride alongside the factor value itself. A factor with a number but no source is incomplete.

### 4. Biogenic CO2 is a memo item, never counted in gross totals

Pulled out of Scope 1/2/3 gross figures and reported separately, per GHG Protocol/ISO convention.

### 5. The server recomputes emissions itself, never trusts a client-submitted total

Whenever both a quantity and a factor are present, `calculatedEmissionsTco2e` is derived server-side — see `server/calculations/emission-calculation.ts`'s `calculateEmission` for the canonical, unit-tested implementation. A client-submitted total is never persisted as-is.

### 6. Only the sanctioned unit-conversion path is allowed

Weight-basis (kg/tonnes) against an energy-basis (TJ) factor converts via the fuel's net calorific value; anything else (e.g. a volume-basis unit like litres) is rejected with an explicit error, never guessed. `calculateEmission` (`server/calculations/emission-calculation.ts`) is the single enforcement point — its `status: "rejected"` branch is this rule working as intended, not a bug to "fix" by adding a guessed conversion.

### 7. A finalized reporting boundary is immutable

ISO 14064-3 treats a GHG statement as a fixed, dated snapshot. Once `reportingBoundaries.status = "finalized"`, no route writes to its scoped data without going through the explicit, reasoned recalculate flow. The practical enforcement point is `finalizedLockMessage()` (`server/routes.ts:396`) — see the `api-conventions` skill for how routes must call it.
