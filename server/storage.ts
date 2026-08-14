import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "./db";
import {
  organizations,
  users,
  memberships,
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
  type Organization,
  type InsertOrganization,
  type User,
  type InsertUser,
  type Membership,
  type InsertMembership,
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

  // Memberships (the tenant-scoping join)
  createMembership(membership: InsertMembership): Promise<Membership>;
  getMembershipsForUser(userId: number): Promise<Membership[]>;
  getMembership(userId: number, organizationId: number): Promise<Membership | undefined>;
  listMembershipsForOrganization(organizationId: number): Promise<(Membership & { userEmail: string; userName: string | null })[]>;

  // Emission factors (tenant-scoped)
  createEmissionFactors(organizationId: number, factors: Omit<InsertEmissionFactorRow, "organizationId">[]): Promise<EmissionFactorRow[]>;
  listEmissionFactors(organizationId: number): Promise<EmissionFactorRow[]>;
  deleteEmissionFactor(organizationId: number, factorId: number): Promise<boolean>;

  // Emission records (tenant-scoped, persisted calculation results)
  createEmissionRecords(organizationId: number, records: Omit<InsertEmissionRecordRow, "organizationId">[]): Promise<EmissionRecordRow[]>;
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
    gasBreakdown: unknown;
  }): Promise<EmissionRecordRow>;

  // ISO 14064-1 boundary setup (tenant-scoped). See PROJECT INSTRUCTIONS ->
  // reconciliation with codex/review-code-for-gaps-and-improvements.
  createReportingEntity(entity: InsertReportingEntity): Promise<ReportingEntity>;
  listReportingEntities(organizationId: number): Promise<ReportingEntity[]>;
  getReportingEntity(organizationId: number, id: number): Promise<ReportingEntity | undefined>;
  updateReportingEntity(organizationId: number, id: number, data: Partial<Pick<InsertReportingEntity, "name" | "legalEntity">>): Promise<ReportingEntity | undefined>;
  deleteReportingEntity(organizationId: number, id: number): Promise<boolean>;

  createFacility(facility: InsertFacility): Promise<Facility>;
  listFacilities(organizationId: number): Promise<Facility[]>;
  getFacility(organizationId: number, id: number): Promise<Facility | undefined>;
  updateFacility(organizationId: number, id: number, data: Partial<Pick<InsertFacility, "name" | "country">>): Promise<Facility | undefined>;
  deleteFacility(organizationId: number, id: number): Promise<boolean>;

  createReportingBoundary(boundary: InsertReportingBoundary): Promise<ReportingBoundary>;
  listReportingBoundaries(organizationId: number): Promise<ReportingBoundary[]>;
  getReportingBoundary(organizationId: number, id: number): Promise<ReportingBoundary | undefined>;
  updateReportingBoundary(organizationId: number, id: number, data: Partial<Pick<InsertReportingBoundary, "reportingYear" | "consolidationApproach" | "description" | "status" | "finalizedAt" | "revenueAmount" | "revenueCurrency" | "fullTimeEquivalentEmployees">>): Promise<ReportingBoundary | undefined>;
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
  updateFacilityContact(organizationId: number, id: number, data: Partial<Omit<InsertFacilityContact, "organizationId" | "facilityId">>): Promise<FacilityContact | undefined>;
  deleteFacilityContact(organizationId: number, id: number): Promise<boolean>;

  // Facility products (many per facility)
  createFacilityProduct(product: InsertFacilityProduct): Promise<FacilityProduct>;
  listFacilityProducts(organizationId: number, facilityId: number): Promise<FacilityProduct[]>;
  updateFacilityProduct(organizationId: number, id: number, data: Partial<Omit<InsertFacilityProduct, "organizationId" | "facilityId">>): Promise<FacilityProduct | undefined>;
  deleteFacilityProduct(organizationId: number, id: number): Promise<boolean>;

  // Source streams (many per facility+reportingBoundary) -- the core new entity
  createSourceStream(stream: InsertSourceStream): Promise<SourceStream>;
  listSourceStreams(organizationId: number, reportingBoundaryId: number): Promise<SourceStream[]>;
  getSourceStream(organizationId: number, id: number): Promise<SourceStream | undefined>;
  updateSourceStream(organizationId: number, id: number, data: Partial<Omit<InsertSourceStream, "organizationId" | "facilityId" | "reportingBoundaryId">>): Promise<SourceStream | undefined>;
  deleteSourceStream(organizationId: number, id: number): Promise<boolean>;

  // Calculation approaches (1:1 per source stream, unique on sourceStreamId)
  upsertCalculationApproach(data: InsertCalculationApproach): Promise<CalculationApproach>;
  getCalculationApproach(organizationId: number, sourceStreamId: number): Promise<CalculationApproach | undefined>;

  // Measurement-based approaches (1:1 per source stream, unique on sourceStreamId)
  upsertMeasurementBasedApproach(data: InsertMeasurementBasedApproach): Promise<MeasurementBasedApproach>;
  getMeasurementBasedApproach(organizationId: number, sourceStreamId: number): Promise<MeasurementBasedApproach | undefined>;

  // Fallback approaches (1:1 per source stream, unique on sourceStreamId)
  upsertFallbackApproach(data: InsertFallbackApproach): Promise<FallbackApproach>;
  getFallbackApproach(organizationId: number, sourceStreamId: number): Promise<FallbackApproach | undefined>;

  // Methane reports (1 per facility+reportingBoundary, unique on the pair)
  upsertMethaneReport(data: InsertMethaneReport): Promise<MethaneReport>;
  getMethaneReport(organizationId: number, facilityId: number, reportingBoundaryId: number): Promise<MethaneReport | undefined>;

  // Data quality records (1:1 per source stream, unique on sourceStreamId)
  upsertDataQualityRecord(data: InsertDataQualityRecord): Promise<DataQualityRecord>;
  getDataQualityRecord(organizationId: number, sourceStreamId: number): Promise<DataQualityRecord | undefined>;

  // Verification findings (many per reportingBoundary)
  createVerificationFinding(finding: InsertVerificationFinding): Promise<VerificationFinding>;
  listVerificationFindings(organizationId: number, reportingBoundaryId: number): Promise<VerificationFinding[]>;
  updateVerificationFinding(organizationId: number, id: number, data: Partial<Omit<InsertVerificationFinding, "organizationId" | "reportingBoundaryId">>): Promise<VerificationFinding | undefined>;
  deleteVerificationFinding(organizationId: number, id: number): Promise<boolean>;

  // Management QA records (many per reportingBoundary)
  createManagementQaRecord(record: InsertManagementQaRecord): Promise<ManagementQaRecord>;
  listManagementQaRecords(organizationId: number, reportingBoundaryId: number): Promise<ManagementQaRecord[]>;
  updateManagementQaRecord(organizationId: number, id: number, data: Partial<Omit<InsertManagementQaRecord, "organizationId" | "reportingBoundaryId">>): Promise<ManagementQaRecord | undefined>;
  deleteManagementQaRecord(organizationId: number, id: number): Promise<boolean>;

  // Mitigation measures (many per facility)
  createMitigationMeasure(measure: InsertMitigationMeasure): Promise<MitigationMeasure>;
  listMitigationMeasures(organizationId: number, facilityId: number): Promise<MitigationMeasure[]>;
  updateMitigationMeasure(organizationId: number, id: number, data: Partial<Omit<InsertMitigationMeasure, "organizationId" | "facilityId">>): Promise<MitigationMeasure | undefined>;
  deleteMitigationMeasure(organizationId: number, id: number): Promise<boolean>;

  // Reference data (global, not tenant-scoped, read-only)
  listPrimaryActivityTypes(): Promise<PrimaryActivityType[]>;
  listProductBenchmarks(): Promise<ProductBenchmark[]>;
  listIsicDivisions(): Promise<IsicDivision[]>;
  listIpccDefaultFactors(): Promise<IpccDefaultFactor[]>;
  listGwpValues(): Promise<GwpValue[]>;
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

  async createMembership(membership: InsertMembership): Promise<Membership> {
    const [row] = await db.insert(memberships).values(membership).returning();
    return row;
  }

  async getMembershipsForUser(userId: number): Promise<Membership[]> {
    return db.select().from(memberships).where(eq(memberships.userId, userId));
  }

  async getMembership(userId: number, organizationId: number): Promise<Membership | undefined> {
    const [row] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.organizationId, organizationId)));
    return row;
  }

  async listMembershipsForOrganization(
    organizationId: number,
  ): Promise<(Membership & { userEmail: string; userName: string | null })[]> {
    const rows = await db
      .select({
        id: memberships.id,
        userId: memberships.userId,
        organizationId: memberships.organizationId,
        role: memberships.role,
        createdAt: memberships.createdAt,
        userEmail: users.email,
        userName: users.name,
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
    gasBreakdown: unknown;
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
      throw new Error("upsertEmissionRecordForCalculationApproach: conflicting row belongs to a different organization");
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
    data: Partial<Pick<InsertReportingEntity, "name" | "legalEntity">>,
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
    data: Partial<Pick<InsertFacility, "name" | "country">>,
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
    data: Partial<Pick<InsertReportingBoundary, "reportingYear" | "consolidationApproach" | "description" | "status" | "finalizedAt" | "revenueAmount" | "revenueCurrency" | "fullTimeEquivalentEmployees">>,
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
      .where(and(eq(facilityIdentifiers.facilityId, facilityId), eq(facilityIdentifiers.organizationId, organizationId)));
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
      .where(and(eq(sourceStreams.reportingBoundaryId, reportingBoundaryId), eq(sourceStreams.organizationId, organizationId)))
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

  async getCalculationApproach(organizationId: number, sourceStreamId: number): Promise<CalculationApproach | undefined> {
    const [row] = await db
      .select()
      .from(calculationApproaches)
      .where(and(eq(calculationApproaches.sourceStreamId, sourceStreamId), eq(calculationApproaches.organizationId, organizationId)));
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
      .where(and(eq(fallbackApproaches.sourceStreamId, sourceStreamId), eq(fallbackApproaches.organizationId, organizationId)));
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
      .where(and(eq(dataQualityRecords.sourceStreamId, sourceStreamId), eq(dataQualityRecords.organizationId, organizationId)));
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
}

export const storage = new DbStorage();
