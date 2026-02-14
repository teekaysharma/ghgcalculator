# Phase 0 Implementation Blueprint (ISO-Aligned Reliability Foundation)

## Purpose
Phase 0 establishes the governance, architecture contracts, and acceptance criteria needed before deep implementation work. The output of this phase is a locked design baseline for Phases 1–4.

## Duration
- Target: 2–3 weeks
- Cadence: weekly checkpoints

## Workstreams

### 1) Standards Profile & Controls Matrix
Create a requirement-to-control mapping for:
- ISO 14064-1
- ISO 14064-2
- ISO 14064-3
- ISO 14067
- ISO/TS 14064-4:2025

Output:
- `docs/iso-controls-matrix.md`

Acceptance criteria:
- Every mandatory requirement is mapped to a control owner and verification evidence.

### 2) Canonical Domain Model v1
Define core entities and relations for reliable GHG accounting:
- Organization
- Facility / Site
- Reporting Period
- Boundary Configuration
- Consolidation Method
- Emission Source Record
- Gas Breakdown
- GWP Dataset Version
- Evidence Record
- Methodology Version
- Base-Year Event
- Uncertainty Profile

Output:
- Entity inventory and relationship narrative in this document.
- Follow-on implementation ticket list for schema and API changes.

Acceptance criteria:
- Shared understanding of object ownership, lifecycle, and audit lineage.

### 3) Calculation Policy Contract v1
Specify non-negotiable quantification behavior:
- Gas-level accounting inputs
- CO2e conversion rule by selected GWP dataset version
- Biogenic carbon separation
- Treatment rules for missing/estimated data by quality tier

Output:
- Policy section in this document
- Validation checklist for `/api/calculate` replacement endpoint in Phase 2

Acceptance criteria:
- A reviewer can reproduce expected calculations from policy text.

### 4) Reporting Contract v1
Define minimum report content for reliability and verification readiness:
- Boundary and consolidation declaration
- Category and gas disaggregation
- Methods and emission factor provenance
- Base-year and recalculation statement
- Assurance status and level

Output:
- Required report fields and section definitions

Acceptance criteria:
- Report structure satisfies internal pre-verification walkthrough.

## Canonical Domain Model (Draft)

### Core configuration entities
- **Organization**: legal/reporting entity.
- **Facility**: physical site under organization, addressable and roll-up capable.
- **ReportingPeriod**: year (and optional sub-period) for inventories.
- **BoundaryConfig**: chosen method (`operational_control`, `financial_control`, `equity_share`) and justification.

### Inventory entities
- **EmissionSourceRecord**: primary activity record with quantity, unit, data quality tier, and references.
- **GasBreakdown**: child rows per source (`CO2`, `CH4`, `N2O`, `HFC`, `PFC`, `SF6`, `NF3`) and amount.
- **GwpDatasetVersion**: table + version metadata used for conversion.
- **EmissionResult**: derived CO2e totals with reproducibility metadata.

### Reliability entities
- **EvidenceRecord**: supporting files/documents linked to source records.
- **MethodologyVersion**: declared ruleset and change log.
- **BaseYearEvent**: recalculation triggers for structure/method changes.
- **UncertaintyProfile**: uncertainty assumptions and aggregated category output.

## Calculation Policy (Draft)
1. All conversion to CO2e must identify the active GWP dataset version.
2. Gas-level values are the authoritative input; aggregate-only records are transitional.
3. Biogenic CO2 and removals must be stored and reported separately from fossil emissions.
4. Data quality tiers are mandatory per source record:
   - `best` (primary measured)
   - `intermediate` (parameterized estimate)
   - `minimum` (secondary/default factor)

## Reporting Contract (Draft)
Each inventory export must include, at minimum:
1. Organization, facility scope, and reporting period.
2. Boundary + consolidation method selection.
3. Emissions by category and by gas.
4. CO2e conversion basis (GWP dataset version).
5. Data quality summary and uncertainty statement.
6. Methodology references and emission factor sources.
7. Base-year recalculation notes (if applicable).
8. Assurance section (status and level).

## Phase 0 Backlog (Execution Order)
1. Finalize controls matrix owners and evidence artifacts.
2. Approve canonical entity definitions and naming.
3. Freeze policy contract for conversion and categorization.
4. Define migration strategy from current scope-based model to canonical model.
5. Create Phase 1 implementation tickets (schema/API/UI).

## Decision Log Template
Use this for all design decisions in Phase 0.

- **Decision ID**:
- **Date**:
- **Topic**:
- **Options considered**:
- **Selected option**:
- **Rationale**:
- **Impact (schema/API/UI/reporting)**:
- **Review date**:
