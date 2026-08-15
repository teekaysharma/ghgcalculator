import { pgTable, text, serial, integer, boolean, numeric, timestamp, unique, uniqueIndex, index, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Multi-tenant core tables
//
// Pattern: shared database, row-level isolation. Every tenant-scoped table
// below carries organization_id and every query in server/storage.ts filters
// on it. See PROJECT INSTRUCTIONS -> "Current objective: SaaS multi-tenant
// rebuild" for the rationale (no schema-per-tenant / DB-per-tenant unless a
// client contractually requires physical isolation later).
// ---------------------------------------------------------------------------

export const organizations = pgTable("organizations", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertOrganizationSchema = createInsertSchema(organizations).pick({
  name: true,
  slug: true,
});

export type InsertOrganization = z.infer<typeof insertOrganizationSchema>;
export type Organization = typeof organizations.$inferSelect;

// Users are identity records, not tenant-scoped directly. Email is globally
// unique (one login identity across the whole system). Tenant membership,
// and the role within a given tenant, lives in `memberships` below. This is
// the standard pattern that supports a user belonging to more than one
// organization later without a schema change, even though day-one UX is
// single-org-per-user.
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  email: true,
  passwordHash: true,
  name: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// Public-facing registration payload (plaintext password in, hashed before
// insertUserSchema is used). Kept separate so the hashing step is never
// accidentally skipped by reusing insertUserSchema directly on request input.
export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  name: z.string().min(1).optional(),
  organizationName: z.string().min(1, "Organization name is required"),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const membershipRoles = ["owner", "admin", "member"] as const;
export type MembershipRole = (typeof membershipRoles)[number];

// The tenant-scoping join table. A row here is what grants a user access to
// an organization's data, and at what role. All auth/session logic resolves
// "which organization is this request for" through this table, never by
// trusting a client-supplied organization id directly.
export const memberships = pgTable(
  "memberships",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    userOrgUnique: unique("memberships_user_org_unique").on(table.userId, table.organizationId),
    orgIdx: index("memberships_org_idx").on(table.organizationId),
  }),
);

export const insertMembershipSchema = createInsertSchema(memberships).pick({
  userId: true,
  organizationId: true,
  role: true,
});

export type InsertMembership = z.infer<typeof insertMembershipSchema>;
export type Membership = typeof memberships.$inferSelect;

// Per-organization entitlement for future add-on report/output modules
// (CBAM-shaped view, GRI-table view, etc.) -- see
// docs/superpowers/specs/2026-08-15-report-module-architecture-design.md.
// Deliberately has no HTTP route for org owners/admins to write to --
// grants happen only via scripts/grant-module.mjs, run directly by the
// vendor, since no billing/self-serve system exists yet. moduleKey
// matches a key declared in server/modules.ts's MODULE_REGISTRY.
export const organizationModules = pgTable(
  "organization_modules",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    moduleKey: text("module_key").notNull(),
    enabledAt: timestamp("enabled_at").defaultNow().notNull(),
    // Free-text note of who/how this was granted (e.g. an email or invoice
    // reference) -- this is a vendor-run script action, not necessarily
    // tied to an authenticated user session, so this is not a foreign key.
    enabledBy: text("enabled_by"),
  },
  (table) => ({
    orgModuleUnique: unique("organization_modules_org_module_unique").on(table.organizationId, table.moduleKey),
    orgIdx: index("organization_modules_org_idx").on(table.organizationId),
  }),
);

export const insertOrganizationModuleSchema = createInsertSchema(organizationModules).pick({
  organizationId: true,
  moduleKey: true,
  enabledBy: true,
});

export type InsertOrganizationModule = z.infer<typeof insertOrganizationModuleSchema>;
export type OrganizationModule = typeof organizationModules.$inferSelect;

// GHG Emission types
export type ScopeType = 'scope1' | 'scope2' | 'scope3';

// ---------------------------------------------------------------------------
// Persisted, tenant-scoped tables
//
// Replaces the previous behavior where FileUpload.tsx factors and /api/calculate
// results existed only in-memory for the duration of a single request. Both
// tables carry organization_id and MUST be filtered on it in every query in
// server/storage.ts -- see PROJECT INSTRUCTIONS "API" requirement: no query
// without organization_id in the WHERE clause.
// ---------------------------------------------------------------------------

export const emissionFactorsTable = pgTable(
  "emission_factors",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    factor: numeric("factor", { precision: 20, scale: 8 }).notNull(),
    unit: text("unit").notNull(),
    scope: text("scope"),
    category: text("category"),
    wasteType: text("waste_type"),
    disposalMethod: text("disposal_method"),
    source: text("source"),
    // Design: docs/superpowers/specs/2026-08-14-verification-ready-multi-facility-inventory-design.md
    // ISO country code (e.g. "GB", "US") this factor applies to. Nullable --
    // most org factors won't have one set until Plan 4 adds the
    // country-tiered picker. Used to prefer a facility's own country's
    // factors over generic IPCC defaults.
    country: text("country"),
    // Flags biomass/waste-derived CO2 factors so they can be excluded from
    // gross Scope 1/2/3 totals and reported as a separate memo item (GRI
    // 305 / GHG Protocol / IPCC convention). No biogenic factors are seeded
    // as of this migration -- the field exists ahead of that data landing.
    isBiogenic: boolean("is_biogenic").notNull().default(false),
    year: integer("year"),
    // Traceability fields for the emission-factor sourcing hierarchy
    // (CLAUDE.md: local/site-specific -> national -> regional -> named
    // global agencies -> IPCC generic defaults). Every org-uploaded factor
    // is, by definition, a supplement to the IPCC defaults in
    // ipccDefaultFactors below, not a replacement for them -- so it must be
    // traceable. sourceUrl/authorityName are enforced NOT NULL at the API
    // layer (server/routes.ts), not the DB layer, matching this project's
    // existing convention of app-level validation over DB constraints for
    // conditionally-required fields (see e.g. the scope/scope3Category
    // CHECK constraints being the one deliberate exception, per
    // manual-migration-003.mjs).
    sourceUrl: text("source_url"),
    authorityName: text("authority_name"),
    // Which level of the sourcing hierarchy this factor sits at -- free
    // text for now (site_specific | national | regional | global_agency),
    // deliberately not a DB enum since the hierarchy itself isn't enforced
    // anywhere yet (see ipccDefaultFactors comment below).
    sourceTier: text("source_tier"),
    uploadedBy: integer("uploaded_by").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("emission_factors_org_idx").on(table.organizationId),
    orgNameUnique: unique("emission_factors_org_name_unique").on(table.organizationId, table.name),
  }),
);

