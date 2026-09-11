import { and, desc, eq, exists, ilike, inArray, lt, ne, notInArray, or, sql } from "drizzle-orm";
import { db } from "./db";
import { MODULE_REGISTRY, isKnownModuleKey } from "./modules";
import {
  organizations,
  users,
  memberships,
  organizationModules,
  emissionFactorsTable,
  emissionRecordsTable,
  reportingEntities,
  facilities,
  reportingBoundaries,
  facilityIdentifiers,
  facilityContacts,
  facilityProducts,
  sourceStreams,
  calculationApproaches,
  measurementBasedApproaches,
  fallbackApproaches,
  methaneReports,
  dataQualityRecords,
  verificationFindings,
  managementQaRecords,
  mitigationMeasures,
  primaryActivityTypes,
  productBenchmarks,
  isicDivisions,
  ipccDefaultFactors,
  gwpValues,
  adminActionLog,
  type Organization,
  type InsertOrganization,
  type User,
  type InsertUser,
  type Membership,
  type InsertMembership,
  type AdminActionLog,
  type EmissionFactorRow,
  type InsertEmissionFactorRow,
  type EmissionRecordRow,
  type InsertEmissionRecordRow,
  type ReportingEntity,
  type InsertReportingEntity,
  type Facility,
  type InsertFacility,
  type ReportingBoundary,
  type InsertReportingBoundary,
  type FacilityIdentifier,
  type InsertFacilityIdentifier,
  type FacilityContact,
  type InsertFacilityContact,
  type FacilityProduct,
  type InsertFacilityProduct,
  type SourceStream,
  type InsertSourceStream,
  type CalculationApproach,
  type InsertCalculationApproach,
  type MeasurementBasedApproach,
  type InsertMeasurementBasedApproach,
  type FallbackApproach,
  type InsertFallbackApproach,
  type MethaneReport,
  type InsertMethaneReport,
  type DataQualityRecord,
  type InsertDataQualityRecord,
  type VerificationFinding,
  type InsertVerificationFinding,
  type ManagementQaRecord,
  type InsertManagementQaRecord,
  type MitigationMeasure,
  type InsertMitigationMeasure,
  type PrimaryActivityType,
  type ProductBenchmark,
  type IsicDivision,
  type IpccDefaultFactor,
  type GwpValue,
} from "@shared/schema";

// -----------------------------------------------------------------------
// ConsolidatedReport
//
// Response shape for GET /api/reporting-boundaries/:id/consolidated-report
// (Plan 3's auditable global data sheet). Kept here rather than in
// shared/schema.ts because it's a computed/aggregated response shape, not
// a table -- no prior endpoint in this project returns something this
// large, so there's no established convention to follow either way.
// -----------------------------------------------------------------------
export interface ConsolidatedReport {
  reportingBoundary: {
    id: number;
    reportingYear: number;
    consolidationApproach: string;
    status: string;
    finalizedAt: string | null;
  };
  reportingEntity: { id: number; name: string; baseYear: number | null; baseYearRationale: string | null };
  totals: { scope1: number; scope2: number; scope3: number; biogenicCo2: number };
  gasBreakdown: { gas: string; co2e: number; nativeMass: number; pctOfTotal: number }[];
  facilities: {
    id: number;
    name: string;
    country: string | null;
    equityShareOwnershipPercent: number | null;
    incomplete: boolean;
    // True only under equity_share consolidation, when this facility has no
    // ownership percentage recorded. facilityMultiplier() below returns 0 in
    // that case (deliberately, to avoid overcounting), which makes the
    // facility's scope totals read as a flat 0.00 even when it has real
    // activity data. An unexplained zero is itself a completeness finding a
    // verifier would raise, so the reason is surfaced explicitly rather than
    // left to be inferred. Kept separate from `incomplete` (which means "no
    // source streams") so the report can explain each cause on its own.
    missingEquityShare: boolean;
    scope1: number;
    scope2: number;
    scope3: number;
  }[];
  // GHG intensity per GRI 305-4 / IFRS S2: emissions DIVIDED BY the
  // organization-specific denominator (tCO2e per unit of revenue, per FTE,
  // per unit of production) -- not the reciprocal. revenueCurrency is
  // carried through so the revenue ratio can be labelled with its unit.
  intensity: {
    tco2ePerRevenue: number | null;
    tco2ePerFte: number | null;
    tco2ePerProductionUnit: number | null;
    revenueCurrency: string | null;
  };
  gasCoverage: { gas: string; covered: boolean }[];
  dataQualityRecords: {
    id: number;
    sourceStreamId: number;
    sourceStreamName: string | null;
    dataQualityTier: string | null;
    uncertaintyPercent: string | null;
    uncertaintyJustification: string | null;
    usedIpccDefaultFactor: boolean | null;
    ipccDefaultSubstitutionReason: string | null;
  }[];
  verificationFindings: unknown[];
  managementQaRecords: unknown[];
  baseYearComparison: { baseYearTotal: number | null; currentYearTotal: number; changePercent: number | null } | null;
}

// -----------------------------------------------------------------------
// SourceStreamDetail
//
// The per-source-stream calculation trail neither export can get from
// getConsolidatedReport (which only returns facility-level rollups).
// One row per source stream, joined with whichever of the three approach
// tables it actually has a row in (a source stream has at most one of
// calculationApproach / measurementApproach / fallbackApproach -- each of
// those tables' sourceStreamId column is unique).
// -----------------------------------------------------------------------
export interface SourceStreamDetail {
  sourceStreamId: number;
  facilityId: number;
  facilityName: string;
  streamCode: string | null;
  name: string;
  description: string | null;
  ghgSourceCategory: string | null;
  scope: string | null;
  materiality: string | null;
  estimatedAnnualEmissionsTco2e: number | null;
  approachTier: "calculation" | "measurement" | "fallback" | "none";
  calculationApproach: {
    fuelOrMaterialType: string | null;
    activityDataValue: number | null;
    activityDataUnit: string | null;
    activityDataSource: string | null;
    activityDataTier: string | null;
    emissionFactorValue: number | null;
    emissionFactorUnit: string | null;
    emissionFactorSource: string | null;
    emissionFactorSourceUrl: string | null;
    emissionFactorAuthorityName: string | null;
    isIpccDefault: boolean;
    gasBreakdown: unknown;
    netCalorificValue: number | null;
    calculatedEmissionsTco2e: number | null;
  } | null;
  measurementApproach: {
    measurementMethod: string | null;
    monitoringFrequency: string | null;
    measurementUnit: string | null;
    annualMeasuredQuantity: number | null;
    qaqcProcedure: string | null;
    calibrationFrequency: string | null;
  } | null;
  fallbackApproach: {
    justification: string | null;
    fallbackMethodDescription: string | null;
    estimatedEmissionsTco2e: number | null;
  } | null;
}

// -----------------------------------------------------------------------
// AdminUserListItem / AdminActionLogEntry
//
// Response shapes for the platform-admin panel. organizations is an array
// (not a single object) on AdminUserListItem because the schema itself
// allows a user to belong to more than one organization even though
// nothing in the product creates that today (memberships only enforces
// uniqueness on (userId, organizationId), not on userId alone) -- this is
// the honest shape rather than silently assuming one org per user forever.
// -----------------------------------------------------------------------
export interface AdminUserListItem {
  id: number;
  email: string;
  name: string | null;
  emailVerified: boolean;
  // Exposed alongside emailVerified so the panel can tell a genuine fresh
  // pending registration (!emailVerified && !hasBeenVerified -- verifiable,
  // deletable) apart from a live account mid email-change
  // (!emailVerified && hasBeenVerified -- must not offer delete, the server
  // rejects it with 409). Without this the two look identical in the UI.
  hasBeenVerified: boolean;
  isSuperAdmin: boolean;
  isActive: boolean;
  createdAt: Date;
  organizations: {
    membershipId: number;
    organizationId: number;
    organizationName: string;
    role: string;
    isActive: boolean;
  }[];
}

export interface AdminOrganizationListItem {
  id: number;
  name: string;
  slug: string;
  createdAt: Date;
  memberCount: number;
  ownerEmails: string[];
}

export interface AdminActionLogEntry {
  id: number;
  actorEmail: string;
  action:
    | "verify"
    | "delete"
    | "promote"
    | "demote"
    | "deactivate_membership"
    | "activate_membership"
    | "deactivate_user"
    | "activate_user"
    | "change_email"
    | "reset_password";
  targetEmail: string;
  organizationName: string | null;
  note: string | null;
  createdAt: Date;
}

// -----------------------------------------------------------------------
// IStorage
//
// Every method that touches a tenant-scoped table takes organizationId as
// an explicit argument and every implementation filters on it. This is the
// enforcement point for "no query without organization_id in the WHERE
// clause" from PROJECT INSTRUCTIONS. Routes must never bypass this layer
// with a raw db call.
// -----------------------------------------------------------------------
export interface IStorage {
  // Organizations
  createOrganization(org: InsertOrganization): Promise<Organization>;
  getOrganization(id: number): Promise<Organization | undefined>;
  getOrganizationBySlug(slug: string): Promise<Organization | undefined>;

  // Users (identity, not tenant-scoped)
  createUser(user: InsertUser): Promise<User>;
  getUser(id: number): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUserByVerificationToken(token: string): Promise<User | undefined>;
  getUserByPasswordResetToken(token: string): Promise<User | undefined>;
  verifyUserEmail(userId: number): Promise<void>;
  setEmailVerificationToken(userId: number, token: string, expiresAt: Date): Promise<void>;
  setPasswordResetToken(userId: number, token: string, expiresAt: Date): Promise<void>;
  resetPassword(userId: number, passwordHash: string): Promise<void>;
  updateOwnName(userId: number, name: string | null): Promise<void>;
  deleteExpiredUnverifiedRegistrations(): Promise<number>;

  // Memberships (the tenant-scoping join)
  createMembership(membership: InsertMembership): Promise<Membership>;
  getMembershipsForUser(userId: number): Promise<Membership[]>;
  getActiveMembershipsForUser(userId: number): Promise<Membership[]>;
  getMembership(userId: number, organizationId: number): Promise<Membership | undefined>;
  listMembershipsForOrganization(
    organizationId: number,
  ): Promise<(Membership & { userEmail: string; userName: string | null })[]>;
  getEnabledModuleKeys(organizationId: number): Promise<string[]>;
  isUsersSoleOrganization(userId: number, organizationId: number): Promise<boolean>;

  // Emission factors (tenant-scoped)
  createEmissionFactors(
    organizationId: number,
    factors: Omit<InsertEmissionFactorRow, "organizationId">[],
  ): Promise<EmissionFactorRow[]>;
  listEmissionFactors(organizationId: number): Promise<EmissionFactorRow[]>;
  deleteEmissionFactor(organizationId: number, factorId: number): Promise<boolean>;

