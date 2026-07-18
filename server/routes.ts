import type { Express } from "express";
import { createServer, type Server } from "http";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { storage } from "./storage";
import { hashPassword, comparePassword, passport } from "./auth";
import { requireAuth, requireOrg } from "./middleware/tenant";
import { generateCSV } from "./utils/csv";
import {
  Emission,
  ProductData,
  YearlyEmissions,
  ProductIntensity,
  registerSchema,
  loginSchema,
  consolidationApproaches,
  membershipRoles,
} from "../shared/schema";

// -----------------------------------------------------------------------
// ISO setup validation schemas
//
// Ported from codex/review-code-for-gaps-and-improvements and adapted:
// organizationId is no longer accepted from the request body (it comes
// from req.organizationId, resolved by requireOrg -- never trust a
// tenant id supplied by the client). "Organization" renamed to
// "ReportingEntity" per the schema-level reconciliation, see schema.ts.
// -----------------------------------------------------------------------

const reportingEntityCreateSchema = z.object({
  name: z.string().min(1),
  legalEntity: z.string().optional(),
});

const reportingEntityUpdateSchema = reportingEntityCreateSchema;

const facilityCreateSchema = z.object({
  reportingEntityId: z.number().int().positive(),
  name: z.string().min(1),
  country: z.string().optional(),
});

const facilityUpdateSchema = z.object({
  name: z.string().min(1),
  country: z.string().optional(),
});

const consolidationApproachSchema = z.enum(consolidationApproaches);

const reportingBoundaryCreateSchema = z.object({
  reportingEntityId: z.number().int().positive(),
  reportingYear: z.number().int().min(1990).max(2100),
  consolidationApproach: consolidationApproachSchema,
  description: z.string().optional(),
});

const reportingBoundaryUpdateSchema = z.object({
  reportingYear: z.number().int().min(1990).max(2100),
  consolidationApproach: consolidationApproachSchema,
  description: z.string().optional(),
});

function parseBody<T>(schema: z.ZodSchema<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message || "Invalid request payload");
  }
  return parsed.data;
}

// Rate limits, IP-based. Separate limiters for register vs. login: register
// is naturally low-frequency for a real user (you only do it once), so a
// tight limit has little cost to legitimate use and blocks bulk account
// creation. Login needs more headroom for someone who mistypes a password
// a few times, but still caps credential-stuffing attempts.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many accounts created from this address, try again later." },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many login attempts, try again later." },
});

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "org"
  );
}