export const insertEmissionFactorSchema = createInsertSchema(emissionFactorsTable).pick({
  organizationId: true,
  name: true,
  factor: true,
  unit: true,
  scope: true,
  category: true,
  wasteType: true,
  disposalMethod: true,
  source: true,
  country: true,
  isBiogenic: true,
  year: true,
  sourceUrl: true,
  authorityName: true,
  sourceTier: true,
  uploadedBy: true,
});

export type InsertEmissionFactorRow = z.infer<typeof insertEmissionFactorSchema>;
export type EmissionFactorRow = typeof emissionFactorsTable.$inferSelect;

export const emissionRecordsTable = pgTable(
  "emission_records",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    createdBy: integer("created_by").references(() => users.id),
    scope: text("scope").notNull(),
    activity: text("activity").notNull(),
    unit: text("unit").notNull(),
    quantity: numeric("quantity", { precision: 20, scale: 6 }).notNull(),
    factor: numeric("factor", { precision: 20, scale: 8 }).notNull(),
    emission: numeric("emission", { precision: 20, scale: 6 }).notNull(),
    year: integer("year"),
    product: text("product"),
    wasteType: text("waste_type"),
    disposalMethod: text("disposal_method"),
    scope3Category: text("scope3_category"),
    // Nullable audit trail for calculations built from a per-gas IPCC
    // default factor bundle (see shared/schema.ts ipccDefaultFactors comment
    // and gwpValues) -- an array of {gas, nativeFactor, quantityOfGas, gwpValue,
    // gwpVersion, gwpSource, co2e}, one entry per gas, so the ISO/TS 14064-4
    // per-gas quantification is reconstructable from the stored record, not
    // just from the combined `factor`/`emission` totals above. Null for
    // emissions computed from a simple single-factor source (org factors,
    // non-combustion categories) -- those were never disaggregated by gas.
    gasBreakdown: jsonb("gas_breakdown"),
    // Design: docs/superpowers/specs/2026-08-14-verification-ready-multi-facility-inventory-design.md
    // All four nullable: existing rows (and the retired legacy calculator's
    // records) never had this context. Going forward, every facility-MRV
    // calculation (Plan 2) sets all four, making emissionRecordsTable the
    // single persisted-calculation-results table for both surfaces.
    // reportingBoundaryId is denormalized from the source stream so the
    // Plan 3 rollup query filters directly without a join chain.
    facilityId: integer("facility_id").references(() => facilities.id, { onDelete: "cascade" }),
    sourceStreamId: integer("source_stream_id").references(() => sourceStreams.id, { onDelete: "cascade" }),
    calculationApproachId: integer("calculation_approach_id").references(() => calculationApproaches.id, { onDelete: "set null" }),
    reportingBoundaryId: integer("reporting_boundary_id").references(() => reportingBoundaries.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("emission_records_org_idx").on(table.organizationId),
    orgYearIdx: index("emission_records_org_year_idx").on(table.organizationId, table.year),
    // Conflict target for upsertEmissionRecordForCalculationApproach's
    // onConflictDoUpdate (server/storage.ts) -- one emission record per
    // calculation approach. Created live by
    // scripts/manual-migration-007.mjs as a plain `CREATE UNIQUE INDEX`
    // (not a table constraint), which is why this is uniqueIndex(...) and
    // not the unique(...) helper used elsewhere in this file: Postgres
    // excludes NULLs from a unique index by default, so the legacy
    // /api/calculate rows (calculation_approach_id IS NULL) are unaffected.
    // Declared here so schema.ts stays the source of truth for the live DB.
    calcApproachUnique: uniqueIndex("emission_records_calc_approach_unique").on(table.calculationApproachId),
  }),
);

export const insertEmissionRecordSchema = createInsertSchema(emissionRecordsTable).pick({
  organizationId: true,
  createdBy: true,
  scope: true,
  activity: true,
  unit: true,
  quantity: true,
  factor: true,
  emission: true,
  year: true,
  product: true,
  wasteType: true,
  disposalMethod: true,
  scope3Category: true,
  gasBreakdown: true,
  facilityId: true,
  sourceStreamId: true,
  calculationApproachId: true,
  reportingBoundaryId: true,
});

export type InsertEmissionRecordRow = z.infer<typeof insertEmissionRecordSchema>;
export type EmissionRecordRow = typeof emissionRecordsTable.$inferSelect;

// ---------------------------------------------------------------------------
// ISO 14064-1 boundary-setting tables
//
// Ported and reconciled from codex/review-code-for-gaps-and-improvements
// (32 commits, MemStorage + JSON-file persistence, no tenant scoping, no
// real DB tables -- these existed there as plain TypeScript interfaces).
//
// Naming collision resolved: that branch called the entity-being-measured
// "Organization", which collides with this branch's `organizations` table
// (the SaaS tenant / paying customer account). They are not the same
// concept -- one org (tenant) can report on one or more reporting entities
// (e.g. a consultancy tenant reporting for several client companies, or a
// single company tenant with one reporting entity matching itself 1:1).
// Renamed to ReportingEntity here to keep them distinct permanently.
//
// All three tables carry organization_id (the tenant) directly, even
// though it's derivable via reportingEntityId, for the same reason every
// other tenant-scoped table here does: every query filters on it directly,
// no join required to enforce isolation.
// ---------------------------------------------------------------------------

export const consolidationApproaches = ["operational_control", "financial_control", "equity_share"] as const;
export type ConsolidationApproach = (typeof consolidationApproaches)[number];

export const dataQualityTiers = ["best", "intermediate", "minimum"] as const;
export type DataQualityTier = (typeof dataQualityTiers)[number];

export const isoInventoryCategories = [
  "category_1_direct",
  "category_2_imported_energy",
  "category_3_transportation",
  "category_4_products_used",
  "category_5_use_of_products",
  "category_6_other_indirect",
] as const;
export type IsoInventoryCategory = (typeof isoInventoryCategories)[number];

