# Verification-Ready Multi-Facility GHG Inventory — Design

> **For agentic workers:** This is a design spec, not an implementation plan. Per `superpowers:brainstorming`'s own process, the next step is `superpowers:writing-plans` — do not start implementing directly from this document. Given the size (schema changes across 7 tables, a new API endpoint, a new UI section, retiring the legacy calculator, and picker changes), this should be decomposed into separate sub-plans rather than one flat plan, the same way `2026-08-12-production-readiness-roadmap.md` treats its Step 3 — a reasonable split is: (1) schema migration, (2) calculation/persistence + uncertainty + finalize/version mechanic, (3) the consolidated rollup view UI, (4) multi-jurisdiction picker + legacy calculator retirement.

**Goal:** Replace the current single-flat-list calculator (`EmissionCalculator.tsx`) and the facility-MRV layer's missing consolidation step with a genuinely global, standards-compliant GHG inventory tool: any organization, in any country, with any number of legally-distinct facilities doing unrelated activities, can produce one auditable, verification-ready "global data sheet" — a consolidated report that would hold up under an actual third-party ISO 14064-3 verification, not just produce a plausible-looking number.

**Architecture:** No rewrite of the underlying stack. Extends the existing `reportingEntities → facilities → reportingBoundaries → sourceStreams` hierarchy (already structurally correct for multi-facility consolidation — see "What's already right" below) rather than replacing it. React + TypeScript client, Express server, Drizzle ORM, Postgres (Neon) — unchanged.

**Tech Stack:** Existing stack only. No new frameworks or libraries introduced by this design.

## Global Constraints

These apply throughout; not repeated per-section.

- Every tenant-scoped table query MUST filter on `organizationId` (standing project rule, already twice the source of real bugs).
- `drizzle-kit push` is retired for this project. All schema changes go through hand-written idempotent migration scripts in `scripts/manual-migration-*.mjs`, following the `tableExists`/`columnExists`/`ensureTable`/`ensureColumn`/`ensureIndex`/`seed` helper pattern already established (see `manual-migration-004.mjs` through `006.mjs`).
- IPCC AR6 GWP defaults are the permanent floor and are never overridden, only supplemented — any org/national factor requires a real, traceable `sourceUrl` + `authorityName`.
- Emission factor sourcing hierarchy (local/site-specific → national → regional → named global agencies → IPCC generic default) must never silently default to IPCC without flagging it.
- Per-gas quantification (ISO/TS 14064-4: quantity_i × GWP_i, summed, with GWP source/version disclosed) — never pre-combine gases into an opaque blended factor without preserving the disaggregated components.
- No PR, no push to GitHub without the user's explicit go-ahead. Everything in this design targets the local working tree first.

---

## Why this design exists (context)

The session that produced this spec built real, sourced IPCC Tier-1 default factors for Stationary Combustion (12 fuels × 4 sectors × CO2/CH4/N2O, from the 2006 IPCC Guidelines) and a per-gas calculation pipeline satisfying ISO/TS 14064-4. Building the UI to collect the activity data those factors need surfaced a much larger, pre-existing gap: the app can *classify* facilities and *capture* per-facility calculation approaches, but has **no way to consolidate multiple facilities into one organizational number**, and its data model doesn't yet capture what ISO 14064-1/3, GHG Protocol, IFRS S2, and GRI 305/102 all separately require for a report to be genuinely auditable and internationally usable. This design closes those gaps.

### What's already right (do not rebuild)

- `reportingEntities` (the consolidating organization) → `facilities` (one or more, each independently classified) → `reportingBoundaries` (one GHG report per entity per year, with a required `consolidationApproach` enum: `operational_control` / `financial_control` / `equity_share`) → `sourceStreams` (facility-level GHG sources) — this hierarchy already matches ISO 14064-1 Annex A's consolidation model. Facilities are already many-per-entity (unique on entity+name), each carrying its own `isicDivisionId`/`primaryBusinessSector`/`country` — sector and activity classification correctly live at the facility level already.
- `dataQualityRecords`, `verificationFindings`, `managementQaRecords` already exist, one row per source stream / reporting boundary, mapping cleanly onto ISO 14064-3's evidence, findings, and QA-procedure requirements.
- The per-gas calculation pipeline (`ipccDefaultFactors.sector`/`gasType`, `gwpValues`, `client/src/lib/ipccGasBundle.ts`, `emissionRecordsTable.gasBreakdown`) built earlier this session is reused, not replaced.
- `facilityProducts.actualProduction`/`actualProductionUnit` already exists and serves as one valid intensity-ratio denominator.