  // Emission records (tenant-scoped, persisted calculation results)
  createEmissionRecords(
    organizationId: number,
    records: Omit<InsertEmissionRecordRow, "organizationId">[],
  ): Promise<EmissionRecordRow[]>;
  listEmissionRecords(organizationId: number): Promise<EmissionRecordRow[]>;
  upsertEmissionRecordForCalculationApproach(data: {
    organizationId: number;
    facilityId: number;
    sourceStreamId: number;
    calculationApproachId: number;
    reportingBoundaryId: number;
    createdBy: number;
    scope: string;
    activity: string;
    unit: string;
    quantity: string;
    factor: string;
    emission: string;
    // Optional on purpose: Drizzle's onConflictDoUpdate filters `undefined`
    // fields out of its SET clause but writes an explicit `null` as-is.
    // Omitting the key on a partial re-save therefore preserves the stored
    // per-gas audit trail, where passing null would destroy it.
    gasBreakdown?: unknown;
  }): Promise<EmissionRecordRow>;

  // ISO 14064-1 boundary setup (tenant-scoped). See PROJECT INSTRUCTIONS ->
  // reconciliation with codex/review-code-for-gaps-and-improvements.
  createReportingEntity(entity: InsertReportingEntity): Promise<ReportingEntity>;
  listReportingEntities(organizationId: number): Promise<ReportingEntity[]>;
  getReportingEntity(organizationId: number, id: number): Promise<ReportingEntity | undefined>;
  updateReportingEntity(
    organizationId: number,
    id: number,
    data: Partial<Pick<InsertReportingEntity, "name" | "legalEntity" | "baseYear" | "baseYearRationale">>,
  ): Promise<ReportingEntity | undefined>;
  deleteReportingEntity(organizationId: number, id: number): Promise<boolean>;

  createFacility(facility: InsertFacility): Promise<Facility>;
  listFacilities(organizationId: number): Promise<Facility[]>;
  getFacility(organizationId: number, id: number): Promise<Facility | undefined>;
  updateFacility(
    organizationId: number,
    id: number,
    data: Partial<Pick<InsertFacility, "name" | "country" | "equityShareOwnershipPercent">>,
  ): Promise<Facility | undefined>;
  deleteFacility(organizationId: number, id: number): Promise<boolean>;

  createReportingBoundary(boundary: InsertReportingBoundary): Promise<ReportingBoundary>;
  listReportingBoundaries(organizationId: number): Promise<ReportingBoundary[]>;
  getReportingBoundary(organizationId: number, id: number): Promise<ReportingBoundary | undefined>;
  updateReportingBoundary(
    organizationId: number,
    id: number,
    data: Partial<
      Pick<
        InsertReportingBoundary,
        | "reportingYear"
        | "consolidationApproach"
        | "description"
        | "status"
        | "finalizedAt"
        | "revenueAmount"
        | "revenueCurrency"
        | "fullTimeEquivalentEmployees"
      >
    >,
  ): Promise<ReportingBoundary | undefined>;
  deleteReportingBoundary(organizationId: number, id: number): Promise<boolean>;

  // -----------------------------------------------------------------------
  // Facility-level MRV granularity layer. See shared/schema.ts "Facility-
  // level MRV granularity layer" section header for provenance/context.
  // -----------------------------------------------------------------------

  // Facility identifiers (1:1 per facility, unique on facilityId)
  getFacilityIdentifier(organizationId: number, facilityId: number): Promise<FacilityIdentifier | undefined>;
  upsertFacilityIdentifier(data: InsertFacilityIdentifier): Promise<FacilityIdentifier>;

  // Facility contacts (many per facility)
  createFacilityContact(contact: InsertFacilityContact): Promise<FacilityContact>;
  listFacilityContacts(organizationId: number, facilityId: number): Promise<FacilityContact[]>;
  updateFacilityContact(
    organizationId: number,
    id: number,
    data: Partial<Omit<InsertFacilityContact, "organizationId" | "facilityId">>,
  ): Promise<FacilityContact | undefined>;
  deleteFacilityContact(organizationId: number, id: number): Promise<boolean>;

  // Facility products (many per facility)
  createFacilityProduct(product: InsertFacilityProduct): Promise<FacilityProduct>;
  listFacilityProducts(organizationId: number, facilityId: number): Promise<FacilityProduct[]>;
  updateFacilityProduct(
    organizationId: number,
    id: number,
    data: Partial<Omit<InsertFacilityProduct, "organizationId" | "facilityId">>,
  ): Promise<FacilityProduct | undefined>;
  deleteFacilityProduct(organizationId: number, id: number): Promise<boolean>;

  // Source streams (many per facility+reportingBoundary) -- the core new entity
  createSourceStream(stream: InsertSourceStream): Promise<SourceStream>;
  listSourceStreams(organizationId: number, reportingBoundaryId: number): Promise<SourceStream[]>;
  getSourceStream(organizationId: number, id: number): Promise<SourceStream | undefined>;
  updateSourceStream(
    organizationId: number,
    id: number,
    data: Partial<Omit<InsertSourceStream, "organizationId" | "facilityId" | "reportingBoundaryId">>,
  ): Promise<SourceStream | undefined>;
  deleteSourceStream(organizationId: number, id: number): Promise<boolean>;

  // Calculation approaches (1:1 per source stream, unique on sourceStreamId)
  upsertCalculationApproach(data: InsertCalculationApproach): Promise<CalculationApproach>;
  getCalculationApproach(organizationId: number, sourceStreamId: number): Promise<CalculationApproach | undefined>;

  // Measurement-based approaches (1:1 per source stream, unique on sourceStreamId)
  upsertMeasurementBasedApproach(data: InsertMeasurementBasedApproach): Promise<MeasurementBasedApproach>;
  getMeasurementBasedApproach(
    organizationId: number,
    sourceStreamId: number,
  ): Promise<MeasurementBasedApproach | undefined>;

  // Fallback approaches (1:1 per source stream, unique on sourceStreamId)
  upsertFallbackApproach(data: InsertFallbackApproach): Promise<FallbackApproach>;
  getFallbackApproach(organizationId: number, sourceStreamId: number): Promise<FallbackApproach | undefined>;

  // Methane reports (1 per facility+reportingBoundary, unique on the pair)
  upsertMethaneReport(data: InsertMethaneReport): Promise<MethaneReport>;
  getMethaneReport(
    organizationId: number,
    facilityId: number,
    reportingBoundaryId: number,
  ): Promise<MethaneReport | undefined>;

  // Data quality records (1:1 per source stream, unique on sourceStreamId)
  upsertDataQualityRecord(data: InsertDataQualityRecord): Promise<DataQualityRecord>;
  getDataQualityRecord(organizationId: number, sourceStreamId: number): Promise<DataQualityRecord | undefined>;

  // Verification findings (many per reportingBoundary)
  createVerificationFinding(finding: InsertVerificationFinding): Promise<VerificationFinding>;
  listVerificationFindings(organizationId: number, reportingBoundaryId: number): Promise<VerificationFinding[]>;
  updateVerificationFinding(
    organizationId: number,
    id: number,
    data: Partial<Omit<InsertVerificationFinding, "organizationId" | "reportingBoundaryId">>,
  ): Promise<VerificationFinding | undefined>;
  deleteVerificationFinding(organizationId: number, id: number): Promise<boolean>;

  // Management QA records (many per reportingBoundary)
  createManagementQaRecord(record: InsertManagementQaRecord): Promise<ManagementQaRecord>;
  listManagementQaRecords(organizationId: number, reportingBoundaryId: number): Promise<ManagementQaRecord[]>;
  updateManagementQaRecord(
    organizationId: number,
    id: number,
    data: Partial<Omit<InsertManagementQaRecord, "organizationId" | "reportingBoundaryId">>,
  ): Promise<ManagementQaRecord | undefined>;
  deleteManagementQaRecord(organizationId: number, id: number): Promise<boolean>;

  // Mitigation measures (many per facility)
  createMitigationMeasure(measure: InsertMitigationMeasure): Promise<MitigationMeasure>;
  listMitigationMeasures(organizationId: number, facilityId: number): Promise<MitigationMeasure[]>;
  updateMitigationMeasure(
    organizationId: number,
    id: number,
    data: Partial<Omit<InsertMitigationMeasure, "organizationId" | "facilityId">>,
  ): Promise<MitigationMeasure | undefined>;
  deleteMitigationMeasure(organizationId: number, id: number): Promise<boolean>;

  // Reference data (global, not tenant-scoped, read-only)
  listPrimaryActivityTypes(): Promise<PrimaryActivityType[]>;
  listProductBenchmarks(): Promise<ProductBenchmark[]>;
  listIsicDivisions(): Promise<IsicDivision[]>;
  listIpccDefaultFactors(): Promise<IpccDefaultFactor[]>;
  listGwpValues(): Promise<GwpValue[]>;

  // Consolidated multi-facility rollup report (Plan 3's auditable global
  // data sheet) -- sums every facility under a reporting entity for a
  // given reporting boundary/year, applying equity-share percentages when
  // that's the declared consolidation approach.
  getConsolidatedReport(organizationId: number, reportingBoundaryId: number): Promise<ConsolidatedReport | undefined>;

  // Per-source-stream calculation detail for Excel export: data neither the
  // consolidated report nor any other existing query provides.
  getSourceStreamDetailForBoundary(organizationId: number, reportingBoundaryId: number): Promise<SourceStreamDetail[]>;

  // Platform admin (super-admin only, cross-tenant). Like
  // deleteExpiredUnverifiedRegistrations above, these take no
  // organizationId -- a super-admin isn't scoped to one tenant. The
  // membership/account methods below double as the org-admin implementation
  // too (Task 6) via the optional scopedToOrgId parameter.
  listAllUsersForAdmin(params: {
    search?: string;
    organizationId?: number;
    limit: number;
    offset: number;
  }): Promise<{ users: AdminUserListItem[]; total: number }>;
  listAllOrganizationsForAdmin(): Promise<AdminOrganizationListItem[]>;
  deleteUnverifiedUserById(userId: number, actorUserId: number): Promise<"deleted" | "not_found" | "already_verified">;
  promoteToSuperAdmin(userId: number): Promise<void>;
  demoteFromSuperAdmin(userId: number): Promise<void>;
  getMembershipById(membershipId: number, scopedToOrgId?: number): Promise<Membership | undefined>;
  deactivateMembership(membershipId: number, scopedToOrgId?: number): Promise<Membership | undefined>;
  activateMembership(membershipId: number, scopedToOrgId?: number): Promise<Membership | undefined>;
  deactivateAccount(userId: number): Promise<void>;
  reactivateAccount(userId: number): Promise<void>;
  setNewEmailPendingVerification(
    userId: number,
    newEmail: string,
    resetToken: string,
    resetTokenExpiresAt: Date,
  ): Promise<void>;
  logAdminAction(entry: {
    actorUserId: number;
    action:
      | "verify"
      | "delete"
      | "promote"
      | "demote"
      | "deactivate_membership"
      | "activate_membership"
      | "deactivate_user"
      | "activate_user"
      | "change_email"
      | "reset_password";
    targetUserId: number;
    targetEmail: string;
    organizationId?: number;
    organizationName?: string;
    note?: string;
  }): Promise<AdminActionLog>;
  listAdminActionLog(): Promise<AdminActionLogEntry[]>;
  listAdminActionLogForOrganization(organizationId: number): Promise<AdminActionLogEntry[]>;
}

