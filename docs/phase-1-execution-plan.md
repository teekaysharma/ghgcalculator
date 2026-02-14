# Phase 1 Execution Plan (Foundation Implementation)

## Objective
Begin implementation of the foundational inventory hierarchy and boundary controls defined in Phase 0.

## Delivered in this start
- Added shared domain types for:
  - consolidation approach
  - data quality tier
  - ISO inventory category enum
  - organization/facility/reporting-boundary records
- Added starter API endpoints for:
  - organizations (`GET/POST /api/organizations`)
  - facilities (`GET/POST /api/facilities`)
  - reporting boundaries (`GET/POST /api/reporting-boundaries`)
  - setup status (`GET /api/setup-status`)
  - setup summary (`GET /api/setup-summary`)
- Added setup gating in calculation flow so emissions cannot be calculated before organization/facility/boundary setup is complete.
- Added a client setup panel to create organizations, facilities, and boundaries before normal emission workflows.
- Added a setup API integration test script (`npm run test:setup-api`) covering readiness, creation flows, and duplicate constraint responses.
- Refactored setup API state handling through `server/storage.ts` to remove route-local setup arrays and prepare for DB-backed persistence.
- Added setup delete lifecycle endpoints (`DELETE /api/organizations/:id`, `DELETE /api/facilities/:id`, `DELETE /api/reporting-boundaries/:id`) and expanded setup-summary filtering (`organizationId`).
- Extended setup integration testing to verify setup-status transitions after delete operations.
- Polished `SetupBoundaryPanel` UI with management cards, readiness badge, and inline delete actions for organization/facility/boundary lifecycle operations.
- Added `GET /api/setup-summary` pagination support (`page`, `pageSize`) with metadata and validation responses for invalid pagination input.
- Persisted setup-domain state to a local store file (`data/setup-store.json`) via `server/storage.ts`, replacing ephemeral route-process setup state.
- Extended setup integration tests to validate setup persistence across server restart in addition to lifecycle transitions.

## Next implementation slices
1. ✅ Persist setup state beyond route process memory (implemented with file-backed store in `server/storage.ts`; relational DB migration remains Phase 2 hardening).
2. ✅ Add uniqueness constraints:
   - one boundary per organization/year
   - unique facility name per organization
3. Add frontend setup flow:
   - ✅ Organization setup form
   - ✅ Facility/reporting-boundary delete controls
   - ✅ Boundary & consolidation selection form
4. ✅ Block emissions calculation until boundary setup is complete.
5. ✅ Add integration tests for the new setup APIs.


## Phase 1 Completion Status
- Foundation objectives are implemented and operational for current standalone scope.
- Remaining heavy-lift persistence upgrade to relational DB is deferred to Phase 2 hardening/scale work.
