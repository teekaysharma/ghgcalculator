import type { Express } from "express";
import { createServer, type Server } from "http";
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
} from "../shared/schema";

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
  app.post("/api/auth/register", async (req, res) => {
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

  app.post("/api/auth/login", (req, res, next) => {
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
    return res.json({ user: { id: user.id, email: user.email, name: user.name }, memberships });
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
            product: input.product
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
