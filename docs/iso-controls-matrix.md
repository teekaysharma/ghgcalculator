# ISO Controls Matrix (Phase 0 Starter)

> Ported from `codex/review-code-for-gaps-and-improvements` as reference material, unedited below this note. Where this document says `Organization`, read it as `ReportingEntity` on this branch — the entity-being-measured concept was renamed to resolve a collision with this branch's `organizations` table (the SaaS tenant). See README.md "Reconciled from codex" section for the full explanation.

This starter matrix maps mandatory requirements to planned controls and evidence. Status values are:
- `implemented`
- `partial`
- `planned`

| Requirement Area | Requirement (Condensed) | Control Design | Evidence Artifact | Current Status |
|---|---|---|---|---|
| Architecture | Facility-level capture and organizational roll-up | Canonical entities: `Organization`, `Facility`, roll-up queries with lineage keys | Schema docs + roll-up test outputs | planned |
| Boundary & consolidation | Enforce control/equity-share selection | Required `BoundaryConfig` on reporting period with immutable selection and justification | Boundary config records and API validation logs | planned |
| Categorization | Support ISO reporting categories | Category taxonomy module + mapping table | Category mapping specification + integration tests | planned |
| Quantification | Gas-level accounting + CO2e conversion | `GasBreakdown` + conversion engine tied to `GwpDatasetVersion` | Conversion test vectors | planned |
| Quantification | Separate biogenic CO2/removals | Dedicated biogenic fields and report sections | Report snapshots + schema fields | planned |
| Data quality | Data quality tiering | Mandatory `best/intermediate/minimum` field per source record | Validation tests + UI checks | planned |
| Uncertainty | Category-level aggregated uncertainty | Uncertainty aggregation module + assumptions store | Uncertainty calculation report | planned |
| Base year | Recalculation process for structural/method changes | `BaseYearEvent` + recalculation workflow | Recalculation logs and diff reports | planned |
| Auditability | Trace each record to primary evidence | Evidence linkage per emission record + immutable change history | Evidence linkage exports | planned |
| Scope significance | Scope 3 significance screening criteria | Screening matrix with magnitude/influence/risk scoring | Screening assessments per category | planned |
| Product footprint | LCA stage model and functional unit | Stage-level product inventory + functional/declared unit constraints | Product stage reports | planned |
| Reliability | Double-counting guardrails | Cross-category overlap rules and warning engine | Rule execution logs | planned |
| Reliability | Mitigation and target management | Reduction initiative model + target tracking (absolute/intensity) | Target progress report | planned |
| Assurance | Verification-ready reporting | Reporting pack with boundary/method/source/assurance declarations | Standardized report export | planned |
| Existing foundation | API payload validation and factor quality checks | Zod request validation + factor anomaly warnings in upload flow | Current code and runtime checks | partial |

## Notes
- This matrix is the baseline to be expanded during Phase 0 workshops.
- Ownership and due dates should be added once team assignments are confirmed.
