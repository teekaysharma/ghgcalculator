import { pgTable, text, serial, integer, boolean, numeric, timestamp, unique, index } from "drizzle-orm/pg-core";
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
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("emission_records_org_idx").on(table.organizationId),
    orgYearIdx: index("emission_records_org_year_idx").on(table.organizationId, table.year),
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
});

export type InsertEmissionRecordRow = z.infer<typeof insertEmissionRecordSchema>;
export type EmissionRecordRow = typeof emissionRecordsTable.$inferSelect;

export interface EmissionFactor {
  name: string;
  factor: number;
  unit: string;
  wasteType?: string;
  disposalMethod?: string;
  category?: string;
}

export interface EmissionInput {
  activity: string;
  unit: string;
  qty: number;
  year?: number;
  product?: string;
  wasteType?: string;
  disposalMethod?: string;
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