### What was wrong in this design's first draft (corrected mid-session)

An earlier draft of this design treated "organization-level" as a simplified shortcut for users who didn't want facility-level detail, with one sector chosen per organization and reused everywhere. This is wrong: under UAE law each trade-licensed facility is independently reportable, and facilities under one owner can have completely unrelated activities (manufacturing vs. application vs. trading), each needing its own correct sector. The corrected model — consolidation of independently-classified facilities, per ISO 14064-1 Annex A — is what this document describes.

---

## Section 1 — Data model changes

| Table | New column | Purpose |
|---|---|---|
| `facilities` | `equityShareOwnershipPercent` (numeric, nullable) | Required only when the parent boundary's consolidation approach is `equity_share`; validated at the API layer (matching this project's existing convention). Control approaches are binary include/exclude — no percentage needed. |
| `emissionFactorsTable` | `country` (text, nullable, ISO code) | Tags a national-tier org factor with the country it applies to, enabling the tiered picker in Section 4. |
| `emissionFactorsTable`, `ipccDefaultFactors` | `isBiogenic` (boolean, default false) | Flags biomass/waste-derived CO2 factors so they can be excluded from gross totals and reported as a separate memo item (GRI 305 / GHG Protocol / IPCC convention). No biogenic fuels are seeded yet — the field exists ahead of that data landing. |
| `ipccDefaultFactors` | `factorLower`, `factorUpper` (numeric, nullable) | The real published 95% CI bounds from the IPCC source tables (already extracted, previously discarded). Feeds uncertainty pre-fill in Section 2. |
| `emissionRecordsTable` | `facilityId`, `sourceStreamId`, `calculationApproachId`, `reportingBoundaryId` (all nullable FKs) | Becomes the single persisted-calculation-results table for both the (retired) legacy calculator and the facility-MRV flow, reusing the `gasBreakdown` audit-trail machinery already built. `reportingBoundaryId` is denormalized from the source stream for direct, un-joined filtering in the Section 3 rollup query. |
| `reportingEntities` | `baseYear` (integer, nullable), `baseYearRationale` (text, nullable) | Set once per entity. Base-year *emissions* are never duplicated into a new field — they're derived by looking up the `reportingBoundary` matching that entity + `baseYear`. |
| `reportingBoundaries` | `revenueAmount`, `revenueCurrency`, `fullTimeEquivalentEmployees` (nullable) | Entity-wide annual figures, alongside the existing per-facility production data — together these cover the denominators GRI 102 anticipates (production volume, revenue, FTE). |
| `reportingBoundaries` | `status` (text: `draft`/`finalized`, default `draft`), `finalizedAt` (timestamp, nullable) | The "GHG statement" snapshot lock — see Section 2. |

All additions are nullable or defaulted, additive-only, following this project's established migration pattern — no existing row becomes invalid.

## Section 2 — Calculation, uncertainty, and verification-readiness

**Calculation trigger:** Saving a `calculationApproach` with both an `activityDataValue` and a selected factor computes and upserts a row in `emissionRecordsTable` via the existing `gasBreakdown`-aware pipeline — not a separate manual "Calculate" step, so the persisted number never drifts from its inputs while a report is in `draft`.

**Uncertainty, sourced not guessed:** When a user selects an IPCC default via the picker, `dataQualityRecords.uncertaintyPercent` pre-fills from the real published bound — `±(factorUpper − factorLower) ÷ 2 ÷ factor × 100` — with the source citation carried through. Still editable if the user has better site-specific data; never blank by default.

**GHG statement snapshot:** Finalizing a `reportingBoundary` (`status → finalized`, `finalizedAt` set) locks that year's consolidated numbers as the fixed object of verification, per ISO 14064-3's requirement that verification applies to a defined, dated statement — not a live-recalculating number. Editing source data after finalization requires an explicit "recalculate" action with a stated reason, which creates a new version rather than silently mutating history — this single mechanic satisfies ISO 14064-1's and GRI 102's recalculation-disclosure requirements simultaneously.

**What ISO 14065/14066/17029 mean for this design:** those standards govern the competence, impartiality, and accreditation of the *verification body and its personnel* — external to this software. This tool's obligation is to produce complete, traceable, fixed evidence a verifier can actually gather and test against (data trail, uncertainty ranges, a locked statement) — which the above provides. The tool does not, and should not, attempt to perform verification itself.