export const reportingEntities = pgTable(
  "reporting_entities",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    legalEntity: text("legal_entity"),
    // Design: docs/superpowers/specs/2026-08-14-verification-ready-multi-facility-inventory-design.md
    // Set once per entity. Base-year *emissions* are never duplicated into
    // a new field -- derive them by looking up the reportingBoundary row
    // matching this entity + baseYear (Plan 3's rollup endpoint does this).
    baseYear: integer("base_year"),
    baseYearRationale: text("base_year_rationale"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("reporting_entities_org_idx").on(table.organizationId),
  }),
);

export const insertReportingEntitySchema = createInsertSchema(reportingEntities).pick({
  organizationId: true,
  name: true,
  legalEntity: true,
  baseYear: true,
  baseYearRationale: true,
});

export type InsertReportingEntity = z.infer<typeof insertReportingEntitySchema>;
export type ReportingEntity = typeof reportingEntities.$inferSelect;

export const facilities = pgTable(
  "facilities",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    reportingEntityId: integer("reporting_entity_id").notNull().references(() => reportingEntities.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    country: text("country"),
    // Design: docs/superpowers/specs/2026-08-14-verification-ready-multi-facility-inventory-design.md
    // Required only when the parent reportingBoundary's consolidationApproach
    // is 'equity_share' -- validated at the API layer (server/routes.ts),
    // not here, matching this project's existing convention. Control
    // approaches (operational_control/financial_control) are binary
    // include/exclude -- no percentage needed.
    equityShareOwnershipPercent: numeric("equity_share_ownership_percent", { precision: 5, scale: 2 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("facilities_org_idx").on(table.organizationId),
    entityNameUnique: unique("facilities_entity_name_unique").on(table.reportingEntityId, table.name),
  }),
);

export const insertFacilitySchema = createInsertSchema(facilities).pick({
  organizationId: true,
  reportingEntityId: true,
  name: true,
  country: true,
  equityShareOwnershipPercent: true,
});

export type InsertFacility = z.infer<typeof insertFacilitySchema>;
export type Facility = typeof facilities.$inferSelect;

export const reportingBoundaries = pgTable(
  "reporting_boundaries",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    reportingEntityId: integer("reporting_entity_id").notNull().references(() => reportingEntities.id, { onDelete: "cascade" }),
    reportingYear: integer("reporting_year").notNull(),
    consolidationApproach: text("consolidation_approach").notNull(),
    description: text("description"),
    // Design: docs/superpowers/specs/2026-08-14-verification-ready-multi-facility-inventory-design.md
    // Entity-wide annual figures for GRI 102 intensity ratios, alongside
    // the existing per-facility facilityProducts.actualProduction.
    revenueAmount: numeric("revenue_amount", { precision: 20, scale: 2 }),
    revenueCurrency: text("revenue_currency"),
    fullTimeEquivalentEmployees: numeric("full_time_equivalent_employees", { precision: 10, scale: 1 }),
    // The "GHG statement" snapshot lock (ISO 14064-3: verification applies
    // to a fixed, dated statement, not a live-recalculating number).
    // 'draft' | 'finalized'. Enforced as a string union at the API layer,
    // not a DB enum, matching this project's existing convention
    // (consolidationApproach is the one exception, already a DB-level text
    // column validated against the consolidationApproaches array in code).
    status: text("status").notNull().default("draft"),
    finalizedAt: timestamp("finalized_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("reporting_boundaries_org_idx").on(table.organizationId),
    entityYearUnique: unique("reporting_boundaries_entity_year_unique").on(table.reportingEntityId, table.reportingYear),
  }),
);

export const insertReportingBoundarySchema = createInsertSchema(reportingBoundaries).pick({
  organizationId: true,
  reportingEntityId: true,
  reportingYear: true,
  consolidationApproach: true,
  description: true,
  revenueAmount: true,
  revenueCurrency: true,
  fullTimeEquivalentEmployees: true,
  status: true,
  finalizedAt: true,
});

export type InsertReportingBoundary = z.infer<typeof insertReportingBoundarySchema>;
export type ReportingBoundary = typeof reportingBoundaries.$inferSelect;

// Per-gas component of a combined factor (CO2/CH4/N2O), mirrored from
// client/src/types/emissions.ts -- see that file and the ipccDefaultFactors
// comment above for why (ISO/TS 14064-4 per-gas quantification). Duplicated
// here rather than imported because client/server already keep separate
// EmissionFactor/EmissionInput/Emission interfaces (pre-existing pattern in
// this file, not introduced by this change).
export interface GasComponent {
  gas: string;
  nativeFactor: number;
  gwpValue: number;
  gwpVersion: string;
  gwpSource: string;
  co2ePerUnit: number;
  factorLower?: number;
  factorUpper?: number;
  // True when this component came from a factor row flagged
  // ipccDefaultFactors.isBiogenic (biomass/waste-derived fuel). Carried on
  // the component -- not just the record -- because the GRI 305 / GHG
  // Protocol treatment is gas-specific: biogenic CO2 is reported as a
  // separate memo item OUTSIDE gross Scope 1/2/3, while biogenic CH4/N2O
  // stay INSIDE gross totals (burning biomass still emits anthropogenic
  // -forcing CH4/N2O). getConsolidatedReport can only make that split if
  // each component says whether it is biogenic.
  isBiogenic?: boolean;
  // Net calorific value of the fuel in TJ/Gg (== GJ/tonne), copied from
  // ipccDefaultFactors.netCalorificValue. Present only on CO2 components
  // (that is the only row the value is stored on -- see the
  // ipccDefaultFactors.netCalorificValue comment below). Enables the
  // weight-basis (kg/tonne -> TJ) activity-data conversion in
  // server/routes.ts's calculation-approach handler.
  netCalorificValue?: number;
}

export interface EmissionFactor {
  name: string;
  factor: number;
  unit: string;
  source?: string;
  year?: number;
  wasteType?: string;
  disposalMethod?: string;
  category?: string;
  gasBreakdown?: GasComponent[];
}

export interface EmissionInput {
  activity: string;
  unit: string;
  qty: number;
  year?: number;
  product?: string;
  wasteType?: string;
  disposalMethod?: string;
  scope3Category?: string;
}

export interface EmissionGasContribution {
  gas: string;
  quantityOfGas: number;
  gwpValue: number;
  gwpVersion: string;
  gwpSource: string;
  co2e: number;
}

export interface Emission {
  scope: ScopeType;
  activity: string;
  unit: string;
  quantity: number;
  factor: number;
  emission: number;
  year?: number;
  product?: string;
  wasteType?: string;
  disposalMethod?: string;
  scope3Category?: string;
  gasBreakdown?: EmissionGasContribution[];
}

