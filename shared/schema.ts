import { pgTable, text, serial, integer, boolean, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Original users table
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// GHG Emission types
export type ScopeType = 'scope1' | 'scope2' | 'scope3';

export interface EmissionFactor {
  name: string;
  factor: number;
  unit: string;
  source?: string;
  year?: number;
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
  scope3Category?: string;
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


export type ConsolidationApproach = "operational_control" | "financial_control" | "equity_share";

export type DataQualityTier = "best" | "intermediate" | "minimum";

export type IsoInventoryCategory =
  | "category_1_direct"
  | "category_2_imported_energy"
  | "category_3_transportation"
  | "category_4_products_used"
  | "category_5_use_of_products"
  | "category_6_other_indirect";

export interface Organization {
  id: number;
  name: string;
  legalEntity?: string;
  createdAt: string;
}

export interface Facility {
  id: number;
  organizationId: number;
  name: string;
  country?: string;
  createdAt: string;
}

export interface ReportingBoundary {
  id: number;
  organizationId: number;
  reportingYear: number;
  consolidationApproach: ConsolidationApproach;
  description?: string;
  createdAt: string;
}