**Cross-framework data collection (IFRS S2 Metrics and Targets, GRI 305/102):**
- Base year + rationale (`reportingEntities`, above) satisfies both ISO 14064-1's base-year clause and GRI 102's base-year disclosure, including "previously reported base year emissions if recalculated" via the same finalize/version mechanic.
- Intensity ratios computed against whichever denominator(s) are actually filled in (`revenueAmount`, `fullTimeEquivalentEmployees`, summed `facilityProducts.actualProduction`) — GRI 102 explicitly anticipates multiple valid denominators, not one fixed choice.
- Biogenic CO2 structurally excluded from gross Scope 1/2/3 totals, shown as a separate memo figure, once biogenic-flagged fuels exist.
- The consolidated report states plainly which of the 7 Kyoto gases are backed by real calculated data for the period (today: CO2/CH4/N2O, Stationary Combustion only) versus not yet covered — a rendered disclosure, not stored data, but a deliberate one.
- IFRS S2's Governance/Strategy/Risk-Management pillars are qualitative, narrative disclosures authored by the organization elsewhere — explicitly out of scope for a calculation tool, and the report should say so rather than silently omit it.
- IFRS S1 imposes no additional data-collection requirements beyond IFRS S2 for this tool's GHG-specific scope.

## Section 3 — The consolidated rollup view

**Data flow:** `GET /api/reporting-boundaries/:id/consolidated-report` — looks up the boundary (entity, year, consolidation approach, status), lists every facility under that reporting entity, sums each facility's `emissionRecordsTable` rows for the period (filtered directly on the new `reportingBoundaryId` column), applies each facility's equity percentage if the approach is `equity_share` (full inclusion for control approaches), and returns one structured result: totals by scope/gas/facility, biogenic CO2 kept separate, intensity ratios, plus the attached `dataQualityRecords`/`verificationFindings`/`managementQaRecords` for the boundary.

**UI — new "Organization Report" section in `AppShell`** (its current nav is `setup / facilities / boundary / calculator / team` — no consolidated view exists today):
- Header: entity, year, consolidation approach, draft/finalized status badge, Finalize/Recalculate action.
- GHG-coverage disclaimer banner.
- Scope 1/2/3 summary cards + per-gas CO2/CH4/N2O breakdown table (reusing `ResultsView.tsx`'s existing pattern).
- Per-facility breakdown (name, country, sector, equity % if applicable, subtotals), each row linking into that facility's existing `BoundaryWorkspace` detail.
- Base-year comparison, intensity ratios, uncertainty/data-quality summary, verification findings, QA procedure.
- Export, extending the existing CSV export pattern.

**Error handling:** a facility with no source streams yet is still listed, flagged incomplete — never silently dropped, since an unexplained missing source is itself a materiality issue under ISO 14064-3. Finalizing is blocked with a clear validation message if `equity_share` is selected but any facility lacks its ownership percentage.

## Section 4 — Multi-jurisdiction factor selection

Query/UI change only — no new calculation dimension. `EmissionFactorPicker`, always invoked in a specific facility's context now, receives that facility's `country` and groups its dropdown into three tiers: **"Your organization's factors for [country]"** (matching `country` tag, preferred) → **"Your organization's other factors"** (still fully usable — a facility may legitimately need a foreign dataset where no local one exists) → **"IPCC default factors"** (the permanent global floor). The traceability requirement (`sourceUrl` + `authorityName`) is unchanged. The "add your own factor" form pre-fills the facility's country, editable.

## Testing

- Unit tests for consolidation math: control vs. equity-share, with/without biogenic exclusion, intensity-ratio computation, uncertainty-bound pre-fill from IPCC confidence intervals.
- Manual end-to-end pass: create an entity with 2+ facilities of different sectors/countries → enter source-stream data for each → view the consolidated report → finalize → edit underlying source data → recalculate with a reason → confirm the prior version is intact and the change is logged.

## Decisions carried forward from this session's brainstorming dialogue

- Legacy `EmissionCalculator.tsx` is retired; the new Organization Report + per-facility `BoundaryWorkspace` flow is the one calculator surface. (Confirmed before the org/facility framing was corrected; still holds — the legacy calculator has zero facility awareness, which is now clearly load-bearing.)
- Design covers all three scopes (1/2/3) structurally now; only Scope 1 Stationary Combustion has real seeded factor data. Scope 2/3 real data follows the same sourcing pattern in future sessions.
- Native-unit entry (liters/kg/m³) with internal conversion to the factor's native unit (e.g. TJ), using sourced calorific values — still needed regardless of the org/facility correction, unchanged from the original decision.
