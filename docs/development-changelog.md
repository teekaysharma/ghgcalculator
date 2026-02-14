# Development Change Log (Phase 0 → Phase 1)

This document captures implementation progress, issues encountered, and how they were solved.

## 2026-02-14 — Phase 0 kickoff (governance baseline)

### What was built
- Created `docs/phase-0-implementation-blueprint.md` with:
  - standards-aligned workstreams
  - acceptance criteria
  - canonical domain model draft
  - calculation/reporting policy drafts
  - decision-log template
- Created `docs/iso-controls-matrix.md` with requirement→control→evidence starter mappings.
- Linked reliability docs from `README.md`.

### Problems solved
- **Problem:** No structured baseline for ISO-aligned implementation.
- **Solution:** Introduced explicit planning artifacts with actionable outputs and acceptance criteria.

---

## 2026-02-14 — Phase 1 start (foundational hierarchy)

### What was built
- Added shared model types for Phase 1 foundation:
  - `ConsolidationApproach`
  - `DataQualityTier`
  - `IsoInventoryCategory`
  - `Organization`, `Facility`, `ReportingBoundary`
- Added starter setup APIs:
  - `GET/POST /api/organizations`
  - `GET/POST /api/facilities`
  - `GET/POST /api/reporting-boundaries`

### Problems solved
- **Problem:** Calculation workflow had no boundary/hierarchy setup primitives.
- **Solution:** Added first-class setup entities and API entry points for setup creation.

---

## 2026-02-14 — Setup gating and UX integration

### What was built
- Added `SetupBoundaryPanel` for in-app setup creation.
- Added `GET /api/setup-status` for readiness visibility.
- Enforced server-side setup gate in `POST /api/calculate`.
- Added client-side guard: block switching to Results until setup is complete.

### Problems solved
- **Problem:** Users could run calculations without minimal setup, producing non-governed outputs.
- **Solution:** Implemented server+client gating and readiness indicators.

---

## 2026-02-14 — Uniqueness constraints and setup summary

### What was built
- Added duplicate-prevention in setup APIs:
  - facility names unique per organization (`409` on duplicates)
  - one boundary per organization/year (`409` on duplicates)
- Added `GET /api/setup-summary` for nested setup-state inspection.

### Problems solved
- **Problem:** Setup endpoints allowed duplicate records and ambiguous configuration state.
- **Solution:** Added deterministic uniqueness checks and summary endpoint for traceable state review.

---

## 2026-02-14 — Automated setup API integration testing

### What was built
- Added `scripts/test-setup-api.mjs` end-to-end smoke/integration script.
- Added `npm run test:setup-api` command.
- Script verifies:
  - initial setup readiness = false
  - organization/facility/boundary creation
  - duplicate rejection behavior (`409`)
  - setup-summary response shape
  - final setup readiness = true

### Problems solved
- **Problem:** Setup API behavior was manually verified only.
- **Solution:** Added repeatable automated integration check runnable locally/CI.

---

## 2026-02-14 — Storage architecture hardening (next step)

### What was built
- Extended `server/storage.ts` with setup-domain persistence methods:
  - organization listing/creation
  - facility listing/creation
  - reporting-boundary listing/creation
- Refactored `server/routes.ts` setup APIs and calculation gate to use `storage` methods instead of route-local arrays.

### Problems solved
- **Problem:** Setup state was embedded directly inside route module globals, making future DB migration harder.
- **Solution:** Centralized setup-domain state behind the storage abstraction to prepare for swap from in-memory to DB-backed implementation.

---

## Open items / next steps
1. Replace in-memory setup storage with database-backed storage (Drizzle tables + migrations).
2. Add API-level filtering/pagination for setup summary endpoints when records grow.
3. Add setup panel UX for editing/deleting entities.
4. Add integration tests for setup-status transitions across delete/update operations.
5. Begin Phase 2 quantification spine (gas-level model + GWP-versioned conversion).