export interface ProductData {
  name: string;
  production: number;
  year: number;
  unit: string;
}

export interface YearlyEmissions {
  year: number;
  scope1: number;
  scope2: number;
  scope3: number;
  total: number;
}

export interface ProductIntensity {
  product: string;
  year: number;
  emissions: number;
  production: number;
  intensity: number;
  unit: string;
}

export interface WasteEmission {
  wasteType: string;
  disposalMethod: string;
  quantity: number;
  unit: string;
  factor: number;
  emission: number;
}

export interface WasteDisposalSummary {
  wasteType: string;
  totalEmission: number;
  byMethod: Record<string, number>;
  totalQuantity: number;
  unit: string;
}
// ---------------------------------------------------------------------------
// Facility-level MRV granularity layer
//
// Added 2026-07-29. Adds facility/source-stream-level rigor on top of the
// existing ISO 14064-1 boundary layer above (reportingEntities/facilities/
// reportingBoundaries), benchmarked against the Abu Dhabi Environment
// Agency's facility-level MRV template ("Deliverable C", 14 sheets, read
// directly in this session): source streams, calculation-approach tiers,
// measurement-based approaches, fallback approach, methane-specific
// reporting, verification/data-gap tracking, management & QA, mitigation
// measures.
//
// Framework-agnostic by design, per PROJECT INSTRUCTIONS shared-foundation
// rule: this is not an "EAD table set". It is a general facility-level MRV
// layer that ISO 14064-1, GHG Protocol facility-level reporting, and EAD (or
// any other facility-level MRV regime) can be built on top of. EAD-specific
// identifiers (economic licence number, environmental permit number) are
// nullable metadata fields, not required ones, so a tenant reporting under a
// different regime is never forced into EAD's vocabulary.
//
// VERIFICATION STATUS -- read before trusting field-level detail: this
// schema is built from the structure of the EAD Deliverable C Excel
// template (sheet names, header rows, and sampled data rows, read 2026-07-29)
// plus standard facility-level MRV / EU-MRR-style conventions for fields not
// directly visible in the sampled rows (activity-data / emission-factor /
// oxidation-factor "tier" fields follow the tiered-methodology pattern
// common to EU-MRR-derived facility MRV regimes, but individual tier field
// names were NOT confirmed against every column of the source workbook --
// several sheets have more columns than were sampled -- and none of this was
// checked against the EAD Technical Guidance document's clause text in this
// session, only against the Excel template's structure). Treat this as a
// reviewable starting structure, not as verified against EAD's Technical
// Guidance clause-by-clause. Correct in the next session if direct knowledge
// of the Guidance document differs from what's modeled here.
// ---------------------------------------------------------------------------

export const materialityLevels = ["major", "minor"] as const;
export type MaterialityLevel = (typeof materialityLevels)[number];

export const quantificationApproaches = ["calculation_based", "measurement_based", "fallback"] as const;
export type QuantificationApproach = (typeof quantificationApproaches)[number];

export const verificationFindingTypes = ["data_gap", "nonconformity", "observation", "recommendation"] as const;
export type VerificationFindingType = (typeof verificationFindingTypes)[number];

export const verificationSeverities = ["minor", "moderate", "material"] as const;
export type VerificationSeverity = (typeof verificationSeverities)[number];

export const verificationStatuses = ["open", "in_progress", "closed"] as const;
export type VerificationStatus = (typeof verificationStatuses)[number];

export const mitigationStatuses = ["planned", "in_progress", "implemented"] as const;
export type MitigationStatus = (typeof mitigationStatuses)[number];

export const facilityContactTypes = ["primary", "alternative"] as const;
export type FacilityContactType = (typeof facilityContactTypes)[number];

// --- Facility identifiers (per 2c1_Identifiers). Kept as a separate 1:1
// table rather than new columns on `facilities` so the base facilities
// table stays framework-agnostic; this table holds fields only needed once
// a tenant reports under a facility-level MRV regime like EAD's. ---
export const facilityIdentifiers = pgTable(
  "facility_identifiers",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    facilityId: integer("facility_id").notNull().references(() => facilities.id, { onDelete: "cascade" }).unique(),
    groupParentEntity: text("group_parent_entity"),
    economicLicenceNumber: text("economic_licence_number"),
    environmentalPermitNumber: text("environmental_permit_number"),
    address: text("address"),
    coordinatesLat: numeric("coordinates_lat", { precision: 10, scale: 6 }),
    coordinatesLng: numeric("coordinates_lng", { precision: 10, scale: 6 }),
    primaryBusinessSector: text("primary_business_sector"),
    primaryActivity: text("primary_activity"),
    // Structured, FK-backed companion to the free-text primaryActivity
    // field above -- additive, not a replacement. Nullable so existing
    // rows and any caller still writing only primaryActivity keep working
    // unchanged. onDelete: "set null" rather than "cascade": removing a
    // row from the primary_activity_types reference list should never
    // cascade-delete facility data, it should just clear the reference.
    primaryActivityTypeId: integer("primary_activity_type_id").references(() => primaryActivityTypes.id, { onDelete: "set null" }),
    // Structured, FK-backed ISIC Rev.4 division reference -- additive,
    // nullable, same reasoning as primaryActivityTypeId above. This is the
    // new main "Primary activity" classification field (primaryActivityTypeId
    // stays in place unmodified for a possible future EAD-export mapping).
    // onDelete: "set null" rather than "cascade": removing a row from the
    // isic_divisions reference list should never cascade-delete facility
    // data, it should just clear the reference.
    isicDivisionId: integer("isic_division_id").references(() => isicDivisions.id, { onDelete: "set null" }),
    activityDescription: text("activity_description"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("facility_identifiers_org_idx").on(table.organizationId),
  }),
);

export const insertFacilityIdentifierSchema = createInsertSchema(facilityIdentifiers).pick({
  organizationId: true,
  facilityId: true,
  groupParentEntity: true,
  economicLicenceNumber: true,
  environmentalPermitNumber: true,
  address: true,
  coordinatesLat: true,
  coordinatesLng: true,
  primaryBusinessSector: true,
  primaryActivity: true,
  primaryActivityTypeId: true,
  isicDivisionId: true,
  activityDescription: true,
});
export type InsertFacilityIdentifier = z.infer<typeof insertFacilityIdentifierSchema>;
export type FacilityIdentifier = typeof facilityIdentifiers.$inferSelect;