export class DbStorage implements IStorage {
  async createOrganization(org: InsertOrganization): Promise<Organization> {
    const [row] = await db.insert(organizations).values(org).returning();
    return row;
  }

  async getOrganization(id: number): Promise<Organization | undefined> {
    const [row] = await db.select().from(organizations).where(eq(organizations.id, id));
    return row;
  }

  async getOrganizationBySlug(slug: string): Promise<Organization | undefined> {
    const [row] = await db.select().from(organizations).where(eq(organizations.slug, slug));
    return row;
  }

  async createUser(user: InsertUser): Promise<User> {
    const [row] = await db.insert(users).values(user).returning();
    return row;
  }

  async getUser(id: number): Promise<User | undefined> {
    const [row] = await db.select().from(users).where(eq(users.id, id));
    return row;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [row] = await db.select().from(users).where(eq(users.email, email));
    return row;
  }

  async getUserByPasswordResetToken(token: string): Promise<User | undefined> {
    const [row] = await db.select().from(users).where(eq(users.passwordResetToken, token));
    return row;
  }

  async setPasswordResetToken(userId: number, token: string, expiresAt: Date): Promise<void> {
    await db
      .update(users)
      .set({ passwordResetToken: token, passwordResetTokenExpiresAt: expiresAt })
      .where(eq(users.id, userId));
  }

  async resetPassword(userId: number, passwordHash: string): Promise<void> {
    await db
      .update(users)
      .set({
        passwordHash,
        passwordResetToken: null,
        passwordResetTokenExpiresAt: null,
        emailVerified: true,
        // Invariant: hasBeenVerified must be true wherever emailVerified has
        // ever been true, so every method that sets emailVerified: true sets
        // this too (here and verifyUserEmail below are the only two). This
        // path in particular is how a change-emailed account claims its new
        // address, and how an admin-triggered reset on a never-verified
        // account verifies it -- without this, that second case would end up
        // verified but still matched by both hard-delete paths.
        hasBeenVerified: true,
      })
      .where(eq(users.id, userId));
  }

  // Self-service display-name edit. Deliberately unrestricted to any
  // authenticated user (not super-admin-only) -- there's no reason someone's
  // own display name should need an admin. `name` arriving null means "clear
  // it" (falls back to email display elsewhere in the UI), matching how the
  // registration flow already treats an unset name.
  async updateOwnName(userId: number, name: string | null): Promise<void> {
    await db.update(users).set({ name }).where(eq(users.id, userId));
  }

  async getUserByVerificationToken(token: string): Promise<User | undefined> {
    const [row] = await db.select().from(users).where(eq(users.emailVerificationToken, token));
    return row;
  }

  // Single point for "this account is now verified", serving both the
  // self-service POST /api/auth/verify-email path and the super-admin panel's
  // POST /api/admin/users/:id/verify. hasBeenVerified is set here alongside
  // emailVerified and, unlike emailVerified, is never set back to false --
  // that stickiness is what lets the two hard-delete paths tell a genuine
  // never-verified registration apart from a live account that is only
  // temporarily unverified because an admin changed its email.
  async verifyUserEmail(userId: number): Promise<void> {
    await db
      .update(users)
      .set({
        emailVerified: true,
        hasBeenVerified: true,
        emailVerificationToken: null,
        emailVerificationTokenExpiresAt: null,
      })
      .where(eq(users.id, userId));
  }

  async setEmailVerificationToken(userId: number, token: string, expiresAt: Date): Promise<void> {
    await db
      .update(users)
      .set({ emailVerificationToken: token, emailVerificationTokenExpiresAt: expiresAt })
      .where(eq(users.id, userId));
  }

  async deleteExpiredUnverifiedRegistrations(): Promise<number> {
    const now = new Date();
    // hasBeenVerified, not emailVerified -- same reason as
    // deleteUnverifiedUserById below, but this path is worse because it needs
    // no admin action at all. An account whose email an admin changed sits at
    // emailVerified = false with a live organization behind it; the affected
    // user, told to verify their email, clicks the perfectly legitimate
    // "resend verification email" and thereby ARMS a fresh 24-hour
    // email_verification_token_expires_at. This sweep then matched them and
    // deleted the user and their organizations unattended. Only a genuinely
    // never-verified registration is eligible.
    const expired = await db
      .select({
        userId: users.id,
        organizationId: memberships.organizationId,
        role: memberships.role,
      })
      .from(users)
      .innerJoin(memberships, eq(memberships.userId, users.id))
      .where(and(eq(users.hasBeenVerified, false), lt(users.emailVerificationTokenExpiresAt, now)));

    if (expired.length === 0) return 0;

    const userIds = Array.from(new Set(expired.map((r) => r.userId)));

    // Org deletion is scoped exactly the way deleteUnverifiedUserById scopes
    // it: only an org the matched user OWNS, and only when no OTHER user
    // holds a membership in it. This method previously deleted EVERY
    // organization a matched user belonged to, with no owner-role or
    // solo-membership check at all -- so a matched user who had been added to
    // someone else's live tenant via POST /api/team/invite (which has no
    // emailVerified gate) would take that unrelated tenant down with them.
    // That was deferred as unreachable when only never-verified accounts
    // could match here; the change-email path above demonstrably reaches it,
    // so it is scoped now.
    const candidateOwnedOrgIds = Array.from(
      new Set(expired.filter((r) => r.role === "owner").map((r) => r.organizationId)),
    );
    const orgIds: number[] = [];
    for (const orgId of candidateOwnedOrgIds) {
      // "Other" means any member who is not itself being swept in this same
      // run -- notInArray over the whole matched set, rather than
      // deleteUnverifiedUserById's single-target ne(), because a sweep can
      // match several users at once and two of them sharing one org must not
      // each veto the other's cleanup.
      const otherMembers = await db
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(and(eq(memberships.organizationId, orgId), notInArray(memberships.userId, userIds)));
      if (otherMembers.length === 0) orgIds.push(orgId);
    }

    // organizations.id cascades to memberships (see shared/schema.ts), so
    // deleting the org already clears its membership row(s). Deleting the
    // users afterward is defensive -- in case a user row ever exists
    // without a membership, which shouldn't happen given registration
    // always creates exactly one, but this keeps the sweep correct even if
    // that ever changes. A matched user whose org was NOT eligible for
    // deletion above still has their own user row removed here, and their
    // membership rows cascade off users.id -- same as
    // deleteUnverifiedUserById's otherMembers.length > 0 branch.
    //
    // Both deletes run via db.batch() (a single atomic HTTP round-trip on
    // Neon's driver) rather than sequential awaits, so a crash between the
    // two can't happen. That matters here specifically: if the org delete
    // committed but the user delete didn't, the orphaned user would no
    // longer join to any membership row on the next sweep (it cascaded away
    // with the org) and would become a permanently invisible leak that no
    // future run could ever find. Note db.transaction() is NOT an option
    // here -- this project's db client uses drizzle-orm/neon-http, whose
    // .transaction() throws "No transactions support in neon-http driver"
    // at runtime; db.batch() is the driver's actual atomic-multi-statement
    // primitive.
    // orgIds can legitimately be empty now that org deletion is scoped (every
    // matched user was a non-owner, or shared their org with someone not
    // being swept), and db.batch() needs at least one statement -- so the org
    // delete is only included when there is actually an org to delete.
    const statements = [];
    if (orgIds.length > 0) {
      statements.push(db.delete(organizations).where(inArray(organizations.id, orgIds)));
    }
    statements.push(db.delete(users).where(inArray(users.id, userIds)));
    await db.batch(statements as [(typeof statements)[number], ...typeof statements]);

    return userIds.length;
  }

  async createMembership(membership: InsertMembership): Promise<Membership> {
    const [row] = await db.insert(memberships).values(membership).returning();
    return row;
  }

  async getMembershipsForUser(userId: number): Promise<Membership[]> {
    return db.select().from(memberships).where(eq(memberships.userId, userId));
  }

