import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  users,
  type User,
  type InsertUser,
  type Organization,
  type Facility,
  type ReportingBoundary,
  type ConsolidationApproach,
} from "@shared/schema";

interface SetupStoreSnapshot {
  organizations: Organization[];
  facilities: Facility[];
  boundaries: ReportingBoundary[];
  counters: {
    organization: number;
    facility: number;
    boundary: number;
  };
}

const EMPTY_SNAPSHOT: SetupStoreSnapshot = {
  organizations: [],
  facilities: [],
  boundaries: [],
  counters: {
    organization: 1,
    facility: 1,
    boundary: 1,
  },
};

export interface IStorage {
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  listOrganizations(): Promise<Organization[]>;
  createOrganization(payload: { name: string; legalEntity?: string }): Promise<Organization>;
  updateOrganization(id: number, payload: { name: string; legalEntity?: string }): Promise<Organization | undefined>;

  listFacilities(): Promise<Facility[]>;
  createFacility(payload: { organizationId: number; name: string; country?: string }): Promise<Facility>;
  updateFacility(id: number, payload: { name: string; country?: string }): Promise<Facility | undefined>;
  deleteFacility(id: number): Promise<boolean>;

  listReportingBoundaries(): Promise<ReportingBoundary[]>;
  createReportingBoundary(payload: {
    organizationId: number;
    reportingYear: number;
    consolidationApproach: ConsolidationApproach;
    description?: string;
  }): Promise<ReportingBoundary>;
  updateReportingBoundary(
    id: number,
    payload: { reportingYear: number; consolidationApproach: ConsolidationApproach; description?: string },
  ): Promise<ReportingBoundary | undefined>;
  deleteReportingBoundary(id: number): Promise<boolean>;

  deleteOrganization(id: number): Promise<boolean>;
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
  private readonly setupStorePath: string;
  private readonly setupStoreReady: Promise<void>;

  constructor() {
    this.users = new Map();
    this.organizations = [];
    this.facilities = [];
    this.boundaries = [];
    this.currentUserId = 1;
    this.currentOrganizationId = 1;
    this.currentFacilityId = 1;
    this.currentBoundaryId = 1;
    this.setupStorePath = path.join(process.cwd(), "data", "setup-store.json");
    this.setupStoreReady = this.loadSetupStore();
  }

  private async loadSetupStore(): Promise<void> {
    try {
      const raw = await readFile(this.setupStorePath, "utf-8");
      const parsed = JSON.parse(raw) as SetupStoreSnapshot;
      this.organizations = parsed.organizations || [];
      this.facilities = parsed.facilities || [];
      this.boundaries = parsed.boundaries || [];
      this.currentOrganizationId = parsed.counters?.organization || 1;
      this.currentFacilityId = parsed.counters?.facility || 1;
      this.currentBoundaryId = parsed.counters?.boundary || 1;
    } catch {
      await this.persistSetupStore();
    }
  }

  private async persistSetupStore(): Promise<void> {
    const snapshot: SetupStoreSnapshot = {
      organizations: this.organizations,
      facilities: this.facilities,
      boundaries: this.boundaries,
      counters: {
        organization: this.currentOrganizationId,
        facility: this.currentFacilityId,
        boundary: this.currentBoundaryId,
      },
    };

    const payload = JSON.stringify(snapshot || EMPTY_SNAPSHOT, null, 2);
    await mkdir(path.dirname(this.setupStorePath), { recursive: true });
    await writeFile(this.setupStorePath, payload, "utf-8");
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
    await this.setupStoreReady;
    return [...this.organizations];
  }

  async createOrganization(payload: { name: string; legalEntity?: string }): Promise<Organization> {
    await this.setupStoreReady;
    const organization: Organization = {
      id: this.currentOrganizationId++,
      name: payload.name,
      legalEntity: payload.legalEntity,
      createdAt: new Date().toISOString(),
    };
    this.organizations.push(organization);
    await this.persistSetupStore();
    return organization;
  }

  async updateOrganization(id: number, payload: { name: string; legalEntity?: string }): Promise<Organization | undefined> {
    await this.setupStoreReady;
    const organization = this.organizations.find((item) => item.id === id);
    if (!organization) return undefined;

    organization.name = payload.name;
    organization.legalEntity = payload.legalEntity;
    await this.persistSetupStore();
    return organization;
  }

  async listFacilities(): Promise<Facility[]> {
    await this.setupStoreReady;
    return [...this.facilities];
  }

  async createFacility(payload: { organizationId: number; name: string; country?: string }): Promise<Facility> {
    await this.setupStoreReady;
    const facility: Facility = {
      id: this.currentFacilityId++,
      organizationId: payload.organizationId,
      name: payload.name,
      country: payload.country,
      createdAt: new Date().toISOString(),
    };
    this.facilities.push(facility);
    await this.persistSetupStore();
    return facility;
  }

  async updateFacility(id: number, payload: { name: string; country?: string }): Promise<Facility | undefined> {
    await this.setupStoreReady;
    const facility = this.facilities.find((item) => item.id === id);
    if (!facility) return undefined;

    facility.name = payload.name;
    facility.country = payload.country;
    await this.persistSetupStore();
    return facility;
  }

  async deleteFacility(id: number): Promise<boolean> {
    await this.setupStoreReady;
    const before = this.facilities.length;
    this.facilities = this.facilities.filter((facility) => facility.id !== id);
    const changed = this.facilities.length < before;
    if (changed) await this.persistSetupStore();
    return changed;
  }

  async listReportingBoundaries(): Promise<ReportingBoundary[]> {
    await this.setupStoreReady;
    return [...this.boundaries];
  }

  async createReportingBoundary(payload: {
    organizationId: number;
    reportingYear: number;
    consolidationApproach: ConsolidationApproach;
    description?: string;
  }): Promise<ReportingBoundary> {
    await this.setupStoreReady;
    const boundary: ReportingBoundary = {
      id: this.currentBoundaryId++,
      organizationId: payload.organizationId,
      reportingYear: payload.reportingYear,
      consolidationApproach: payload.consolidationApproach,
      description: payload.description,
      createdAt: new Date().toISOString(),
    };
    this.boundaries.push(boundary);
    await this.persistSetupStore();
    return boundary;
  }

  async updateReportingBoundary(
    id: number,
    payload: { reportingYear: number; consolidationApproach: ConsolidationApproach; description?: string },
  ): Promise<ReportingBoundary | undefined> {
    await this.setupStoreReady;
    const boundary = this.boundaries.find((item) => item.id === id);
    if (!boundary) return undefined;

    boundary.reportingYear = payload.reportingYear;
    boundary.consolidationApproach = payload.consolidationApproach;
    boundary.description = payload.description;
    await this.persistSetupStore();
    return boundary;
  }

  async deleteReportingBoundary(id: number): Promise<boolean> {
    await this.setupStoreReady;
    const before = this.boundaries.length;
    this.boundaries = this.boundaries.filter((boundary) => boundary.id !== id);
    const changed = this.boundaries.length < before;
    if (changed) await this.persistSetupStore();
    return changed;
  }

  async deleteOrganization(id: number): Promise<boolean> {
    await this.setupStoreReady;
    const before = this.organizations.length;
    this.organizations = this.organizations.filter((organization) => organization.id !== id);
    this.facilities = this.facilities.filter((facility) => facility.organizationId !== id);
    this.boundaries = this.boundaries.filter((boundary) => boundary.organizationId !== id);
    const changed = this.organizations.length < before;
    if (changed) await this.persistSetupStore();
    return changed;
  }
}

export const storage = new MemStorage();
