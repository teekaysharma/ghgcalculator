import {
  users,
  type User,
  type InsertUser,
  type Organization,
  type Facility,
  type ReportingBoundary,
  type ConsolidationApproach,
} from "@shared/schema";

export interface IStorage {
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  listOrganizations(): Promise<Organization[]>;
  createOrganization(payload: { name: string; legalEntity?: string }): Promise<Organization>;

  listFacilities(): Promise<Facility[]>;
  createFacility(payload: { organizationId: number; name: string; country?: string }): Promise<Facility>;

  listReportingBoundaries(): Promise<ReportingBoundary[]>;
  createReportingBoundary(payload: {
    organizationId: number;
    reportingYear: number;
    consolidationApproach: ConsolidationApproach;
    description?: string;
  }): Promise<ReportingBoundary>;
}

export class MemStorage implements IStorage {
  private users: Map<number, User>;
  private organizations: Organization[];
  private facilities: Facility[];
  private boundaries: ReportingBoundary[];
  private currentUserId: number;
  private currentOrganizationId: number;
  private currentFacilityId: number;
  private currentBoundaryId: number;

  constructor() {
    this.users = new Map();
    this.organizations = [];
    this.facilities = [];
    this.boundaries = [];
    this.currentUserId = 1;
    this.currentOrganizationId = 1;
    this.currentFacilityId = 1;
    this.currentBoundaryId = 1;
  }

  async getUser(id: number): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find((user) => user.username === username);
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = this.currentUserId++;
    const user: User = { ...insertUser, id };
    this.users.set(id, user);
    return user;
  }

  async listOrganizations(): Promise<Organization[]> {
    return [...this.organizations];
  }

  async createOrganization(payload: { name: string; legalEntity?: string }): Promise<Organization> {
    const organization: Organization = {
      id: this.currentOrganizationId++,
      name: payload.name,
      legalEntity: payload.legalEntity,
      createdAt: new Date().toISOString(),
    };
    this.organizations.push(organization);
    return organization;
  }

  async listFacilities(): Promise<Facility[]> {
    return [...this.facilities];
  }

  async createFacility(payload: { organizationId: number; name: string; country?: string }): Promise<Facility> {
    const facility: Facility = {
      id: this.currentFacilityId++,
      organizationId: payload.organizationId,
      name: payload.name,
      country: payload.country,
      createdAt: new Date().toISOString(),
    };
    this.facilities.push(facility);
    return facility;
  }

  async listReportingBoundaries(): Promise<ReportingBoundary[]> {
    return [...this.boundaries];
  }

  async createReportingBoundary(payload: {
    organizationId: number;
    reportingYear: number;
    consolidationApproach: ConsolidationApproach;
    description?: string;
  }): Promise<ReportingBoundary> {
    const boundary: ReportingBoundary = {
      id: this.currentBoundaryId++,
      organizationId: payload.organizationId,
      reportingYear: payload.reportingYear,
      consolidationApproach: payload.consolidationApproach,
      description: payload.description,
      createdAt: new Date().toISOString(),
    };
    this.boundaries.push(boundary);
    return boundary;
  }
}

export const storage = new MemStorage();
