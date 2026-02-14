import type { Express } from "express";
import { createServer, type Server } from "http";
import { z } from "zod";
import { generateCSV } from "./utils/csv";
import {
  Emission,
  ProductData,
  YearlyEmissions,
  ProductIntensity
} from "../shared/schema";
import { storage } from "./storage";

const scopeTypeSchema = z.enum(["scope1", "scope2", "scope3"]);

const emissionInputSchema = z.object({
  activity: z.string().min(1),
  unit: z.string().min(1),
  qty: z.number().nonnegative(),
  year: z.number().int().optional(),
  product: z.string().optional(),
  scope3Category: z.string().optional(),
});

const factorSchema = z.object({
  name: z.string(),
  factor: z.number(),
  unit: z.string(),
  category: z.string().optional(),
});

const calculateRequestSchema = z.object({
  inputs: z.object({
    scope1: z.array(emissionInputSchema),
    scope2: z.array(emissionInputSchema),
    scope3: z.array(emissionInputSchema),
  }),
  emissionFactors: z.record(factorSchema),
});

const emissionSchema = z.object({
  scope: scopeTypeSchema,
  activity: z.string(),
  unit: z.string(),
  quantity: z.number(),
  factor: z.number(),
  emission: z.number(),
  year: z.number().optional(),
  product: z.string().optional(),
  wasteType: z.string().optional(),
  disposalMethod: z.string().optional(),
  scope3Category: z.string().optional(),
});

const emissionsRequestSchema = z.object({
  emissions: z.array(emissionSchema),
});

const productionDataSchema = z.object({
  name: z.string(),
  year: z.number().int(),
  production: z.number().nonnegative(),
  unit: z.string(),
});

const productIntensityRequestSchema = z.object({
  emissions: z.array(emissionSchema),
  productionData: z.array(productionDataSchema),
});



const consolidationApproachSchema = z.enum(["operational_control", "financial_control", "equity_share"]);

const organizationCreateSchema = z.object({
  name: z.string().min(1),
  legalEntity: z.string().optional(),
});

const facilityCreateSchema = z.object({
  organizationId: z.number().int().positive(),
  name: z.string().min(1),
  country: z.string().optional(),
});

const reportingBoundaryCreateSchema = z.object({
  organizationId: z.number().int().positive(),
  reportingYear: z.number().int().min(1990).max(2100),
  consolidationApproach: consolidationApproachSchema,
  description: z.string().optional(),
});

const parseBody = <T>(schema: z.ZodSchema<T>, body: unknown): T => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message || "Invalid request payload");
  }
  return parsed.data;
};

