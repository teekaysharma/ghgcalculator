import { and, desc, eq } from "drizzle-orm";
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

  // Emission factors (tenant-scoped)
  createEmissionFactors(organizationId: number, factors: Omit<InsertEmissionFactorRow, "organizationId">[]): Promise<EmissionFactorRow[]>;
  listEmissionFactors(organizationId: number): Promise<EmissionFactorRow[]>;
  deleteEmissionFactor(organizationId: number, factorId: number): Promise<boolean>;

  // Emission records (tenant-scoped, persisted calculation results)
  createEmissionRecords(organizationId: number, records: Omit<InsertEmissionRecordRow, "organizationId">[]): Promise<EmissionRecordRow[]>;
  listEmissionRecords(organizationId: number): Promise<EmissionRecordRow[]>;

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
  updateReportingBoundary(organizationId: number, id: number, data: Partial<Pick<InsertReportingBoundary, "reportingYear" | "consolidationApproach" | "description">>): Promise<ReportingBoundary | undefined>;
  deleteReportingBoundary(organizationId: number, id: number): Promise<boolean>;
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

  async createEmissionFactors(
    organizationId: number,
    factors: Omit<InsertEmissionFactorRow, "organizationId">[],
  ): Promise<EmissionFactorRow[]> {
    if (factors.length === 0) return [];
    const rows = factors.map((f) => ({ ...f, organizationId }));
    return db.insert(emissionFactorsTable).values(rows).returning();
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

  async updateReportingBoundary(
    organizationId: number,
    id: number,
    data: Partial<Pick<InsertReportingBoundary, "reportingYear" | "consolidationApproach" | "description">>,
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
}

export const storage = new DbStorage();