// --- Facility contacts (primary / alternative, per 2c1_Identifiers) ---
export const facilityContacts = pgTable(
  "facility_contacts",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    facilityId: integer("facility_id").notNull().references(() => facilities.id, { onDelete: "cascade" }),
    contactType: text("contact_type").notNull().default("primary"),
    title: text("title"),
    firstName: text("first_name"),
    surname: text("surname"),
    jobTitle: text("job_title"),
    organisationName: text("organisation_name"),
    phone: text("phone"),
    email: text("email"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("facility_contacts_org_idx").on(table.organizationId),
    facilityIdx: index("facility_contacts_facility_idx").on(table.facilityId),
  }),
);

export const insertFacilityContactSchema = createInsertSchema(facilityContacts).pick({
  organizationId: true,
  facilityId: true,
  contactType: true,
  title: true,
  firstName: true,
  surname: true,
  jobTitle: true,
  organisationName: true,
  phone: true,
  email: true,
});
export type InsertFacilityContact = z.infer<typeof insertFacilityContactSchema>;
export type FacilityContact = typeof facilityContacts.$inferSelect;

// --- Facility products (per 2c2_Facility Description classification table) ---
export const facilityProducts = pgTable(
  "facility_products",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    facilityId: integer("facility_id").notNull().references(() => facilities.id, { onDelete: "cascade" }),
    productCode: text("product_code"),
    productCategory: text("product_category"),
    // Structured, FK-backed companion to the free-text productCategory
    // field above -- additive, not a replacement. Nullable so existing
    // rows and any caller still writing only productCategory keep working
    // unchanged. onDelete: "set null" rather than "cascade": removing a
    // row from the product_benchmarks reference list should never
    // cascade-delete facility data, it should just clear the reference.
    productBenchmarkId: integer("product_benchmark_id").references(() => productBenchmarks.id, { onDelete: "set null" }),
    productionTechnology: text("production_technology"),
    energyRelatedEmissions: boolean("energy_related_emissions").default(false),
    processEmissions: boolean("process_emissions").default(false),
    productionCapacity: numeric("production_capacity", { precision: 20, scale: 4 }),
    productionCapacityUnit: text("production_capacity_unit"),
    actualProduction: numeric("actual_production", { precision: 20, scale: 4 }),
    actualProductionUnit: text("actual_production_unit"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("facility_products_org_idx").on(table.organizationId),
    facilityIdx: index("facility_products_facility_idx").on(table.facilityId),
  }),
);

export const insertFacilityProductSchema = createInsertSchema(facilityProducts).pick({
  organizationId: true,
  facilityId: true,
  productCode: true,
  productCategory: true,
  productBenchmarkId: true,
  productionTechnology: true,
  energyRelatedEmissions: true,
  processEmissions: true,
  productionCapacity: true,
  productionCapacityUnit: true,
  actualProduction: true,
  actualProductionUnit: true,
});
export type InsertFacilityProduct = z.infer<typeof insertFacilityProductSchema>;
export type FacilityProduct = typeof facilityProducts.$inferSelect;

// --- Source streams: the core new concept. One row per identifiable
// emission source stream at a facility, for a given reporting boundary
// (year). Calculation approach, measurement approach, fallback, and data
// quality all hang off a source stream via sourceStreamId. ---
export const sourceStreams = pgTable(
  "source_streams",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    facilityId: integer("facility_id").notNull().references(() => facilities.id, { onDelete: "cascade" }),
    reportingBoundaryId: integer("reporting_boundary_id").notNull().references(() => reportingBoundaries.id, { onDelete: "cascade" }),
    streamCode: text("stream_code"),
    name: text("name").notNull(),
    description: text("description"),
    ghgSourceCategory: text("ghg_source_category"),
    materiality: text("materiality"),
    estimatedAnnualEmissionsTco2e: numeric("estimated_annual_emissions_tco2e", { precision: 20, scale: 4 }),
    quantificationApproach: text("quantification_approach"),
    // GHG Protocol scope classification for this source stream. Nullable,
    // additive -- existing rows and callers that never set these keep
    // working unchanged. scope's intended values ('scope1'/'scope2'/
    // 'scope3') and scope3Category's intended range (1-15, the GHG
    // Protocol's 15 Scope 3 categories) are enforced with Postgres CHECK
    // constraints in scripts/manual-migration-003.mjs, not at the Drizzle
    // layer -- no other column in this file uses a Drizzle-level check(),
    // so this keeps the same convention.
    scope: text("scope"),
    scope3Category: integer("scope3_category"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("source_streams_org_idx").on(table.organizationId),
    facilityIdx: index("source_streams_facility_idx").on(table.facilityId),
    boundaryIdx: index("source_streams_boundary_idx").on(table.reportingBoundaryId),
  }),
);

export const insertSourceStreamSchema = createInsertSchema(sourceStreams).pick({
  organizationId: true,
  facilityId: true,
  reportingBoundaryId: true,
  streamCode: true,
  name: true,
  description: true,
  ghgSourceCategory: true,
  materiality: true,
  estimatedAnnualEmissionsTco2e: true,
  quantificationApproach: true,
  scope: true,
  scope3Category: true,
});
export type InsertSourceStream = z.infer<typeof insertSourceStreamSchema>;
export type SourceStream = typeof sourceStreams.$inferSelect;