export async function registerRoutes(app: Express): Promise<Server> {
  app.get("/api/organizations", async (_req, res) => {
    const organizations = await storage.listOrganizations();
    return res.json({ organizations });
  });

  app.post("/api/organizations", async (req, res) => {
    try {
      const data = parseBody(organizationCreateSchema, req.body);
      const organization = await storage.createOrganization(data);
      return res.status(201).json({ organization });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid organization payload" });
    }
  });


  app.delete("/api/organizations/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid organization id" });

    const deleted = await storage.deleteOrganization(id);
    if (!deleted) return res.status(404).json({ message: "Organization not found" });

    return res.status(204).end();
  });

  app.get("/api/facilities", async (_req, res) => {
    const facilities = await storage.listFacilities();
    return res.json({ facilities });
  });

  app.post("/api/facilities", async (req, res) => {
    try {
      const data = parseBody(facilityCreateSchema, req.body);
      const organizations = await storage.listOrganizations();
      const facilities = await storage.listFacilities();

      const orgExists = organizations.some((org) => org.id === data.organizationId);
      if (!orgExists) return res.status(404).json({ message: "Organization not found" });

      const duplicateFacility = facilities.some(
        (facility) =>
          facility.organizationId === data.organizationId &&
          facility.name.trim().toLowerCase() === data.name.trim().toLowerCase(),
      );
      if (duplicateFacility) {
        return res.status(409).json({ message: "Facility name already exists for this organization" });
      }

      const facility = await storage.createFacility(data);
      return res.status(201).json({ facility });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid facility payload" });
    }
  });


  app.delete("/api/facilities/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid facility id" });

    const deleted = await storage.deleteFacility(id);
    if (!deleted) return res.status(404).json({ message: "Facility not found" });

    return res.status(204).end();
  });

  app.get("/api/reporting-boundaries", async (_req, res) => {
    const reportingBoundaries = await storage.listReportingBoundaries();
    return res.json({ reportingBoundaries });
  });

  app.get("/api/setup-status", async (_req, res) => {
    const organizations = await storage.listOrganizations();
    const facilities = await storage.listFacilities();
    const reportingBoundaries = await storage.listReportingBoundaries();

    const setupStatus = {
      organizationCount: organizations.length,
      facilityCount: facilities.length,
      boundaryCount: reportingBoundaries.length,
      readyForCalculation: organizations.length > 0 && facilities.length > 0 && reportingBoundaries.length > 0,
    };

    return res.json({ setupStatus });
  });

  app.get("/api/setup-summary", async (req, res) => {
    const organizations = await storage.listOrganizations();
    const facilities = await storage.listFacilities();
    const reportingBoundaries = await storage.listReportingBoundaries();

    const organizationId = req.query.organizationId ? Number(req.query.organizationId) : undefined;

    const filteredOrganizations = Number.isInteger(organizationId)
      ? organizations.filter((org) => org.id === organizationId)
      : organizations;

    const organizationsWithFacilities = filteredOrganizations.map((org) => ({
      ...org,
      facilities: facilities.filter((facility) => facility.organizationId === org.id),
      boundaries: reportingBoundaries.filter((boundary) => boundary.organizationId === org.id),
    }));

    return res.json({ organizations: organizationsWithFacilities });
  });

  app.post("/api/reporting-boundaries", async (req, res) => {
    try {
      const data = parseBody(reportingBoundaryCreateSchema, req.body);
      const organizations = await storage.listOrganizations();
      const reportingBoundaries = await storage.listReportingBoundaries();

      const orgExists = organizations.some((org) => org.id === data.organizationId);
      if (!orgExists) return res.status(404).json({ message: "Organization not found" });

      const duplicateBoundary = reportingBoundaries.some(
        (boundary) => boundary.organizationId === data.organizationId && boundary.reportingYear === data.reportingYear,
      );
      if (duplicateBoundary) {
        return res.status(409).json({ message: "Reporting boundary already exists for this organization and year" });
      }

      const boundary = await storage.createReportingBoundary(data);
      return res.status(201).json({ boundary });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid boundary payload" });
    }
  });


  app.delete("/api/reporting-boundaries/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid reporting boundary id" });

    const deleted = await storage.deleteReportingBoundary(id);
    if (!deleted) return res.status(404).json({ message: "Reporting boundary not found" });

    return res.status(204).end();
  });

  app.post("/api/calculate", async (req, res) => {
    try {
      const { inputs, emissionFactors } = parseBody(calculateRequestSchema, req.body);

      const organizations = await storage.listOrganizations();
      const facilities = await storage.listFacilities();
      const reportingBoundaries = await storage.listReportingBoundaries();

      if (organizations.length === 0 || facilities.length === 0 || reportingBoundaries.length === 0) {
        return res.status(400).json({
          message: "Setup incomplete. Configure at least one organization, facility, and reporting boundary before calculation.",
        });
      }

      const results = { scope1: 0, scope2: 0, scope3: 0 };
      const emissions: Emission[] = [];

      for (const scope of ["scope1", "scope2", "scope3"] as const) {
        for (const input of inputs[scope]) {
          const factor = emissionFactors[input.activity]?.factor || 0;
          const emission = factor * input.qty;

          results[scope] += emission;

          emissions.push({
            scope,
            activity: input.activity,
            unit: input.unit,
            quantity: input.qty,
            factor,
            emission,
            year: input.year,
            product: input.product,
            scope3Category: input.scope3Category || emissionFactors[input.activity]?.category,
          });
        }
      }

      return res.json({ results, emissions });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid calculate payload" });
    }
  });

  app.post("/api/download-csv", (req, res) => {
    try {
      const { emissions } = parseBody(emissionsRequestSchema, req.body);
      const csv = generateCSV(emissions);

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", "attachment; filename=GHG_Emissions_Report.csv");

      return res.send(csv);
    } catch (error) {
      return res
        .status(400)
        .json({ message: error instanceof Error ? error.message : "Invalid emissions payload for CSV" });
    }
  });

  app.post("/api/yearly-comparison", (req, res) => {
    try {
      const { emissions } = parseBody(emissionsRequestSchema, req.body);

      const yearlyEmissionsMap = new Map<number, YearlyEmissions>();

      for (const emission of emissions) {
        if (!emission.year) continue;

        const year = emission.year;
        if (!yearlyEmissionsMap.has(year)) {
          yearlyEmissionsMap.set(year, {
            year,
            scope1: 0,
            scope2: 0,
            scope3: 0,
            total: 0,
          });
        }

        const yearData = yearlyEmissionsMap.get(year)!;
        if (emission.scope === "scope1") yearData.scope1 += emission.emission;
        else if (emission.scope === "scope2") yearData.scope2 += emission.emission;
        else if (emission.scope === "scope3") yearData.scope3 += emission.emission;

        yearData.total += emission.emission;
      }

      const yearlyEmissions = Array.from(yearlyEmissionsMap.values()).sort((a, b) => a.year - b.year);

      return res.json({ yearlyEmissions });
    } catch (error) {
      return res
        .status(400)
        .json({ message: error instanceof Error ? error.message : "Invalid emissions payload for yearly comparison" });
    }
  });

  app.post("/api/product-intensity", (req, res) => {
    try {
      const { emissions, productionData } = parseBody(productIntensityRequestSchema, req.body);

      const productEmissionsMap = new Map<string, Map<number, number>>();

      for (const emission of emissions) {
        if (!emission.product || !emission.year) continue;

        const key = emission.product;
        if (!productEmissionsMap.has(key)) {
          productEmissionsMap.set(key, new Map<number, number>());
        }

        const yearMap = productEmissionsMap.get(key)!;
        const year = emission.year;

        if (!yearMap.has(year)) {
          yearMap.set(year, 0);
        }

        yearMap.set(year, yearMap.get(year)! + emission.emission);
      }

      const productIntensities: ProductIntensity[] = [];

      for (const productData of productionData as ProductData[]) {
        const { name, year, production, unit } = productData;

        if (!productEmissionsMap.has(name) || !productEmissionsMap.get(name)!.has(year)) {
          continue;
        }

        const emissionsValue = productEmissionsMap.get(name)!.get(year)!;
        const intensity = production > 0 ? emissionsValue / production : 0;

        productIntensities.push({
          product: name,
          year,
          emissions: emissionsValue,
          production,
          intensity,
          unit,
        });
      }

      return res.json({ productIntensities });
    } catch (error) {
      return res
        .status(400)
        .json({ message: error instanceof Error ? error.message : "Invalid payload for product intensity" });
    }
  });

  const httpServer = createServer(app);

  return httpServer;
}