export async function registerRoutes(app: Express): Promise<Server> {
  // -----------------------------------------------------------------------
  // Auth
  //
  // Registration creates a user, an organization, and the membership that
  // links them (role: owner) in one flow. There is no separate "invite" flow
  // yet -- day-one signup is one user standing up one organization. Adding a
  // second member is a createMembership call against an existing org, which
  // storage.ts already supports; wiring an invite endpoint is future scope.
  // -----------------------------------------------------------------------
  app.post("/api/auth/register", registerLimiter, async (req, res) => {
    try {
      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid input", errors: parsed.error.flatten() });
      }
      const { email, password, name, organizationName } = parsed.data;

      const existing = await storage.getUserByEmail(email);
      if (existing) {
        return res.status(409).json({ message: "An account with this email already exists" });
      }

      const passwordHash = await hashPassword(password);
      const user = await storage.createUser({ email, passwordHash, name: name ?? null });

      let slug = slugify(organizationName);
      let org = await storage.getOrganizationBySlug(slug);
      if (org) {
        // Slug collision: append the new user's id to keep it unique rather
        // than fail signup over a cosmetic slug clash.
        slug = `${slug}-${user.id}`;
      }
      const organization = await storage.createOrganization({ name: organizationName, slug });
      await storage.createMembership({ userId: user.id, organizationId: organization.id, role: "owner" });

      req.login(user, (err) => {
        if (err) return res.status(500).json({ message: "Registered, but failed to start session" });
        return res.status(201).json({
          user: { id: user.id, email: user.email, name: user.name },
          organization: { id: organization.id, name: organization.name, slug: organization.slug },
        });
      });
    } catch (error) {
      console.error("Registration error:", error);
      return res.status(500).json({ message: "Failed to register" });
    }
  });

  app.post("/api/auth/login", loginLimiter, (req, res, next) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid input", errors: parsed.error.flatten() });
    }
    passport.authenticate("local", (err: unknown, user: Express.User | false, info: { message?: string }) => {
      if (err) return next(err);
      if (!user) return res.status(401).json({ message: info?.message || "Invalid email or password" });
      req.login(user, (loginErr) => {
        if (loginErr) return next(loginErr);
        return res.json({ user: { id: user.id, email: user.email, name: user.name } });
      });
    })(req, res, next);
  });

  app.post("/api/auth/logout", (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      req.session.destroy(() => {
        res.clearCookie("connect.sid");
        res.status(204).end();
      });
    });
  });

  app.get("/api/auth/me", requireAuth, async (req, res) => {
    const user = req.user as { id: number; email: string; name: string | null };
    const memberships = await storage.getMembershipsForUser(user.id);
    const organizations = await Promise.all(
      memberships.map(async (m) => {
        const org = await storage.getOrganization(m.organizationId);
        return { organizationId: m.organizationId, role: m.role, name: org?.name ?? null, slug: org?.slug ?? null };
      }),
    );
    return res.json({ user: { id: user.id, email: user.email, name: user.name }, memberships, organizations });
  });

  // -----------------------------------------------------------------------
  // Team -- list members of the caller's org, invite an existing user by
  // email. Deliberately minimal: invites only work for accounts that
  // already exist (no email delivery / signup-by-invite-token flow yet,
  // see README known gaps). Only owner/admin can invite.
  // -----------------------------------------------------------------------
  app.get("/api/team", requireAuth, requireOrg, async (req, res) => {
    const members = await storage.listMembershipsForOrganization(req.organizationId!);
    return res.json({
      members: members.map((m) => ({ id: m.id, userId: m.userId, email: m.userEmail, name: m.userName, role: m.role, createdAt: m.createdAt })),
    });
  });

  const inviteSchema = z.object({
    email: z.string().email(),
    role: z.enum(membershipRoles).default("member"),
  });

  app.post("/api/team/invite", requireAuth, requireOrg, async (req, res) => {
    if (req.membership!.role !== "owner" && req.membership!.role !== "admin") {
      return res.status(403).json({ message: "Only an owner or admin can invite team members" });
    }
    try {
      const { email, role } = parseBody(inviteSchema, req.body);
      const user = await storage.getUserByEmail(email);
      if (!user) {
        return res.status(404).json({
          message: "No account exists for that email yet. They need to register before you can add them to your organization.",
        });
      }
      const existing = await storage.getMembership(user.id, req.organizationId!);
      if (existing) {
        return res.status(409).json({ message: "This person is already a member of your organization" });
      }
      const membership = await storage.createMembership({ userId: user.id, organizationId: req.organizationId!, role });
      return res.status(201).json({ membership: { id: membership.id, email: user.email, name: user.name, role: membership.role } });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid invite payload" });
    }
  });

  // -----------------------------------------------------------------------
  // Emission factors -- persisted, tenant-scoped
  // -----------------------------------------------------------------------
  app.get("/api/emission-factors", requireAuth, requireOrg, async (req, res) => {
    try {
      const factors = await storage.listEmissionFactors(req.organizationId!);
      return res.json({ factors });
    } catch (error) {
      console.error("List emission factors error:", error);
      return res.status(500).json({ message: "Failed to list emission factors" });
    }
  });

  app.post("/api/emission-factors", requireAuth, requireOrg, async (req, res) => {
    try {
      const { factors } = req.body as { factors?: Array<Record<string, unknown>> };
      if (!factors || !Array.isArray(factors) || factors.length === 0) {
        return res.status(400).json({ message: "Missing factors array" });
      }
      const user = req.user as { id: number };
      const rows = factors.map((f) => ({
        name: String(f.name),
        factor: String(f.factor),
        unit: String(f.unit),
        scope: f.scope ? String(f.scope) : null,
        category: f.category ? String(f.category) : null,
        wasteType: f.wasteType ? String(f.wasteType) : null,
        disposalMethod: f.disposalMethod ? String(f.disposalMethod) : null,
        source: f.source ? String(f.source) : null,
        uploadedBy: user.id,
      }));
      const created = await storage.createEmissionFactors(req.organizationId!, rows);
      return res.status(201).json({ factors: created });
    } catch (error) {
      console.error("Create emission factors error:", error);
      return res.status(500).json({ message: "Failed to save emission factors" });
    }
  });

  app.delete("/api/emission-factors/:id", requireAuth, requireOrg, async (req, res) => {
    try {
      const deleted = await storage.deleteEmissionFactor(req.organizationId!, Number(req.params.id));
      if (!deleted) return res.status(404).json({ message: "Emission factor not found" });
      return res.status(204).end();
    } catch (error) {
      console.error("Delete emission factor error:", error);
      return res.status(500).json({ message: "Failed to delete emission factor" });
    }
  });

  // -----------------------------------------------------------------------
  // Emission records -- persisted, tenant-scoped
  // -----------------------------------------------------------------------
  app.get("/api/emission-records", requireAuth, requireOrg, async (req, res) => {
    try {
      const records = await storage.listEmissionRecords(req.organizationId!);
      return res.json({ records });
    } catch (error) {
      console.error("List emission records error:", error);
      return res.status(500).json({ message: "Failed to list emission records" });
    }
  });

  // -----------------------------------------------------------------------
  // ISO 14064-1 boundary setup -- reporting entities, facilities,
  // reporting boundaries. Reconciled from codex/review-code-for-gaps-and-
  // improvements: same validation and duplicate-prevention logic, now
  // tenant-scoped and backed by real Postgres tables + DB unique
  // constraints instead of a JSON file snapshot.
  // -----------------------------------------------------------------------

  app.get("/api/reporting-entities", requireAuth, requireOrg, async (req, res) => {
    const reportingEntitiesList = await storage.listReportingEntities(req.organizationId!);
    return res.json({ reportingEntities: reportingEntitiesList });
  });

  app.post("/api/reporting-entities", requireAuth, requireOrg, async (req, res) => {
    try {
      const data = parseBody(reportingEntityCreateSchema, req.body);
      const entity = await storage.createReportingEntity({ ...data, organizationId: req.organizationId! });
      return res.status(201).json({ reportingEntity: entity });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid reporting entity payload" });
    }
  });

  app.put("/api/reporting-entities/:id", requireAuth, requireOrg, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid reporting entity id" });
    try {
      const data = parseBody(reportingEntityUpdateSchema, req.body);
      const entity = await storage.updateReportingEntity(req.organizationId!, id, data);
      if (!entity) return res.status(404).json({ message: "Reporting entity not found" });
      return res.json({ reportingEntity: entity });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid reporting entity payload" });
    }
  });

  app.delete("/api/reporting-entities/:id", requireAuth, requireOrg, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid reporting entity id" });
    const deleted = await storage.deleteReportingEntity(req.organizationId!, id);
    if (!deleted) return res.status(404).json({ message: "Reporting entity not found" });
    return res.status(204).end();
  });

  app.get("/api/facilities", requireAuth, requireOrg, async (req, res) => {
    const facilitiesList = await storage.listFacilities(req.organizationId!);
    return res.json({ facilities: facilitiesList });
  });

  app.post("/api/facilities", requireAuth, requireOrg, async (req, res) => {
    try {
      const data = parseBody(facilityCreateSchema, req.body);
      const entity = await storage.getReportingEntity(req.organizationId!, data.reportingEntityId);
      if (!entity) return res.status(404).json({ message: "Reporting entity not found" });

      const existing = await storage.listFacilities(req.organizationId!);
      const duplicate = existing.some(
        (f) => f.reportingEntityId === data.reportingEntityId && f.name.trim().toLowerCase() === data.name.trim().toLowerCase(),
      );
      if (duplicate) return res.status(409).json({ message: "Facility name already exists for this reporting entity" });

      const facility = await storage.createFacility({ ...data, organizationId: req.organizationId! });
      return res.status(201).json({ facility });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid facility payload" });
    }
  });

  app.put("/api/facilities/:id", requireAuth, requireOrg, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid facility id" });
    try {
      const data = parseBody(facilityUpdateSchema, req.body);
      const target = await storage.getFacility(req.organizationId!, id);
      if (!target) return res.status(404).json({ message: "Facility not found" });

      const existing = await storage.listFacilities(req.organizationId!);
      const duplicate = existing.some(
        (f) => f.id !== id && f.reportingEntityId === target.reportingEntityId && f.name.trim().toLowerCase() === data.name.trim().toLowerCase(),
      );
      if (duplicate) return res.status(409).json({ message: "Facility name already exists for this reporting entity" });

      const facility = await storage.updateFacility(req.organizationId!, id, data);
      return res.json({ facility });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid facility payload" });
    }
  });

  app.delete("/api/facilities/:id", requireAuth, requireOrg, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid facility id" });
    const deleted = await storage.deleteFacility(req.organizationId!, id);
    if (!deleted) return res.status(404).json({ message: "Facility not found" });
    return res.status(204).end();
  });

  app.get("/api/reporting-boundaries", requireAuth, requireOrg, async (req, res) => {
    const boundaries = await storage.listReportingBoundaries(req.organizationId!);
    return res.json({ reportingBoundaries: boundaries });
  });

  app.post("/api/reporting-boundaries", requireAuth, requireOrg, async (req, res) => {
    try {
      const data = parseBody(reportingBoundaryCreateSchema, req.body);
      const entity = await storage.getReportingEntity(req.organizationId!, data.reportingEntityId);
      if (!entity) return res.status(404).json({ message: "Reporting entity not found" });

      const existing = await storage.listReportingBoundaries(req.organizationId!);
      const duplicate = existing.some(
        (b) => b.reportingEntityId === data.reportingEntityId && b.reportingYear === data.reportingYear,
      );
      if (duplicate) return res.status(409).json({ message: "Reporting boundary already exists for this entity and year" });

      const boundary = await storage.createReportingBoundary({ ...data, organizationId: req.organizationId! });
      return res.status(201).json({ boundary });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid boundary payload" });
    }
  });

  app.put("/api/reporting-boundaries/:id", requireAuth, requireOrg, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid reporting boundary id" });
    try {
      const data = parseBody(reportingBoundaryUpdateSchema, req.body);
      const boundaries = await storage.listReportingBoundaries(req.organizationId!);
      const target = boundaries.find((b) => b.id === id);
      if (!target) return res.status(404).json({ message: "Reporting boundary not found" });

      const duplicate = boundaries.some(
        (b) => b.id !== id && b.reportingEntityId === target.reportingEntityId && b.reportingYear === data.reportingYear,
      );
      if (duplicate) return res.status(409).json({ message: "Reporting boundary already exists for this entity and year" });

      const boundary = await storage.updateReportingBoundary(req.organizationId!, id, data);
      return res.json({ boundary });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid boundary payload" });
    }
  });

  app.delete("/api/reporting-boundaries/:id", requireAuth, requireOrg, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid reporting boundary id" });
    const deleted = await storage.deleteReportingBoundary(req.organizationId!, id);
    if (!deleted) return res.status(404).json({ message: "Reporting boundary not found" });
    return res.status(204).end();
  });

  // Setup completeness for the caller's tenant. Same readyForCalculation
  // logic as codex/review-code-for-gaps-and-improvements: at least one
  // reporting entity, one facility, and one reporting boundary must exist
  // before calculation is considered ISO-14064-1-boundary-defined.
  app.get("/api/setup-status", requireAuth, requireOrg, async (req, res) => {
    const [entities, facilitiesList, boundaries] = await Promise.all([
      storage.listReportingEntities(req.organizationId!),
      storage.listFacilities(req.organizationId!),
      storage.listReportingBoundaries(req.organizationId!),
    ]);
    const setupStatus = {
      reportingEntityCount: entities.length,
      facilityCount: facilitiesList.length,
      boundaryCount: boundaries.length,
      readyForCalculation: entities.length > 0 && facilitiesList.length > 0 && boundaries.length > 0,
    };
    return res.json({ setupStatus });
  });

  // Calculate emissions endpoint. Unchanged calculation logic (kept exactly
  // as verified working on main). What changed: it now requires auth, and
  // optionally persists results when `persist: true` is sent, instead of
  // always computing and discarding.
  app.post("/api/calculate", requireAuth, requireOrg, async (req, res) => {
    try {
      const { inputs, emissionFactors, persist } = req.body;
      
      if (!inputs || !emissionFactors) {
        return res.status(400).json({ message: "Missing inputs or emission factors" });
      }

      // Setup-completeness gate, ported from codex/review-code-for-gaps-and-
      // improvements. NOTE: this will reject calculation requests from the
      // existing calculator UI (EmissionCalculator.tsx) until it's updated
      // to create a reporting entity/facility/boundary first -- that UI
      // work has not been done yet, see PROJECT INSTRUCTIONS known gaps.
      const [entities, facilitiesList, boundaries] = await Promise.all([
        storage.listReportingEntities(req.organizationId!),
        storage.listFacilities(req.organizationId!),
        storage.listReportingBoundaries(req.organizationId!),
      ]);
      if (entities.length === 0 || facilitiesList.length === 0 || boundaries.length === 0) {
        return res.status(400).json({
          message: "Setup incomplete. Configure at least one reporting entity, facility, and reporting boundary before calculation.",
        });
      }
      
      const results = { scope1: 0, scope2: 0, scope3: 0 };
      const emissions: Emission[] = [];
      
      // Calculate emissions for each scope
      for (const scope of ['scope1', 'scope2', 'scope3'] as const) {
        for (const input of inputs[scope]) {
          // Skip incomplete entries
          if (!input.activity || !input.unit || !input.qty) continue;
          
          const factor = emissionFactors[input.activity]?.factor || 0;
          const emission = factor * input.qty;
          
          results[scope] += emission;
          
          emissions.push({
            scope: scope,
            activity: input.activity,
            unit: input.unit,
            quantity: input.qty,
            factor,
            emission,
            year: input.year,
            product: input.product,
            scope3Category: input.scope3Category || emissionFactors[input.activity]?.category
          });
        }
      }

      // Opt-in persistence. Existing calculator UI (EmissionCalculator.tsx)
      // was not built with this in mind, so this defaults to off (compute
      // and return, same as before) unless the caller explicitly asks for
      // it. Wiring the calculator UI to pass persist: true is a follow-up,
      // not done in this branch.
      if (persist) {
        const user = req.user as { id: number };
        await storage.createEmissionRecords(
          req.organizationId!,
          emissions.map((e) => ({
            createdBy: user.id,
            scope: e.scope,
            activity: e.activity,
            unit: e.unit,
            quantity: String(e.quantity),
            factor: String(e.factor),
            emission: String(e.emission),
            year: e.year ?? null,
            product: e.product ?? null,
            wasteType: e.wasteType ?? null,
            disposalMethod: e.disposalMethod ?? null,
            scope3Category: e.scope3Category ?? null,
          })),
        );
      }
      
      return res.json({ 
        results, 
        emissions 
      });
    } catch (error) {
      console.error("Calculation error:", error);
      return res.status(500).json({ message: "Failed to calculate emissions" });
    }
  });
  
  // Download CSV endpoint
  app.post("/api/download-csv", requireAuth, requireOrg, (req, res) => {
    try {
      const { emissions } = req.body;
      
      if (!emissions || !Array.isArray(emissions)) {
        return res.status(400).json({ message: "Invalid emissions data" });
      }
      
      const csv = generateCSV(emissions);
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=GHG_Emissions_Report.csv');
      
      return res.send(csv);
    } catch (error) {
      console.error("CSV generation error:", error);
      return res.status(500).json({ message: "Failed to generate CSV" });
    }
  });

  // Calculate yearly comparison
  app.post("/api/yearly-comparison", requireAuth, requireOrg, (req, res) => {
    try {
      const { emissions } = req.body;
      
      if (!emissions || !Array.isArray(emissions)) {
        return res.status(400).json({ message: "Invalid emissions data" });
      }
      
      // Group emissions by year
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
            total: 0
          });
        }
        
        const yearData = yearlyEmissionsMap.get(year)!;
        // Type-safe update of the appropriate scope
        if (emission.scope === 'scope1') yearData.scope1 += emission.emission;
        else if (emission.scope === 'scope2') yearData.scope2 += emission.emission;
        else if (emission.scope === 'scope3') yearData.scope3 += emission.emission;
        
        yearData.total += emission.emission;
      }
      
      // Convert map to array for response
      const yearlyEmissions = Array.from(yearlyEmissionsMap.values())
        .sort((a, b) => a.year - b.year);
      
      return res.json({ yearlyEmissions });
    } catch (error) {
      console.error("Yearly comparison error:", error);
      return res.status(500).json({ message: "Failed to calculate yearly comparison" });
    }
  });

  // Calculate emissions intensity per product
  app.post("/api/product-intensity", requireAuth, requireOrg, (req, res) => {
    try {
      const { emissions, productionData } = req.body;
      
      if (!emissions || !Array.isArray(emissions) || !productionData || !Array.isArray(productionData)) {
        return res.status(400).json({ message: "Invalid emissions or production data" });
      }
      
      // Calculate total emissions per product per year
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
      
      // Calculate intensity
      const productIntensities: ProductIntensity[] = [];
      
      for (const productData of productionData as ProductData[]) {
        const { name, year, production, unit } = productData;
        
        if (!productEmissionsMap.has(name) || !productEmissionsMap.get(name)!.has(year)) {
          continue;
        }
        
        const emissions = productEmissionsMap.get(name)!.get(year)!;
        const intensity = production > 0 ? emissions / production : 0;
        
        productIntensities.push({
          product: name,
          year,
          emissions,
          production,
          intensity,
          unit
        });
      }
      
      return res.json({ productIntensities });
    } catch (error) {
      console.error("Product intensity error:", error);
      return res.status(500).json({ message: "Failed to calculate product intensities" });
    }
  });

  const httpServer = createServer(app);

  return httpServer;
}