// --- Calculation-based approach detail, one row per source stream using it ---
export const calculationApproaches = pgTable(
  "calculation_approaches",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    sourceStreamId: integer("source_stream_id").notNull().references(() => sourceStreams.id, { onDelete: "cascade" }).unique(),
    fuelOrMaterialType: text("fuel_or_material_type"),
    activityDataValue: numeric("activity_data_value", { precision: 20, scale: 6 }),
    activityDataUnit: text("activity_data_unit"),
    activityDataSource: text("activity_data_source"),
    activityDataTier: text("activity_data_tier"),
    emissionFactorValue: numeric("emission_factor_value", { precision: 20, scale: 8 }),
    emissionFactorUnit: text("emission_factor_unit"),
    emissionFactorSource: text("emission_factor_source"),
    emissionFactorTier: text("emission_factor_tier"),
    // Traceability, mirroring emissionFactorsTable's sourceUrl/authorityName
    // above -- populated automatically when the factor came from the
    // EmissionFactorPicker (org factor or IPCC default row), or entered
    // directly if the user typed a factor in by hand. isIpccDefault is set
    // true whenever the picker fell back to ipccDefaultFactors because no
    // org-specific factor covered this activity -- this is the automated
    // counterpart to dataQualityRecords.usedIpccDefaultFactor, which is a
    // separate, manually-checked box (kept as-is, not removed).
    emissionFactorSourceUrl: text("emission_factor_source_url"),
    emissionFactorAuthorityName: text("emission_factor_authority_name"),
    isIpccDefault: boolean("is_ipcc_default").notNull().default(false),
    // Design: docs/superpowers/specs/2026-08-14-verification-ready-multi-facility-inventory-design.md
    // Mirrors emissionRecordsTable.gasBreakdown. Stored here too (not just
    // on the derived emissionRecordsTable row) so DataQualitySection
    // (Plan 2 Task 2) can read the selected factor's per-gas components
    // directly via its own existing query
    // (/api/source-streams/:id/calculation-approach) without needing to
    // join through emission_records or re-derive the bundle from free-text
    // fields.
    gasBreakdown: jsonb("gas_breakdown"),
    oxidationOrCarbonationFactor: numeric("oxidation_or_carbonation_factor", { precision: 6, scale: 4 }),
    oxidationFactorTier: text("oxidation_factor_tier"),
    netCalorificValue: numeric("net_calorific_value", { precision: 20, scale: 6 }),
    calculatedEmissionsTco2e: numeric("calculated_emissions_tco2e", { precision: 20, scale: 4 }),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("calculation_approaches_org_idx").on(table.organizationId),
  }),
);

export const insertCalculationApproachSchema = createInsertSchema(calculationApproaches).pick({
  organizationId: true,
  sourceStreamId: true,
  fuelOrMaterialType: true,
  activityDataValue: true,
  activityDataUnit: true,
  activityDataSource: true,
  activityDataTier: true,
  emissionFactorValue: true,
  emissionFactorUnit: true,
  emissionFactorSource: true,
  emissionFactorTier: true,
  emissionFactorSourceUrl: true,
  emissionFactorAuthorityName: true,
  isIpccDefault: true,
  gasBreakdown: true,
  oxidationOrCarbonationFactor: true,
  oxidationFactorTier: true,
  netCalorificValue: true,
  calculatedEmissionsTco2e: true,
  notes: true,
});
export type InsertCalculationApproach = z.infer<typeof insertCalculationApproachSchema>;
export type CalculationApproach = typeof calculationApproaches.$inferSelect;

// --- Measurement-based approach detail (e.g. continuous emissions
// monitoring), one row per source stream using it ---
export const measurementBasedApproaches = pgTable(
  "measurement_based_approaches",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    sourceStreamId: integer("source_stream_id").notNull().references(() => sourceStreams.id, { onDelete: "cascade" }).unique(),
    measurementMethod: text("measurement_method"),
    monitoringFrequency: text("monitoring_frequency"),
    measurementUnit: text("measurement_unit"),
    annualMeasuredQuantity: numeric("annual_measured_quantity", { precision: 20, scale: 6 }),
    qaqcProcedure: text("qaqc_procedure"),
    calibrationFrequency: text("calibration_frequency"),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("measurement_based_approaches_org_idx").on(table.organizationId),
  }),
);

export const insertMeasurementBasedApproachSchema = createInsertSchema(measurementBasedApproaches).pick({
  organizationId: true,
  sourceStreamId: true,
  measurementMethod: true,
  monitoringFrequency: true,
  measurementUnit: true,
  annualMeasuredQuantity: true,
  qaqcProcedure: true,
  calibrationFrequency: true,
  notes: true,
});
export type InsertMeasurementBasedApproach = z.infer<typeof insertMeasurementBasedApproachSchema>;
export type MeasurementBasedApproach = typeof measurementBasedApproaches.$inferSelect;

// --- Fallback approach detail, one row per source stream using it ---
export const fallbackApproaches = pgTable(
  "fallback_approaches",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    sourceStreamId: integer("source_stream_id").notNull().references(() => sourceStreams.id, { onDelete: "cascade" }).unique(),
    justification: text("justification"),
    fallbackMethodDescription: text("fallback_method_description"),
    estimatedEmissionsTco2e: numeric("estimated_emissions_tco2e", { precision: 20, scale: 4 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("fallback_approaches_org_idx").on(table.organizationId),
  }),
);

export const insertFallbackApproachSchema = createInsertSchema(fallbackApproaches).pick({
  organizationId: true,
  sourceStreamId: true,
  justification: true,
  fallbackMethodDescription: true,
  estimatedEmissionsTco2e: true,
});
export type InsertFallbackApproach = z.infer<typeof insertFallbackApproachSchema>;
export type FallbackApproach = typeof fallbackApproaches.$inferSelect;

// --- Methane-specific reporting, per facility + reporting boundary (EAD
// treats this as its own sheet, facility-wide rather than per source stream) ---
export const methaneReports = pgTable(
  "methane_reports",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    facilityId: integer("facility_id").notNull().references(() => facilities.id, { onDelete: "cascade" }),
    reportingBoundaryId: integer("reporting_boundary_id").notNull().references(() => reportingBoundaries.id, { onDelete: "cascade" }),
    methaneSourcesDescription: text("methane_sources_description"),
    quantificationMethod: text("quantification_method"),
    annualMethaneEmissions: numeric("annual_methane_emissions", { precision: 20, scale: 6 }),
    annualMethaneEmissionsUnit: text("annual_methane_emissions_unit"),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("methane_reports_org_idx").on(table.organizationId),
    boundaryUnique: unique("methane_reports_facility_boundary_unique").on(table.facilityId, table.reportingBoundaryId),
  }),
);

export const insertMethaneReportSchema = createInsertSchema(methaneReports).pick({
  organizationId: true,
  facilityId: true,
  reportingBoundaryId: true,
  methaneSourcesDescription: true,
  quantificationMethod: true,
  annualMethaneEmissions: true,
  annualMethaneEmissionsUnit: true,
  notes: true,
});
export type InsertMethaneReport = z.infer<typeof insertMethaneReportSchema>;
export type MethaneReport = typeof methaneReports.$inferSelect;