  // Used by requireOrg and, since the 2026-09-09 final-review fix wave (I3),
  // by GET /api/auth/me too -- an inactive membership must be invisible both to
  // tenant-access resolution and to the client deciding which organization it
  // is looking at, or the two disagree and the UI mislabels whose data it is
  // showing. getMembershipsForUser above (all memberships, active or not) is
  // unchanged but now has no server callers left: the sole-organization
  // boundary check (isUsersSoleOrganization below) deliberately counts ALL
  // membership rows and does its own query for that.
  async getActiveMembershipsForUser(userId: number): Promise<Membership[]> {
    return db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.isActive, true)));
  }

  async getMembership(userId: number, organizationId: number): Promise<Membership | undefined> {
    const [row] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.organizationId, organizationId)));
    return row;
  }

  async getEnabledModuleKeys(organizationId: number): Promise<string[]> {
    const rows = await db
      .select({ moduleKey: organizationModules.moduleKey })
      .from(organizationModules)
      .where(eq(organizationModules.organizationId, organizationId));
    const grantedKeys = rows.map((r) => r.moduleKey).filter(isKnownModuleKey);
    const alwaysEnabledKeys = Object.entries(MODULE_REGISTRY)
      .filter(([, def]) => def.alwaysEnabled)
      .map(([key]) => key);
    return Array.from(new Set([...alwaysEnabledKeys, ...grantedKeys]));
  }

  // Boundary rule for org-admin account-wide actions (deactivate/reactivate
  // an account, change its email, admin-trigger a password reset): an
  // org-admin may only act if the target's memberships -- ALL of them,
  // active or not, since even a deactivated membership represents a
  // relationship with that org the acting org-admin has no authority over
  // -- resolve to exactly this one organization. Membership-level actions
  // (deactivate/activate one membership) don't need this check; they can
  // never affect another tenant by construction.
  async isUsersSoleOrganization(userId: number, organizationId: number): Promise<boolean> {
    const all = await db.select().from(memberships).where(eq(memberships.userId, userId));
    return all.length === 1 && all[0].organizationId === organizationId;
  }

  async listMembershipsForOrganization(
    organizationId: number,
  ): Promise<(Membership & { userEmail: string; userName: string | null; userIsActive: boolean })[]> {
    const rows = await db
      .select({
        id: memberships.id,
        userId: memberships.userId,
        organizationId: memberships.organizationId,
        role: memberships.role,
        isActive: memberships.isActive,
        createdAt: memberships.createdAt,
        userEmail: users.email,
        userName: users.name,
        userIsActive: users.isActive,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.organizationId, organizationId))
      .orderBy(desc(memberships.createdAt));
    return rows;
  }

  async createEmissionFactors(
    organizationId: number,
    factors: Omit<InsertEmissionFactorRow, "organizationId">[],
  ): Promise<EmissionFactorRow[]> {
    if (factors.length === 0) return [];
    const rows = factors.map((f) => ({ ...f, organizationId }));
    // onConflictDoUpdate on (organizationId, name): re-uploading a file that
    // repeats an activity name (fixing a typo, refreshing the same batch)
    // updates that row in place instead of throwing a unique-constraint
    // error. Safe without the extra setWhere org-scoping guard the other
    // upsertX methods in this file need -- organizationId is itself part
    // of this composite conflict target, so a conflict can only ever be
    // against a row already scoped to the same org.
    return db
      .insert(emissionFactorsTable)
      .values(rows)
      .onConflictDoUpdate({
        target: [emissionFactorsTable.organizationId, emissionFactorsTable.name],
        set: {
          factor: sql`excluded.factor`,
          unit: sql`excluded.unit`,
          scope: sql`excluded.scope`,
          category: sql`excluded.category`,
          wasteType: sql`excluded.waste_type`,
          disposalMethod: sql`excluded.disposal_method`,
          source: sql`excluded.source`,
          year: sql`excluded.year`,
          sourceUrl: sql`excluded.source_url`,
          authorityName: sql`excluded.authority_name`,
          sourceTier: sql`excluded.source_tier`,
          country: sql`excluded.country`,
          uploadedBy: sql`excluded.uploaded_by`,
        },
      })
      .returning();
  }

  async listEmissionFactors(organizationId: number): Promise<EmissionFactorRow[]> {
    return db
      .select()
      .from(emissionFactorsTable)
      .where(eq(emissionFactorsTable.organizationId, organizationId))
      .orderBy(desc(emissionFactorsTable.createdAt));
  }

  async deleteEmissionFactor(organizationId: number, factorId: number): Promise<boolean> {
    const deleted = await db
      .delete(emissionFactorsTable)
      .where(and(eq(emissionFactorsTable.id, factorId), eq(emissionFactorsTable.organizationId, organizationId)))
      .returning({ id: emissionFactorsTable.id });
    return deleted.length > 0;
  }

  async createEmissionRecords(
    organizationId: number,
    records: Omit<InsertEmissionRecordRow, "organizationId">[],
  ): Promise<EmissionRecordRow[]> {
    if (records.length === 0) return [];
    const rows = records.map((r) => ({ ...r, organizationId }));
    return db.insert(emissionRecordsTable).values(rows).returning();
  }

  async listEmissionRecords(organizationId: number): Promise<EmissionRecordRow[]> {
    return db
      .select()
      .from(emissionRecordsTable)
      .where(eq(emissionRecordsTable.organizationId, organizationId))
      .orderBy(desc(emissionRecordsTable.createdAt));
  }

  async upsertEmissionRecordForCalculationApproach(data: {
    organizationId: number;
    facilityId: number;
    sourceStreamId: number;
    calculationApproachId: number;
    reportingBoundaryId: number;
    createdBy: number;
    scope: string;
    activity: string;
    unit: string;
    quantity: string;
    factor: string;
    emission: string;
    // See IStorage for why this is optional rather than `unknown`.
    gasBreakdown?: unknown;
  }): Promise<EmissionRecordRow> {
    const [row] = await db
      .insert(emissionRecordsTable)
      .values(data)
      .onConflictDoUpdate({
        target: emissionRecordsTable.calculationApproachId,
        set: data,
        setWhere: eq(emissionRecordsTable.organizationId, data.organizationId),
      })
      .returning();
    if (!row) {
      throw new Error(
        "upsertEmissionRecordForCalculationApproach: conflicting row belongs to a different organization",
      );
    }
    return row;
  }

  // --- ISO 14064-1 boundary setup ---

  async createReportingEntity(entity: InsertReportingEntity): Promise<ReportingEntity> {
    const [row] = await db.insert(reportingEntities).values(entity).returning();
    return row;
  }

  async listReportingEntities(organizationId: number): Promise<ReportingEntity[]> {
    return db
      .select()
      .from(reportingEntities)
      .where(eq(reportingEntities.organizationId, organizationId))
      .orderBy(desc(reportingEntities.createdAt));
  }

  async getReportingEntity(organizationId: number, id: number): Promise<ReportingEntity | undefined> {
    const [row] = await db
      .select()
      .from(reportingEntities)
      .where(and(eq(reportingEntities.id, id), eq(reportingEntities.organizationId, organizationId)));
    return row;
  }

  async updateReportingEntity(
    organizationId: number,
    id: number,
    data: Partial<Pick<InsertReportingEntity, "name" | "legalEntity" | "baseYear" | "baseYearRationale">>,
  ): Promise<ReportingEntity | undefined> {
    const [row] = await db
      .update(reportingEntities)
      .set(data)
      .where(and(eq(reportingEntities.id, id), eq(reportingEntities.organizationId, organizationId)))
      .returning();
    return row;
  }

  async deleteReportingEntity(organizationId: number, id: number): Promise<boolean> {
    const deleted = await db
      .delete(reportingEntities)
      .where(and(eq(reportingEntities.id, id), eq(reportingEntities.organizationId, organizationId)))
      .returning({ id: reportingEntities.id });
    return deleted.length > 0;
  }

  async createFacility(facility: InsertFacility): Promise<Facility> {
    const [row] = await db.insert(facilities).values(facility).returning();
    return row;
  }

  async listFacilities(organizationId: number): Promise<Facility[]> {
    return db
      .select()
      .from(facilities)
      .where(eq(facilities.organizationId, organizationId))
      .orderBy(desc(facilities.createdAt));
  }

  async getFacility(organizationId: number, id: number): Promise<Facility | undefined> {
    const [row] = await db
      .select()
      .from(facilities)
      .where(and(eq(facilities.id, id), eq(facilities.organizationId, organizationId)));
    return row;
  }

  async updateFacility(
    organizationId: number,
    id: number,
    data: Partial<Pick<InsertFacility, "name" | "country" | "equityShareOwnershipPercent">>,
  ): Promise<Facility | undefined> {
    const [row] = await db
      .update(facilities)
      .set(data)
      .where(and(eq(facilities.id, id), eq(facilities.organizationId, organizationId)))
      .returning();
    return row;
  }

  async deleteFacility(organizationId: number, id: number): Promise<boolean> {
    const deleted = await db
      .delete(facilities)
      .where(and(eq(facilities.id, id), eq(facilities.organizationId, organizationId)))
      .returning({ id: facilities.id });
    return deleted.length > 0;
  }

  async createReportingBoundary(boundary: InsertReportingBoundary): Promise<ReportingBoundary> {
    const [row] = await db.insert(reportingBoundaries).values(boundary).returning();
    return row;
  }

  async listReportingBoundaries(organizationId: number): Promise<ReportingBoundary[]> {
    return db
      .select()
      .from(reportingBoundaries)
      .where(eq(reportingBoundaries.organizationId, organizationId))
      .orderBy(desc(reportingBoundaries.createdAt));
  }

  async getReportingBoundary(organizationId: number, id: number): Promise<ReportingBoundary | undefined> {
    const [row] = await db
      .select()
      .from(reportingBoundaries)
      .where(and(eq(reportingBoundaries.id, id), eq(reportingBoundaries.organizationId, organizationId)));
    return row;
  }

  async updateReportingBoundary(
    organizationId: number,
    id: number,
    data: Partial<
      Pick<
        InsertReportingBoundary,
        | "reportingYear"
        | "consolidationApproach"
        | "description"
        | "status"
        | "finalizedAt"
        | "revenueAmount"
        | "revenueCurrency"
        | "fullTimeEquivalentEmployees"
      >
    >,
  ): Promise<ReportingBoundary | undefined> {
    const [row] = await db
      .update(reportingBoundaries)
      .set(data)
      .where(and(eq(reportingBoundaries.id, id), eq(reportingBoundaries.organizationId, organizationId)))
      .returning();
    return row;
  }

  async deleteReportingBoundary(organizationId: number, id: number): Promise<boolean> {
    const deleted = await db
      .delete(reportingBoundaries)
      .where(and(eq(reportingBoundaries.id, id), eq(reportingBoundaries.organizationId, organizationId)))
      .returning({ id: reportingBoundaries.id });
    return deleted.length > 0;
  }

  // --- Facility-level MRV granularity layer ---

  async getFacilityIdentifier(organizationId: number, facilityId: number): Promise<FacilityIdentifier | undefined> {
    const [row] = await db
      .select()
      .from(facilityIdentifiers)
      .where(
        and(eq(facilityIdentifiers.facilityId, facilityId), eq(facilityIdentifiers.organizationId, organizationId)),
      );
    return row;
  }

  async upsertFacilityIdentifier(data: InsertFacilityIdentifier): Promise<FacilityIdentifier> {
    const [row] = await db
      .insert(facilityIdentifiers)
      .values(data)
      .onConflictDoUpdate({
        target: facilityIdentifiers.facilityId,
        set: data,
        setWhere: eq(facilityIdentifiers.organizationId, data.organizationId),
      })
      .returning();
    if (!row) {
      throw new Error("upsertFacilityIdentifier: conflicting row belongs to a different organization");
    }
    return row;
  }

  async createFacilityContact(contact: InsertFacilityContact): Promise<FacilityContact> {
    const [row] = await db.insert(facilityContacts).values(contact).returning();
    return row;
  }

  async listFacilityContacts(organizationId: number, facilityId: number): Promise<FacilityContact[]> {
    return db
      .select()
      .from(facilityContacts)
      .where(and(eq(facilityContacts.facilityId, facilityId), eq(facilityContacts.organizationId, organizationId)))
      .orderBy(desc(facilityContacts.createdAt));
  }

  async updateFacilityContact(
    organizationId: number,
    id: number,
    data: Partial<Omit<InsertFacilityContact, "organizationId" | "facilityId">>,
  ): Promise<FacilityContact | undefined> {
    const [row] = await db
      .update(facilityContacts)
      .set(data)
      .where(and(eq(facilityContacts.id, id), eq(facilityContacts.organizationId, organizationId)))
      .returning();
    return row;
  }

  async deleteFacilityContact(organizationId: number, id: number): Promise<boolean> {
    const deleted = await db
      .delete(facilityContacts)
      .where(and(eq(facilityContacts.id, id), eq(facilityContacts.organizationId, organizationId)))
      .returning({ id: facilityContacts.id });
    return deleted.length > 0;
  }

  async createFacilityProduct(product: InsertFacilityProduct): Promise<FacilityProduct> {
    const [row] = await db.insert(facilityProducts).values(product).returning();
    return row;
  }

  async listFacilityProducts(organizationId: number, facilityId: number): Promise<FacilityProduct[]> {
    return db
      .select()
      .from(facilityProducts)
      .where(and(eq(facilityProducts.facilityId, facilityId), eq(facilityProducts.organizationId, organizationId)))
      .orderBy(desc(facilityProducts.createdAt));
  }

  async updateFacilityProduct(
    organizationId: number,
    id: number,
    data: Partial<Omit<InsertFacilityProduct, "organizationId" | "facilityId">>,
  ): Promise<FacilityProduct | undefined> {
    const [row] = await db
      .update(facilityProducts)
      .set(data)
      .where(and(eq(facilityProducts.id, id), eq(facilityProducts.organizationId, organizationId)))
      .returning();
    return row;
  }

  async deleteFacilityProduct(organizationId: number, id: number): Promise<boolean> {
    const deleted = await db
      .delete(facilityProducts)
      .where(and(eq(facilityProducts.id, id), eq(facilityProducts.organizationId, organizationId)))
      .returning({ id: facilityProducts.id });
    return deleted.length > 0;
  }

  async createSourceStream(stream: InsertSourceStream): Promise<SourceStream> {
    const [row] = await db.insert(sourceStreams).values(stream).returning();
    return row;
  }

  async listSourceStreams(organizationId: number, reportingBoundaryId: number): Promise<SourceStream[]> {
    return db
      .select()
      .from(sourceStreams)
      .where(
        and(
          eq(sourceStreams.reportingBoundaryId, reportingBoundaryId),
          eq(sourceStreams.organizationId, organizationId),
        ),
      )
      .orderBy(desc(sourceStreams.createdAt));
  }

  async getSourceStream(organizationId: number, id: number): Promise<SourceStream | undefined> {
    const [row] = await db
      .select()
      .from(sourceStreams)
      .where(and(eq(sourceStreams.id, id), eq(sourceStreams.organizationId, organizationId)));
    return row;
  }

  async updateSourceStream(
    organizationId: number,
    id: number,
    data: Partial<Omit<InsertSourceStream, "organizationId" | "facilityId" | "reportingBoundaryId">>,
  ): Promise<SourceStream | undefined> {
    const [row] = await db
      .update(sourceStreams)
      .set(data)
      .where(and(eq(sourceStreams.id, id), eq(sourceStreams.organizationId, organizationId)))
      .returning();
    return row;
  }

  async deleteSourceStream(organizationId: number, id: number): Promise<boolean> {
    const deleted = await db
      .delete(sourceStreams)
      .where(and(eq(sourceStreams.id, id), eq(sourceStreams.organizationId, organizationId)))
      .returning({ id: sourceStreams.id });
    return deleted.length > 0;
  }

  async upsertCalculationApproach(data: InsertCalculationApproach): Promise<CalculationApproach> {
    const [row] = await db
      .insert(calculationApproaches)
      .values(data)
      .onConflictDoUpdate({
        target: calculationApproaches.sourceStreamId,
        set: data,
        setWhere: eq(calculationApproaches.organizationId, data.organizationId),
      })
      .returning();
    if (!row) {
      throw new Error("upsertCalculationApproach: conflicting row belongs to a different organization");
    }
    return row;
  }

  async getCalculationApproach(
    organizationId: number,
    sourceStreamId: number,
  ): Promise<CalculationApproach | undefined> {
    const [row] = await db
      .select()
      .from(calculationApproaches)
      .where(
        and(
          eq(calculationApproaches.sourceStreamId, sourceStreamId),
          eq(calculationApproaches.organizationId, organizationId),
        ),
      );
    return row;
  }

  async upsertMeasurementBasedApproach(data: InsertMeasurementBasedApproach): Promise<MeasurementBasedApproach> {
    const [row] = await db
      .insert(measurementBasedApproaches)
      .values(data)
      .onConflictDoUpdate({
        target: measurementBasedApproaches.sourceStreamId,
        set: data,
        setWhere: eq(measurementBasedApproaches.organizationId, data.organizationId),
      })
      .returning();
    if (!row) {
      throw new Error("upsertMeasurementBasedApproach: conflicting row belongs to a different organization");
    }
    return row;
  }

  async getMeasurementBasedApproach(
    organizationId: number,
    sourceStreamId: number,
  ): Promise<MeasurementBasedApproach | undefined> {
    const [row] = await db
      .select()
      .from(measurementBasedApproaches)
      .where(
        and(
          eq(measurementBasedApproaches.sourceStreamId, sourceStreamId),
          eq(measurementBasedApproaches.organizationId, organizationId),
        ),
      );
    return row;
  }

  async upsertFallbackApproach(data: InsertFallbackApproach): Promise<FallbackApproach> {
    const [row] = await db
      .insert(fallbackApproaches)
      .values(data)
      .onConflictDoUpdate({
        target: fallbackApproaches.sourceStreamId,
        set: data,
        setWhere: eq(fallbackApproaches.organizationId, data.organizationId),
      })
      .returning();
    if (!row) {
      throw new Error("upsertFallbackApproach: conflicting row belongs to a different organization");
    }
    return row;
  }

  async getFallbackApproach(organizationId: number, sourceStreamId: number): Promise<FallbackApproach | undefined> {
    const [row] = await db
      .select()
      .from(fallbackApproaches)
      .where(
        and(
          eq(fallbackApproaches.sourceStreamId, sourceStreamId),
          eq(fallbackApproaches.organizationId, organizationId),
        ),
      );
    return row;
  }

  async upsertMethaneReport(data: InsertMethaneReport): Promise<MethaneReport> {
    const [row] = await db
      .insert(methaneReports)
      .values(data)
      .onConflictDoUpdate({
        target: [methaneReports.facilityId, methaneReports.reportingBoundaryId],
        set: data,
        setWhere: eq(methaneReports.organizationId, data.organizationId),
      })
      .returning();
    if (!row) {
      throw new Error("upsertMethaneReport: conflicting row belongs to a different organization");
    }
    return row;
  }

  async getMethaneReport(
    organizationId: number,
    facilityId: number,
    reportingBoundaryId: number,
  ): Promise<MethaneReport | undefined> {
    const [row] = await db
      .select()
      .from(methaneReports)
      .where(
        and(
          eq(methaneReports.organizationId, organizationId),
          eq(methaneReports.facilityId, facilityId),
          eq(methaneReports.reportingBoundaryId, reportingBoundaryId),
        ),
      );
    return row;
  }

  async upsertDataQualityRecord(data: InsertDataQualityRecord): Promise<DataQualityRecord> {
    const [row] = await db
      .insert(dataQualityRecords)
      .values(data)
      .onConflictDoUpdate({
        target: dataQualityRecords.sourceStreamId,
        set: data,
        setWhere: eq(dataQualityRecords.organizationId, data.organizationId),
      })
      .returning();
    if (!row) {
      throw new Error("upsertDataQualityRecord: conflicting row belongs to a different organization");
    }
    return row;
  }

  async getDataQualityRecord(organizationId: number, sourceStreamId: number): Promise<DataQualityRecord | undefined> {
    const [row] = await db
      .select()
      .from(dataQualityRecords)
      .where(
        and(
          eq(dataQualityRecords.sourceStreamId, sourceStreamId),
          eq(dataQualityRecords.organizationId, organizationId),
        ),
      );
    return row;
  }

  async createVerificationFinding(finding: InsertVerificationFinding): Promise<VerificationFinding> {
    const [row] = await db.insert(verificationFindings).values(finding).returning();
    return row;
  }

  async listVerificationFindings(organizationId: number, reportingBoundaryId: number): Promise<VerificationFinding[]> {
    return db
      .select()
      .from(verificationFindings)
      .where(
        and(
          eq(verificationFindings.reportingBoundaryId, reportingBoundaryId),
          eq(verificationFindings.organizationId, organizationId),
        ),
      )
      .orderBy(desc(verificationFindings.createdAt));
  }

  async updateVerificationFinding(
    organizationId: number,
    id: number,
    data: Partial<Omit<InsertVerificationFinding, "organizationId" | "reportingBoundaryId">>,
  ): Promise<VerificationFinding | undefined> {
    const [row] = await db
      .update(verificationFindings)
      .set(data)
      .where(and(eq(verificationFindings.id, id), eq(verificationFindings.organizationId, organizationId)))
      .returning();
    return row;
  }

  async deleteVerificationFinding(organizationId: number, id: number): Promise<boolean> {
    const deleted = await db
      .delete(verificationFindings)
      .where(and(eq(verificationFindings.id, id), eq(verificationFindings.organizationId, organizationId)))
      .returning({ id: verificationFindings.id });
    return deleted.length > 0;
  }

  async createManagementQaRecord(record: InsertManagementQaRecord): Promise<ManagementQaRecord> {
    const [row] = await db.insert(managementQaRecords).values(record).returning();
    return row;
  }

  async listManagementQaRecords(organizationId: number, reportingBoundaryId: number): Promise<ManagementQaRecord[]> {
    return db
      .select()
      .from(managementQaRecords)
      .where(
        and(
          eq(managementQaRecords.reportingBoundaryId, reportingBoundaryId),
          eq(managementQaRecords.organizationId, organizationId),
        ),
      )
      .orderBy(desc(managementQaRecords.createdAt));
  }

  async updateManagementQaRecord(
    organizationId: number,
    id: number,
    data: Partial<Omit<InsertManagementQaRecord, "organizationId" | "reportingBoundaryId">>,
  ): Promise<ManagementQaRecord | undefined> {
    const [row] = await db
      .update(managementQaRecords)
      .set(data)
      .where(and(eq(managementQaRecords.id, id), eq(managementQaRecords.organizationId, organizationId)))
      .returning();
    return row;
  }

  async deleteManagementQaRecord(organizationId: number, id: number): Promise<boolean> {
    const deleted = await db
      .delete(managementQaRecords)
      .where(and(eq(managementQaRecords.id, id), eq(managementQaRecords.organizationId, organizationId)))
      .returning({ id: managementQaRecords.id });
    return deleted.length > 0;
  }

  async createMitigationMeasure(measure: InsertMitigationMeasure): Promise<MitigationMeasure> {
    const [row] = await db.insert(mitigationMeasures).values(measure).returning();
    return row;
  }

  async listMitigationMeasures(organizationId: number, facilityId: number): Promise<MitigationMeasure[]> {
    return db
      .select()
      .from(mitigationMeasures)
      .where(and(eq(mitigationMeasures.facilityId, facilityId), eq(mitigationMeasures.organizationId, organizationId)))
      .orderBy(desc(mitigationMeasures.createdAt));
  }

  async updateMitigationMeasure(
    organizationId: number,
    id: number,
    data: Partial<Omit<InsertMitigationMeasure, "organizationId" | "facilityId">>,
  ): Promise<MitigationMeasure | undefined> {
    const [row] = await db
      .update(mitigationMeasures)
      .set(data)
      .where(and(eq(mitigationMeasures.id, id), eq(mitigationMeasures.organizationId, organizationId)))
      .returning();
    return row;
  }

  async deleteMitigationMeasure(organizationId: number, id: number): Promise<boolean> {
    const deleted = await db
      .delete(mitigationMeasures)
      .where(and(eq(mitigationMeasures.id, id), eq(mitigationMeasures.organizationId, organizationId)))
      .returning({ id: mitigationMeasures.id });
    return deleted.length > 0;
  }

  async listPrimaryActivityTypes(): Promise<PrimaryActivityType[]> {
    return db.select().from(primaryActivityTypes);
  }

  async listProductBenchmarks(): Promise<ProductBenchmark[]> {
    return db.select().from(productBenchmarks);
  }

  async listIsicDivisions(): Promise<IsicDivision[]> {
    return db.select().from(isicDivisions).orderBy(isicDivisions.sectionCode, isicDivisions.divisionCode);
  }

  async listIpccDefaultFactors(): Promise<IpccDefaultFactor[]> {
    return db.select().from(ipccDefaultFactors).orderBy(ipccDefaultFactors.category, ipccDefaultFactors.activityType);
  }

  async listGwpValues(): Promise<GwpValue[]> {
    return db.select().from(gwpValues).orderBy(gwpValues.gas);
  }

  async getConsolidatedReport(
    organizationId: number,
    reportingBoundaryId: number,
  ): Promise<ConsolidatedReport | undefined> {
    const boundary = await this.getReportingBoundary(organizationId, reportingBoundaryId);
    if (!boundary) return undefined;
    const entity = await this.getReportingEntity(organizationId, boundary.reportingEntityId);
    if (!entity) return undefined;

    const allFacilities = await this.listFacilities(organizationId);
    const entityFacilities = allFacilities.filter((f) => f.reportingEntityId === entity.id);

    const records = await db
      .select()
      .from(emissionRecordsTable)
      .where(
        and(
          eq(emissionRecordsTable.organizationId, organizationId),
          eq(emissionRecordsTable.reportingBoundaryId, reportingBoundaryId),
        ),
      );

    const isEquityShare = boundary.consolidationApproach === "equity_share";

    function facilityMultiplier(facilityId: number): number {
      if (!isEquityShare) return 1;
      const f = entityFacilities.find((x) => x.id === facilityId);
      const pct = f?.equityShareOwnershipPercent;
      return pct !== null && pct !== undefined ? Number(pct) / 100 : 0;
    }

    const scopeTotals = { scope1: 0, scope2: 0, scope3: 0 };
    const gasTotals = new Map<string, number>();
    // Native mass (metric tonnes of the gas itself, not CO2e) per gas --
    // GHG Protocol's required-reporting-content list states emissions
    // "shall include... data for all six GHGs separately... in metric
    // tonnes and in tonnes of CO2 equivalent," not CO2e alone.
    const gasNativeMassTotals = new Map<string, number>();
    const perFacilityScopeTotals = new Map<number, { scope1: number; scope2: number; scope3: number }>();
    // GRI 305-1 / GHG Protocol: CO2 from combusting biomass is reported as a
    // separate memo item, NOT inside gross Scope 1/2/3 (it is part of the
    // biological carbon cycle). This is a CO2-only rule -- CH4 and N2O from
    // the same biomass combustion are anthropogenic-forcing emissions like
    // any other and stay in the gross totals. Accumulated in tonnes, same
    // basis as scopeTotals.
    let biogenicCo2Tonnes = 0;

    for (const record of records) {
      if (!record.facilityId) continue;
      const multiplier = facilityMultiplier(record.facilityId);
      const emissionKg = Number(record.emission) * multiplier;
      const emissionTonnes = emissionKg / 1000;

      // gasBreakdown is stored in two shapes depending on which pipeline
      // wrote the record: the facility-MRV calculation-approach pipeline
      // (server/routes.ts PUT /api/source-streams/:id/calculation-approach,
      // the only pipeline that sets facilityId -- see the `continue` above)
      // persists shared/schema.ts's GasComponent[], a per-unit rate
      // (`co2ePerUnit`, kg CO2e per unit of activity data) that must be
      // multiplied by this record's quantity to get an absolute
      // contribution. The legacy /api/calculate pipeline persists
      // EmissionGasContribution[], an already-absolute `co2e` -- but those
      // records never set facilityId, so they're filtered out above and
      // this branch is defensive/future-proofing rather than reachable
      // today.
      //
      // This loop runs BEFORE the scope accumulation below because the
      // biogenic-CO2 share it computes has to be netted out of the record's
      // scope contribution. record.emission stays the authoritative gross
      // number for the record (it is what the calculation handler actually
      // computed and persisted); the components are used only to work out
      // how much of it is biogenic CO2, so no rounding drift is introduced
      // into the non-biogenic case -- a record with no biogenic component
      // contributes exactly record.emission as before.
      const breakdown =
        (record.gasBreakdown as
          { gas: string; co2e?: number; co2ePerUnit?: number; nativeFactor?: number; isBiogenic?: boolean }[] | null) ??
        [];
      const quantity = Number(record.quantity);
      let recordBiogenicCo2Tonnes = 0;
      for (const component of breakdown) {
        const componentEmissionKg =
          component.co2e !== undefined ? component.co2e : quantity * (component.co2ePerUnit ?? 0);
        const componentTonnes = (componentEmissionKg * multiplier) / 1000;
        if (component.gas === "CO2" && component.isBiogenic === true) {
          recordBiogenicCo2Tonnes += componentTonnes;
          // Held out of gasTotals too, so the "Emissions by gas" table and
          // its % column reconcile to the same gross total the scope cards
          // show. Biogenic CO2 is disclosed on its own line rather than
          // folded into the CO2 row.
          continue;
        }
        gasTotals.set(component.gas, (gasTotals.get(component.gas) ?? 0) + componentTonnes);
        // Native mass: quantity x nativeFactor is the native-unit
        // contribution BEFORE any GWP multiplication (nativeFactor is
        // "kg of this gas per unit of activity data"), same multiplier
        // and biogenic-CO2 exclusion as the CO2e accumulation above so
        // the two stay reconcilable.
        const componentNativeTonnes = (quantity * (component.nativeFactor ?? 0) * multiplier) / 1000;
        gasNativeMassTotals.set(component.gas, (gasNativeMassTotals.get(component.gas) ?? 0) + componentNativeTonnes);
      }
      biogenicCo2Tonnes += recordBiogenicCo2Tonnes;

      const scopeKey = record.scope as "scope1" | "scope2" | "scope3";
      if (scopeKey === "scope1" || scopeKey === "scope2" || scopeKey === "scope3") {
        // Gross scope total = the record's emission LESS its biogenic-CO2
        // component only. Biogenic CH4/N2O were never subtracted above, so
        // they remain in here, which is the intended treatment.
        const grossTonnes = emissionTonnes - recordBiogenicCo2Tonnes;
        scopeTotals[scopeKey] += grossTonnes;
        const existing = perFacilityScopeTotals.get(record.facilityId) ?? { scope1: 0, scope2: 0, scope3: 0 };
        existing[scopeKey] += grossTonnes;
        perFacilityScopeTotals.set(record.facilityId, existing);
      }
    }

    const gasTotal = Array.from(gasTotals.values()).reduce((sum, v) => sum + v, 0);
    const gasBreakdown = Array.from(gasTotals.entries()).map(([gas, co2e]) => ({
      gas,
      co2e,
      nativeMass: gasNativeMassTotals.get(gas) ?? 0,
      pctOfTotal: gasTotal > 0 ? (co2e / gasTotal) * 100 : 0,
    }));

    const facilitySourceStreams = await db
      .select({ facilityId: sourceStreams.facilityId })
      .from(sourceStreams)
      .where(
        and(
          eq(sourceStreams.organizationId, organizationId),
          eq(sourceStreams.reportingBoundaryId, reportingBoundaryId),
        ),
      );
    const facilitiesWithStreams = new Set(facilitySourceStreams.map((s) => s.facilityId));

    const facilitiesOut = entityFacilities.map((f) => {
      const totals = perFacilityScopeTotals.get(f.id) ?? { scope1: 0, scope2: 0, scope3: 0 };
      return {
        id: f.id,
        name: f.name,
        country: f.country,
        equityShareOwnershipPercent: f.equityShareOwnershipPercent ? Number(f.equityShareOwnershipPercent) : null,
        incomplete: !facilitiesWithStreams.has(f.id),
        // Same null test facilityMultiplier() uses above, so this flag is
        // true exactly when the multiplier silently collapsed to 0.
        missingEquityShare:
          isEquityShare && (f.equityShareOwnershipPercent === null || f.equityShareOwnershipPercent === undefined),
        ...totals,
      };
    });

    const totalTco2e = scopeTotals.scope1 + scopeTotals.scope2 + scopeTotals.scope3;

    const facilityProductRows =
      entityFacilities.length > 0
        ? await db
            .select()
            .from(facilityProducts)
            .where(
              and(
                eq(facilityProducts.organizationId, organizationId),
                inArray(
                  facilityProducts.facilityId,
                  entityFacilities.map((f) => f.id),
                ),
              ),
            )
        : [];
    const totalProduction = facilityProductRows.reduce(
      (sum, p) => sum + (p.actualProduction ? Number(p.actualProduction) : 0),
      0,
    );

    // GRI 305-4 and IFRS S2 both define GHG intensity as emissions per unit
    // of the organization-specific denominator (tCO2e / revenue, tCO2e /
    // FTE, tCO2e / production unit). The denominator is what has to be
    // non-zero here; a zero-emissions inventory still yields a valid 0
    // intensity, so totalTco2e is deliberately NOT part of the guard.
    const revenueAmount = boundary.revenueAmount ? Number(boundary.revenueAmount) : 0;
    const fteEmployees = boundary.fullTimeEquivalentEmployees ? Number(boundary.fullTimeEquivalentEmployees) : 0;
    const intensity = {
      tco2ePerRevenue: revenueAmount > 0 ? totalTco2e / revenueAmount : null,
      tco2ePerFte: fteEmployees > 0 ? totalTco2e / fteEmployees : null,
      tco2ePerProductionUnit: totalProduction > 0 ? totalTco2e / totalProduction : null,
      revenueCurrency: boundary.revenueCurrency ?? null,
    };

    // Explicit gas-coverage disclosure (Section 2b) -- states which of the
    // 7 Kyoto gases are backed by real data in THIS period's records versus
    // not yet covered by this system at all, rather than silently omitting
    // gases with no data.
    const allKyotoGases = ["CO2", "CH4", "N2O", "HFCs", "PFCs", "SF6", "NF3"];
    const gasCoverage = allKyotoGases.map((gas) => ({ gas, covered: gasTotals.has(gas) }));

    let baseYearComparison: ConsolidatedReport["baseYearComparison"] = null;
    if (entity.baseYear && entity.baseYear !== boundary.reportingYear) {
      const baseYearBoundaries = await db
        .select()
        .from(reportingBoundaries)
        .where(
          and(
            eq(reportingBoundaries.organizationId, organizationId),
            eq(reportingBoundaries.reportingEntityId, entity.id),
            eq(reportingBoundaries.reportingYear, entity.baseYear),
          ),
        );
      if (baseYearBoundaries[0]) {
        const baseYearReport = await this.getConsolidatedReport(organizationId, baseYearBoundaries[0].id);
        const baseYearTotal = baseYearReport
          ? baseYearReport.totals.scope1 + baseYearReport.totals.scope2 + baseYearReport.totals.scope3
          : null;
        baseYearComparison = {
          baseYearTotal,
          currentYearTotal: totalTco2e,
          changePercent:
            baseYearTotal && baseYearTotal > 0 ? ((totalTco2e - baseYearTotal) / baseYearTotal) * 100 : null,
        };
      }
    }

    // Name is selected alongside the id so the report's data-quality /
    // uncertainty table can label each row with the source stream it
    // belongs to -- a bare sourceStreamId is not something a verifier can
    // read (ISO 14064-3 6.1.3.6.3 expects uncertainty to be attributable).
    const streamIdsForBoundary = await db
      .select({ id: sourceStreams.id, name: sourceStreams.name })
      .from(sourceStreams)
      .where(
        and(
          eq(sourceStreams.organizationId, organizationId),
          eq(sourceStreams.reportingBoundaryId, reportingBoundaryId),
        ),
      );
    const streamIds = streamIdsForBoundary.map((s) => s.id);
    const streamNamesById = new Map(streamIdsForBoundary.map((s) => [s.id, s.name]));

    const [dqRecords, findings, qaRecords] = await Promise.all([
      streamIds.length > 0
        ? db
            .select()
            .from(dataQualityRecords)
            .where(
              and(
                eq(dataQualityRecords.organizationId, organizationId),
                inArray(dataQualityRecords.sourceStreamId, streamIds),
              ),
            )
        : Promise.resolve([]),
      db
        .select()
        .from(verificationFindings)
        .where(
          and(
            eq(verificationFindings.organizationId, organizationId),
            eq(verificationFindings.reportingBoundaryId, reportingBoundaryId),
          ),
        ),
      db
        .select()
        .from(managementQaRecords)
        .where(
          and(
            eq(managementQaRecords.organizationId, organizationId),
            eq(managementQaRecords.reportingBoundaryId, reportingBoundaryId),
          ),
        ),
    ]);

    return {
      reportingBoundary: {
        id: boundary.id,
        reportingYear: boundary.reportingYear,
        consolidationApproach: boundary.consolidationApproach,
        status: boundary.status,
        finalizedAt: boundary.finalizedAt ? boundary.finalizedAt.toISOString() : null,
      },
      reportingEntity: {
        id: entity.id,
        name: entity.name,
        baseYear: entity.baseYear,
        baseYearRationale: entity.baseYearRationale,
      },
      // biogenicCo2 is a real aggregation now that biogenic-flagged factors
      // are seeded (manual-migration-008.mjs) and every persisted
      // gasBreakdown component carries isBiogenic (shared/schema.ts
      // GasComponent). It is a memo item: already netted OUT of
      // scope1/2/3 above, so adding it to the three scopes would double
      // count. Biogenic CH4/N2O are NOT in this figure -- they stay in the
      // gross scope totals, per GRI 305-1 / GHG Protocol.
      totals: { ...scopeTotals, biogenicCo2: biogenicCo2Tonnes },
      gasBreakdown,
      facilities: facilitiesOut,
      intensity,
      gasCoverage,
      dataQualityRecords: dqRecords.map((r) => ({
        id: r.id,
        sourceStreamId: r.sourceStreamId,
        sourceStreamName: streamNamesById.get(r.sourceStreamId) ?? null,
        dataQualityTier: r.dataQualityTier,
        uncertaintyPercent: r.uncertaintyPercent,
        uncertaintyJustification: r.uncertaintyJustification,
        usedIpccDefaultFactor: r.usedIpccDefaultFactor,
        ipccDefaultSubstitutionReason: r.ipccDefaultSubstitutionReason,
      })),
      verificationFindings: findings,
      managementQaRecords: qaRecords,
      baseYearComparison,
    };
  }

  async getSourceStreamDetailForBoundary(
    organizationId: number,
    reportingBoundaryId: number,
  ): Promise<SourceStreamDetail[]> {
    const streams = await db
      .select()
      .from(sourceStreams)
      .where(
        and(
          eq(sourceStreams.organizationId, organizationId),
          eq(sourceStreams.reportingBoundaryId, reportingBoundaryId),
        ),
      );
    if (streams.length === 0) return [];

    const streamIds = streams.map((s) => s.id);
    const facilityIds = Array.from(new Set(streams.map((s) => s.facilityId)));

    const [facilityRows, calcRows, measureRows, fallbackRows] = await Promise.all([
      db
        .select()
        .from(facilities)
        .where(and(eq(facilities.organizationId, organizationId), inArray(facilities.id, facilityIds))),
      db
        .select()
        .from(calculationApproaches)
        .where(
          and(
            eq(calculationApproaches.organizationId, organizationId),
            inArray(calculationApproaches.sourceStreamId, streamIds),
          ),
        ),
      db
        .select()
        .from(measurementBasedApproaches)
        .where(
          and(
            eq(measurementBasedApproaches.organizationId, organizationId),
            inArray(measurementBasedApproaches.sourceStreamId, streamIds),
          ),
        ),
      db
        .select()
        .from(fallbackApproaches)
        .where(
          and(
            eq(fallbackApproaches.organizationId, organizationId),
            inArray(fallbackApproaches.sourceStreamId, streamIds),
          ),
        ),
    ]);

    const facilityNameById = new Map(facilityRows.map((f) => [f.id, f.name]));
    const calcByStream = new Map(calcRows.map((r) => [r.sourceStreamId, r]));
    const measureByStream = new Map(measureRows.map((r) => [r.sourceStreamId, r]));
    const fallbackByStream = new Map(fallbackRows.map((r) => [r.sourceStreamId, r]));

    return streams.map((s) => {
      const calc = calcByStream.get(s.id);
      const measure = measureByStream.get(s.id);
      const fallback = fallbackByStream.get(s.id);
      const approachTier: SourceStreamDetail["approachTier"] = calc
        ? "calculation"
        : measure
          ? "measurement"
          : fallback
            ? "fallback"
            : "none";

      return {
        sourceStreamId: s.id,
        facilityId: s.facilityId,
        facilityName: facilityNameById.get(s.facilityId) ?? "",
        streamCode: s.streamCode,
        name: s.name,
        description: s.description,
        ghgSourceCategory: s.ghgSourceCategory,
        scope: s.scope,
        materiality: s.materiality,
        estimatedAnnualEmissionsTco2e: s.estimatedAnnualEmissionsTco2e ? Number(s.estimatedAnnualEmissionsTco2e) : null,
        approachTier,
        calculationApproach: calc
          ? {
              fuelOrMaterialType: calc.fuelOrMaterialType,
              activityDataValue: calc.activityDataValue ? Number(calc.activityDataValue) : null,
              activityDataUnit: calc.activityDataUnit,
              activityDataSource: calc.activityDataSource,
              activityDataTier: calc.activityDataTier,
              emissionFactorValue: calc.emissionFactorValue ? Number(calc.emissionFactorValue) : null,
              emissionFactorUnit: calc.emissionFactorUnit,
              emissionFactorSource: calc.emissionFactorSource,
              emissionFactorSourceUrl: calc.emissionFactorSourceUrl,
              emissionFactorAuthorityName: calc.emissionFactorAuthorityName,
              isIpccDefault: calc.isIpccDefault,
              gasBreakdown: calc.gasBreakdown,
              netCalorificValue: calc.netCalorificValue ? Number(calc.netCalorificValue) : null,
              calculatedEmissionsTco2e: calc.calculatedEmissionsTco2e ? Number(calc.calculatedEmissionsTco2e) : null,
            }
          : null,
        measurementApproach: measure
          ? {
              measurementMethod: measure.measurementMethod,
              monitoringFrequency: measure.monitoringFrequency,
              measurementUnit: measure.measurementUnit,
              annualMeasuredQuantity: measure.annualMeasuredQuantity ? Number(measure.annualMeasuredQuantity) : null,
              qaqcProcedure: measure.qaqcProcedure,
              calibrationFrequency: measure.calibrationFrequency,
            }
          : null,
        fallbackApproach: fallback
          ? {
              justification: fallback.justification,
              fallbackMethodDescription: fallback.fallbackMethodDescription,
              estimatedEmissionsTco2e: fallback.estimatedEmissionsTco2e
                ? Number(fallback.estimatedEmissionsTco2e)
                : null,
            }
          : null,
      };
    });
  }

  async listAllUsersForAdmin(params: {
    search?: string;
    organizationId?: number;
    limit: number;
    offset: number;
  }): Promise<{ users: AdminUserListItem[]; total: number }> {
    const { search, organizationId, limit, offset } = params;
    const searchCondition = search
      ? or(ilike(users.email, `%${search}%`), ilike(users.name, `%${search}%`))
      : undefined;
    // Organization filter is a membership EXISTS check, not a join -- a join
    // would duplicate a user row per membership, same reasoning as every
    // other admin-list query in this file.
    const orgCondition =
      organizationId !== undefined
        ? exists(
            db
              .select()
              .from(memberships)
              .where(and(eq(memberships.userId, users.id), eq(memberships.organizationId, organizationId))),
          )
        : undefined;
    const whereFilter =
      searchCondition && orgCondition ? and(searchCondition, orgCondition) : (searchCondition ?? orgCondition);

    const totalRes = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(whereFilter);
    const total = totalRes[0]?.count ?? 0;

    const pageUsers = await db
      .select()
      .from(users)
      .where(whereFilter)
      .orderBy(desc(users.createdAt))
      .limit(limit)
      .offset(offset);

    const userIds = pageUsers.map((u) => u.id);
    const pageMemberships =
      userIds.length > 0
        ? await db
            .select({
              membershipId: memberships.id,
              userId: memberships.userId,
              organizationId: memberships.organizationId,
              role: memberships.role,
              isActive: memberships.isActive,
              organizationName: organizations.name,
            })
            .from(memberships)
            .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
            .where(inArray(memberships.userId, userIds))
        : [];

    const orgsByUserId = new Map<
      number,
      { membershipId: number; organizationId: number; organizationName: string; role: string; isActive: boolean }[]
    >();
    for (const m of pageMemberships) {
      const list = orgsByUserId.get(m.userId) ?? [];
      list.push({
        membershipId: m.membershipId,
        organizationId: m.organizationId,
        organizationName: m.organizationName,
        role: m.role,
        isActive: m.isActive,
      });
      orgsByUserId.set(m.userId, list);
    }

    return {
      users: pageUsers.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        emailVerified: u.emailVerified,
        hasBeenVerified: u.hasBeenVerified,
        isSuperAdmin: u.isSuperAdmin,
        isActive: u.isActive,
        createdAt: u.createdAt,
        organizations: orgsByUserId.get(u.id) ?? [],
      })),
      total,
    };
  }

  async listAllOrganizationsForAdmin(): Promise<AdminOrganizationListItem[]> {
    const orgs = await db.select().from(organizations).orderBy(desc(organizations.createdAt));
    const orgIds = orgs.map((o) => o.id);

    const allMemberships =
      orgIds.length > 0
        ? await db
            .select({
              organizationId: memberships.organizationId,
              role: memberships.role,
              email: users.email,
            })
            .from(memberships)
            .innerJoin(users, eq(users.id, memberships.userId))
            .where(inArray(memberships.organizationId, orgIds))
        : [];

    const countByOrg = new Map<number, number>();
    const ownerEmailsByOrg = new Map<number, string[]>();
    for (const m of allMemberships) {
      countByOrg.set(m.organizationId, (countByOrg.get(m.organizationId) ?? 0) + 1);
      if (m.role === "owner") {
        const list = ownerEmailsByOrg.get(m.organizationId) ?? [];
        list.push(m.email);
        ownerEmailsByOrg.set(m.organizationId, list);
      }
    }

    return orgs.map((o) => ({
      id: o.id,
      name: o.name,
      slug: o.slug,
      createdAt: o.createdAt,
      memberCount: countByOrg.get(o.id) ?? 0,
      ownerEmails: ownerEmailsByOrg.get(o.id) ?? [],
    }));
  }

  async deleteUnverifiedUserById(
    userId: number,
    actorUserId: number,
  ): Promise<"deleted" | "not_found" | "already_verified"> {
    const [target] = await db.select().from(users).where(eq(users.id, userId));
    if (!target) return "not_found";
    // hasBeenVerified, not emailVerified. An account that has EVER been
    // verified is off-limits to this path regardless of its CURRENT
    // emailVerified value: storage.setNewEmailPendingVerification sets
    // emailVerified = false on a live, data-bearing tenant account so the new
    // address can be re-verified, and gating on emailVerified made that
    // account look identical to a disposable fresh registration -- two clicks
    // from a cascade delete of its whole organization.
    if (target.hasBeenVerified) return "already_verified";

    // Only ever delete an organization this user OWNS (registration always
    // creates role: "owner" for the org it creates; a membership added via
    // POST /api/team/invite is "member"/"admin" in a DIFFERENT, live
    // organization -- that must never be touched, even if it's the only
    // membership row this query happens to see first). Additionally require
    // that no other user holds a membership in the owned org, as
    // defense-in-depth: an unverified owner cannot invite anyone else
    // (inviting requires an authenticated session, and login is blocked
    // until the account is verified), so this should always hold -- but the
    // delete must never rely on that invariant alone.
    const ownedMemberships = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.role, "owner")));

    let orgIdToDelete: number | undefined;
    if (ownedMemberships.length > 0) {
      const candidateOrgId = ownedMemberships[0].organizationId;
      const otherMembers = await db
        .select()
        .from(memberships)
        .where(and(eq(memberships.organizationId, candidateOrgId), ne(memberships.userId, userId)));
      if (otherMembers.length === 0) {
        orgIdToDelete = candidateOrgId;
      }
      // If otherMembers.length > 0, this "owned" org unexpectedly has other
      // members -- do not delete it. The target user's own row (and every
      // membership row of theirs, in any org) still gets removed below via
      // the users delete, which cascades on memberships.userId.
    }

    // Same db.batch() requirement as deleteExpiredUnverifiedRegistrations
    // above -- db.transaction() throws on this project's neon-http driver.
    // The audit-log insert rides in the same batch as the deletes so "the
    // row is gone" and "there's a record of who removed it" are one atomic
    // fact, never one without the other.
    const logEntry = db.insert(adminActionLog).values({
      actorUserId,
      action: "delete" as const,
      targetUserId: target.id,
      targetEmail: target.email,
    });

    // Both deletes re-assert has_been_verified = false in their own WHERE
    // clause rather than relying on the read above. Without that, a verify
    // (self-service or admin) landing between the SELECT and this batch would
    // be raced straight past and a now-verified account deleted anyway. The
    // org delete carries the same condition as an EXISTS subquery on the
    // target user, so the two statements can never disagree: if the user
    // delete no-ops because the flag flipped, the org delete no-ops with it
    // rather than orphaning a freshly-verified owner from their organization.
    const stillNeverVerified = () =>
      exists(
        db
          .select()
          .from(users)
          .where(and(eq(users.id, userId), eq(users.hasBeenVerified, false))),
      );

    if (orgIdToDelete) {
      await db.batch([
        logEntry,
        db.delete(organizations).where(and(eq(organizations.id, orgIdToDelete), stillNeverVerified())),
        db.delete(users).where(and(eq(users.id, userId), eq(users.hasBeenVerified, false))),
      ]);
    } else {
      await db.batch([logEntry, db.delete(users).where(and(eq(users.id, userId), eq(users.hasBeenVerified, false)))]);
    }

    return "deleted";
  }

  async promoteToSuperAdmin(userId: number): Promise<void> {
    await db.update(users).set({ isSuperAdmin: true }).where(eq(users.id, userId));
  }

  async demoteFromSuperAdmin(userId: number): Promise<void> {
    await db.update(users).set({ isSuperAdmin: false }).where(eq(users.id, userId));
  }

  async getMembershipById(membershipId: number, scopedToOrgId?: number): Promise<Membership | undefined> {
    const where = scopedToOrgId
      ? and(eq(memberships.id, membershipId), eq(memberships.organizationId, scopedToOrgId))
      : eq(memberships.id, membershipId);
    const [row] = await db.select().from(memberships).where(where);
    return row;
  }

  async deactivateMembership(membershipId: number, scopedToOrgId?: number): Promise<Membership | undefined> {
    const where = scopedToOrgId
      ? and(eq(memberships.id, membershipId), eq(memberships.organizationId, scopedToOrgId))
      : eq(memberships.id, membershipId);
    const [row] = await db.update(memberships).set({ isActive: false }).where(where).returning();
    return row;
  }

  async activateMembership(membershipId: number, scopedToOrgId?: number): Promise<Membership | undefined> {
    const where = scopedToOrgId
      ? and(eq(memberships.id, membershipId), eq(memberships.organizationId, scopedToOrgId))
      : eq(memberships.id, membershipId);
    const [row] = await db.update(memberships).set({ isActive: true }).where(where).returning();
    return row;
  }

  async deactivateAccount(userId: number): Promise<void> {
    await db.update(users).set({ isActive: false }).where(eq(users.id, userId));
  }

  async reactivateAccount(userId: number): Promise<void> {
    await db.update(users).set({ isActive: true }).where(eq(users.id, userId));
  }

  // Changing email never lets an admin set the account's password. The new
  // occupant proves control of the new inbox and sets their own password
  // via the SAME token-based flow POST /api/auth/reset-password serves for
  // a plain forgot-password reset -- resetTokenExpiresAt/resetToken here are
  // the password-reset token, not a fresh email-verification token; any
  // stale email-verification token is cleared since it no longer applies to
  // the new address.
  //
  // hasBeenVerified is deliberately NOT in the set below and must never be
  // added to it. emailVerified going false here is what put live tenant
  // accounts in reach of both hard-delete paths; hasBeenVerified surviving
  // untouched is precisely what now keeps them out of it. An account that has
  // ever been verified stays permanently ineligible for deletion, however
  // many times its email is changed.
  async setNewEmailPendingVerification(
    userId: number,
    newEmail: string,
    resetToken: string,
    resetTokenExpiresAt: Date,
  ): Promise<void> {
    await db
      .update(users)
      .set({
        email: newEmail,
        emailVerified: false,
        emailVerificationToken: null,
        emailVerificationTokenExpiresAt: null,
        passwordResetToken: resetToken,
        passwordResetTokenExpiresAt: resetTokenExpiresAt,
      })
      .where(eq(users.id, userId));
  }

  async logAdminAction(entry: {
    actorUserId: number;
    action:
      | "verify"
      | "delete"
      | "promote"
      | "demote"
      | "deactivate_membership"
      | "activate_membership"
      | "deactivate_user"
      | "activate_user"
      | "change_email"
      | "reset_password";
    targetUserId: number;
    targetEmail: string;
    organizationId?: number;
    organizationName?: string;
    note?: string;
  }): Promise<AdminActionLog> {
    const [row] = await db.insert(adminActionLog).values(entry).returning();
    return row;
  }

  async listAdminActionLog(): Promise<AdminActionLogEntry[]> {
    return db
      .select({
        id: adminActionLog.id,
        actorEmail: users.email,
        action: adminActionLog.action,
        targetEmail: adminActionLog.targetEmail,
        organizationName: adminActionLog.organizationName,
        note: adminActionLog.note,
        createdAt: adminActionLog.createdAt,
      })
      .from(adminActionLog)
      .innerJoin(users, eq(users.id, adminActionLog.actorUserId))
      .orderBy(desc(adminActionLog.createdAt))
      .limit(200) as Promise<AdminActionLogEntry[]>;
  }

  async listAdminActionLogForOrganization(organizationId: number): Promise<AdminActionLogEntry[]> {
    return db
      .select({
        id: adminActionLog.id,
        actorEmail: users.email,
        action: adminActionLog.action,
        targetEmail: adminActionLog.targetEmail,
        organizationName: adminActionLog.organizationName,
        note: adminActionLog.note,
        createdAt: adminActionLog.createdAt,
      })
      .from(adminActionLog)
      .innerJoin(users, eq(users.id, adminActionLog.actorUserId))
      .where(eq(adminActionLog.organizationId, organizationId))
      .orderBy(desc(adminActionLog.createdAt))
      .limit(200) as Promise<AdminActionLogEntry[]>;
  }
}

export const storage = new DbStorage();
