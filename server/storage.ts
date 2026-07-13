import { and, desc, eq } from "drizzle-orm";
import { db } from "./db";
import {
  organizations,
  users,
  memberships,
  emissionFactorsTable,
  emissionRecordsTable,
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
}

export const storage = new DbStorage();