// --- Data quality / uncertainty, one row per source stream. Reuses the
// dataQualityTiers vocabulary (best/intermediate/minimum) already defined
// above for the ISO 14064-1 boundary layer. usedIpccDefaultFactor /
// ipccDefaultSubstitutionReason implement the project's emission-factor
// sourcing-hierarchy requirement: every IPCC-default substitution must be
// flagged here, not silently applied. ---
export const dataQualityRecords = pgTable(
  "data_quality_records",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    sourceStreamId: integer("source_stream_id").notNull().references(() => sourceStreams.id, { onDelete: "cascade" }).unique(),
    dataQualityTier: text("data_quality_tier"),
    uncertaintyPercent: numeric("uncertainty_percent", { precision: 6, scale: 2 }),
    uncertaintyJustification: text("uncertainty_justification"),
    usedIpccDefaultFactor: boolean("used_ipcc_default_factor").default(false),
    ipccDefaultSubstitutionReason: text("ipcc_default_substitution_reason"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("data_quality_records_org_idx").on(table.organizationId),
  }),
);

export const insertDataQualityRecordSchema = createInsertSchema(dataQualityRecords).pick({
  organizationId: true,
  sourceStreamId: true,
  dataQualityTier: true,
  uncertaintyPercent: true,
  uncertaintyJustification: true,
  usedIpccDefaultFactor: true,
  ipccDefaultSubstitutionReason: true,
});
export type InsertDataQualityRecord = z.infer<typeof insertDataQualityRecordSchema>;
export type DataQualityRecord = typeof dataQualityRecords.$inferSelect;

// --- Verification findings and data gaps, per reporting boundary (a
// verification engagement covers one reporting period) ---
export const verificationFindings = pgTable(
  "verification_findings",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    reportingBoundaryId: integer("reporting_boundary_id").notNull().references(() => reportingBoundaries.id, { onDelete: "cascade" }),
    findingType: text("finding_type").notNull(),
    description: text("description").notNull(),
    severity: text("severity"),
    status: text("status").notNull().default("open"),
    resolutionNotes: text("resolution_notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("verification_findings_org_idx").on(table.organizationId),
    boundaryIdx: index("verification_findings_boundary_idx").on(table.reportingBoundaryId),
  }),
);

export const insertVerificationFindingSchema = createInsertSchema(verificationFindings).pick({
  organizationId: true,
  reportingBoundaryId: true,
  findingType: true,
  description: true,
  severity: true,
  status: true,
  resolutionNotes: true,
});
export type InsertVerificationFinding = z.infer<typeof insertVerificationFindingSchema>;
export type VerificationFinding = typeof verificationFindings.$inferSelect;

// --- Management system & QA procedures, per reporting boundary ---
export const managementQaRecords = pgTable(
  "management_qa_records",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    reportingBoundaryId: integer("reporting_boundary_id").notNull().references(() => reportingBoundaries.id, { onDelete: "cascade" }),
    qaProcedureDescription: text("qa_procedure_description"),
    responsiblePerson: text("responsible_person"),
    reviewFrequency: text("review_frequency"),
    lastReviewDate: timestamp("last_review_date"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("management_qa_records_org_idx").on(table.organizationId),
  }),
);

export const insertManagementQaRecordSchema = createInsertSchema(managementQaRecords).pick({
  organizationId: true,
  reportingBoundaryId: true,
  qaProcedureDescription: true,
  responsiblePerson: true,
  reviewFrequency: true,
  lastReviewDate: true,
});
export type InsertManagementQaRecord = z.infer<typeof insertManagementQaRecordSchema>;
export type ManagementQaRecord = typeof managementQaRecords.$inferSelect;

// --- Mitigation measures, per facility ---
export const mitigationMeasures = pgTable(
  "mitigation_measures",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    facilityId: integer("facility_id").notNull().references(() => facilities.id, { onDelete: "cascade" }),
    measureDescription: text("measure_description").notNull(),
    status: text("status").notNull().default("planned"),
    estimatedReductionTco2e: numeric("estimated_reduction_tco2e", { precision: 20, scale: 4 }),
    targetDate: timestamp("target_date"),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("mitigation_measures_org_idx").on(table.organizationId),
    facilityIdx: index("mitigation_measures_facility_idx").on(table.facilityId),
  }),
);

export const insertMitigationMeasureSchema = createInsertSchema(mitigationMeasures).pick({
  organizationId: true,
  facilityId: true,
  measureDescription: true,
  status: true,
  estimatedReductionTco2e: true,
  targetDate: true,
  notes: true,
});
export type InsertMitigationMeasure = z.infer<typeof insertMitigationMeasureSchema>;
export type MitigationMeasure = typeof mitigationMeasures.$inferSelect;

// --- Reference lookup data (global, not tenant-scoped, seeded once, read
// by all tenants). Mirrors the 4k_Reference Lists sheet: primary activity
// types and EU-style product benchmarks. Kept as real tables rather than a
// hardcoded frontend list so they can be extended without a code deploy. ---
export const primaryActivityTypes = pgTable("primary_activity_types", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export type PrimaryActivityType = typeof primaryActivityTypes.$inferSelect;

export const productBenchmarks = pgTable("product_benchmarks", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  sector: text("sector"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export type ProductBenchmark = typeof productBenchmarks.$inferSelect;

// ISIC Rev.4 (International Standard Industrial Classification, UN
// Statistics Division) divisions, grouped by section. Global reference
// table, same pattern as primaryActivityTypes/productBenchmarks above --
// not tenant-scoped, seeded once (scripts/manual-migration-004.mjs), read
// by all tenants via GET /api/reference/isic-divisions. This is the new,
// much broader (21 sections / 88 divisions) "Primary activity" reference
// list, replacing the too-narrow 8-item primaryActivityTypes dropdown as
// the main facility-classification field. primaryActivityTypes itself is
// untouched and stays in the schema for a possible future EAD-export
// mapping. divisionCode is kept as text (not integer) to preserve leading
// zeros (e.g. "01", "09").
export const isicDivisions = pgTable("isic_divisions", {
  id: serial("id").primaryKey(),
  sectionCode: text("section_code").notNull(),
  sectionName: text("section_name").notNull(),
  divisionCode: text("division_code").notNull().unique(),
  divisionName: text("division_name").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export type IsicDivision = typeof isicDivisions.$inferSelect;

// IPCC default emission factors -- the global fallback tier of the
// emission-factor sourcing hierarchy (CLAUDE.md: local/site-specific ->
// national -> regional -> named global agencies -> IPCC generic defaults).
// Global reference table, same pattern as isicDivisions/primaryActivityTypes
// above -- not tenant-scoped, intended to be seeded once from the actual
// IPCC 2006 Guidelines for National GHG Inventories / 2019 Refinement
// default-factor tables (NOT the AR6 GWP-values table already bundled as
// client/public/gwp-ar6-reference.xlsx -- that's a per-gas multiplier table,
// a completely different IPCC output from the activity-based emission
// factors this table holds).
//
// DELIBERATELY EMPTY as of this table's creation (2026-08-11 session) --
// no row has been seeded. Fabricating specific kg-CO2-per-unit figures
// without a citable IPCC source would be worse than leaving this empty, so
// the framework (this table, the reference route, the picker UI's fallback
// behavior) is built now and real data is a separate, explicit follow-up
// pass. Every UI surface reading from this table must handle the
// zero-rows case explicitly (e.g. "IPCC default factors: pending dataset
// load"), not treat it as "no IPCC factor exists for anything."
//
// A country/org-specific factor in emissionFactorsTable is always additive
// to this table, never a replacement for it -- resolution order per
// activity: prefer an org-specific factor if one exists for that activity,
// else fall back to the matching row here, flagged as such
// (calculationApproaches.isIpccDefault / dataQualityRecords.usedIpccDefaultFactor).
//
// gasType/sector added 2026-08-14 (manual-migration-006) when real Stationary
// Combustion data was sourced: ISO/TS 14064-4 requires emissions to be
// quantified PER GAS (qty_i * GWP_i, summed), with the GWP source/version
// disclosed as a visible step -- not silently pre-combined into one opaque
// CO2e number at the data layer. So `factor` here always holds the
// gas-NATIVE default factor (e.g. kg CH4/TJ), never a GWP-weighted value.
// gasType is 'CO2' | 'CH4' | 'N2O' (extend as more categories are added).
// GWP weighting happens client-side at read time using gwpValues below, and
// the resulting per-gas breakdown is what gets persisted per calculation
// (see emissionRecordsTable.gasBreakdown), not baked in here.
//
// sector is NOT NULL with 'all' as the sentinel for sector-independent
// factors: CO2 factors (IPCC Table 1.4-style) are sector-independent -- one
// row, sector='all', reused across every sector. CH4/N2O factors for
// combustion are sector-specific (IPCC Tables 2.2-2.5: Energy Industries /
// Manufacturing & Construction / Commercial & Institutional / Residential &
// Agriculture-Forestry-Fishing each have different default factors for the
// same fuel) -- those rows carry the real sector name. Deliberately not
// nullable: Postgres treats NULL as always-distinct in unique constraints,
// which would break the ON CONFLICT ... DO NOTHING idempotent-seeding
// pattern every manual-migration script in this project relies on (see
// manual-migration-004.mjs's isic_divisions seed loop for the pattern this
// follows) -- 'all' keeps the unique index simple and gives every row a
// real, matchable value.
export const ipccDefaultFactors = pgTable("ipcc_default_factors", {
  id: serial("id").primaryKey(),
  category: text("category").notNull(),
  activityType: text("activity_type").notNull(),
  sector: text("sector").notNull(),
  gasType: text("gas_type").notNull(),
  unit: text("unit").notNull(),
  factor: numeric("factor", { precision: 20, scale: 8 }).notNull(),
  // Design: docs/superpowers/specs/2026-08-14-verification-ready-multi-facility-inventory-design.md
  isBiogenic: boolean("is_biogenic").notNull().default(false),
  // Real published 95% confidence interval bounds from the IPCC source
  // table (same units as `factor`). Nullable -- not every future
  // category's source table publishes a CI. Feeds uncertaintyPercent
  // pre-fill in dataQualityRecords (Plan 2): +/-(factorUpper-factorLower)/2/factor*100.
  factorLower: numeric("factor_lower", { precision: 20, scale: 8 }),
  factorUpper: numeric("factor_upper", { precision: 20, scale: 8 }),
  // Real IPCC Table 1.2 default net calorific value (TJ/Gg, numerically
  // equal to GJ/tonne). Nullable, and only meaningful on CO2 rows
  // (sector='all', one per fuel) -- CH4/N2O rows for the same fuel leave
  // this null rather than repeat it. Enables weight-basis unit conversion
  // (kg/tonne activity data -> TJ) for the calculation trigger: TJ =
  // quantity_tonnes * netCalorificValue / 1000. Deliberately does NOT
  // cover volume-basis units (liters/m3) -- that needs a separately
  // sourced fuel-density dataset not yet gathered; entering activity data
  // in liters/m3 still requires the factor's native unit directly.
  netCalorificValue: numeric("net_calorific_value", { precision: 10, scale: 4 }),
  scope: text("scope"),
  sourceDocument: text("source_document").notNull(),
  sourceUrl: text("source_url"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export type IpccDefaultFactor = typeof ipccDefaultFactors.$inferSelect;

// AR6 GWP-100 reference values, promoted from the static
// client/public/gwp-ar6-reference.xlsx (verified against the live IPCC/GHG
// Protocol source PDF, session of 2026-07-25 -- see that file's "Read Me"
// sheet for extraction methodology) into a queryable table so the
// calculation engine can apply GWP as a distinct, disclosed step (per
// ISO/TS 14064-4: "ISO 14064-1 specifies using GWP values with a time
// horizon of 100 years from the latest IPCC Assessment Report... it is
// important to disclose" which values/version were used) rather than a
// hardcoded constant buried in application code.
//
// Only the 4 gases Stationary Combustion needs are seeded here (CO2, CH4
// fossil, CH4 non-fossil, N2O) -- the xlsx has all 266 AR6 gases; the rest
// can be loaded in a later pass when fugitive-emissions/refrigerant scopes
// need them, same "seed what the current task needs" discipline as
// ipccDefaultFactors above.
export const gwpValues = pgTable("gwp_values", {
  id: serial("id").primaryKey(),
  gas: text("gas").notNull(),
  formula: text("formula"),
  gwpValue: numeric("gwp_value", { precision: 12, scale: 4 }).notNull(),
  gwpVersion: text("gwp_version").notNull(),
  gwpSource: text("gwp_source").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export type GwpValue = typeof gwpValues.$inferSelect;