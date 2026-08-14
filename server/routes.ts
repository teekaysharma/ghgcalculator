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
  GasComponent,
  ProductData,
  YearlyEmissions,
  ProductIntensity,
  registerSchema,
  loginSchema,
  consolidationApproaches,
  membershipRoles,
  materialityLevels,
  quantificationApproaches,
  dataQualityTiers,
  verificationFindingTypes,
  verificationSeverities,
  verificationStatuses,
  mitigationStatuses,
  facilityContactTypes,
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

function toNumericField(value: number | string | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

const numericInput = z.union([z.number(), z.string()]).optional();

const facilityIdentifierUpsertSchema = z.object({
  groupParentEntity: z.string().optional(),
  economicLicenceNumber: z.string().optional(),
  environmentalPermitNumber: z.string().optional(),
  address: z.string().optional(),
  coordinatesLat: numericInput,
  coordinatesLng: numericInput,
  primaryBusinessSector: z.string().optional(),
  primaryActivity: z.string().optional(),
  primaryActivityTypeId: z.number().int().positive().optional(),
  isicDivisionId: z.number().int().positive().optional(),
  activityDescription: z.string().optional(),
});

const facilityContactSchema = z.object({
  contactType: z.enum(facilityContactTypes).optional(),
  title: z.string().optional(),
  firstName: z.string().optional(),
  surname: z.string().optional(),
  jobTitle: z.string().optional(),
  organisationName: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
});

const facilityProductSchema = z.object({
  productCode: z.string().optional(),
  productCategory: z.string().optional(),
  productBenchmarkId: z.number().int().positive().optional(),
  productionTechnology: z.string().optional(),
  energyRelatedEmissions: z.boolean().optional(),
  processEmissions: z.boolean().optional(),
  productionCapacity: numericInput,
  productionCapacityUnit: z.string().optional(),
  actualProduction: numericInput,
  actualProductionUnit: z.string().optional(),
});

const sourceStreamCreateSchema = z.object({
  facilityId: z.number().int().positive(),
  name: z.string().min(1),
  streamCode: z.string().optional(),
  description: z.string().optional(),
  ghgSourceCategory: z.string().optional(),
  materiality: z.enum(materialityLevels).optional(),
  estimatedAnnualEmissionsTco2e: numericInput,
  quantificationApproach: z.enum(quantificationApproaches).optional(),
  scope: z.enum(["scope1", "scope2", "scope3"]).optional(),
  scope3Category: z.number().int().min(1).max(15).optional(),
});

const sourceStreamUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  streamCode: z.string().optional(),
  description: z.string().optional(),
  ghgSourceCategory: z.string().optional(),
  materiality: z.enum(materialityLevels).optional(),
  estimatedAnnualEmissionsTco2e: numericInput,
  quantificationApproach: z.enum(quantificationApproaches).optional(),
  scope: z.enum(["scope1", "scope2", "scope3"]).optional(),
  scope3Category: z.number().int().min(1).max(15).optional(),
});

const calculationApproachSchema = z.object({
  fuelOrMaterialType: z.string().optional(),
  activityDataValue: numericInput,
  activityDataUnit: z.string().optional(),
  activityDataSource: z.string().optional(),
  activityDataTier: z.string().optional(),
  emissionFactorValue: numericInput,
  emissionFactorUnit: z.string().optional(),
  emissionFactorSource: z.string().optional(),
  emissionFactorTier: z.string().optional(),
  emissionFactorSourceUrl: z.string().optional(),
  emissionFactorAuthorityName: z.string().optional(),
  isIpccDefault: z.boolean().optional(),
  gasBreakdown: z
    .array(
      z.object({
        gas: z.string(),
        nativeFactor: z.number(),
        gwpValue: z.number(),
        gwpVersion: z.string(),
        gwpSource: z.string(),
        co2ePerUnit: z.number(),
        // Published 95% CI bounds for nativeFactor, carried through from
        // ipccDefaultFactors.factorLower/factorUpper (see GasComponent in
        // shared/schema.ts). Without declaring these here, Zod's default
        // "strip unknown keys" behavior silently drops them on every save,
        // which would make DataQualitySection's uncertainty suggestion
        // permanently empty regardless of what the client sends.
        factorLower: z.number().optional(),
        factorUpper: z.number().optional(),
      }),
    )
    .optional(),
  oxidationOrCarbonationFactor: numericInput,
  oxidationFactorTier: z.string().optional(),
  netCalorificValue: numericInput,
  calculatedEmissionsTco2e: numericInput,
  notes: z.string().optional(),
});

const measurementApproachSchema = z.object({
  measurementMethod: z.string().optional(),
  monitoringFrequency: z.string().optional(),
  measurementUnit: z.string().optional(),
  annualMeasuredQuantity: numericInput,
  qaqcProcedure: z.string().optional(),
  calibrationFrequency: z.string().optional(),
  notes: z.string().optional(),
});

const fallbackApproachSchema = z.object({
  justification: z.string().optional(),
  fallbackMethodDescription: z.string().optional(),
  estimatedEmissionsTco2e: numericInput,
});

const methaneReportUpsertSchema = z.object({
  facilityId: z.number().int().positive(),
  reportingBoundaryId: z.number().int().positive(),
  methaneSourcesDescription: z.string().optional(),
  quantificationMethod: z.string().optional(),
  annualMethaneEmissions: numericInput,
  annualMethaneEmissionsUnit: z.string().optional(),
  notes: z.string().optional(),
});

const dataQualityRecordSchema = z.object({
  dataQualityTier: z.enum(dataQualityTiers).optional(),
  uncertaintyPercent: numericInput,
  uncertaintyJustification: z.string().optional(),
  usedIpccDefaultFactor: z.boolean().optional(),
  ipccDefaultSubstitutionReason: z.string().optional(),
});

const verificationFindingCreateSchema = z.object({
  findingType: z.enum(verificationFindingTypes),
  description: z.string().min(1),
  severity: z.enum(verificationSeverities).optional(),
  status: z.enum(verificationStatuses).optional(),
  resolutionNotes: z.string().optional(),
});

const verificationFindingUpdateSchema = verificationFindingCreateSchema;

const managementQaCreateSchema = z.object({
  qaProcedureDescription: z.string().optional(),
  responsiblePerson: z.string().optional(),
  reviewFrequency: z.string().optional(),
  lastReviewDate: z.string().optional(),
});

const managementQaUpdateSchema = managementQaCreateSchema;

const mitigationMeasureCreateSchema = z.object({
  measureDescription: z.string().min(1),
  status: z.enum(mitigationStatuses).optional(),
  estimatedReductionTco2e: numericInput,
  targetDate: z.string().optional(),
  notes: z.string().optional(),
});

const mitigationMeasureUpdateSchema = mitigationMeasureCreateSchema;

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
      for (let i = 0; i < factors.length; i++) {
        const f = factors[i];
        if (typeof f.name !== "string" || !f.name.trim()) {
          return res.status(400).json({ message: `factors[${i}]: name is required` });
        }
        if (typeof f.factor !== "number" || !Number.isFinite(f.factor)) {
          return res.status(400).json({ message: `factors[${i}]: factor must be a number` });
        }
        if (typeof f.unit !== "string" || !f.unit.trim()) {
          return res.status(400).json({ message: `factors[${i}]: unit is required` });
        }
        // Traceability is mandatory for every org-uploaded factor -- these
        // supplement the IPCC defaults, they never replace them, so every
        // supplement must be traceable to a real, checkable source. See
        // shared/schema.ts (emissionFactorsTable.sourceUrl/authorityName).
        if (typeof f.sourceUrl !== "string" || !/^https?:\/\/.+/i.test(f.sourceUrl.trim())) {
          return res.status(400).json({
            message: `factors[${i}]: sourceUrl is required and must be a full http(s) link to the traceable source`,
          });
        }
        if (typeof f.authorityName !== "string" || !f.authorityName.trim()) {
          return res.status(400).json({ message: `factors[${i}]: authorityName is required` });
        }
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
        year: typeof f.year === "number" && Number.isFinite(f.year) ? f.year : null,
        sourceUrl: String(f.sourceUrl).trim(),
        authorityName: String(f.authorityName).trim(),
        sourceTier: f.sourceTier ? String(f.sourceTier) : null,
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

  // Finalize/recalculate snapshot mechanic (ISO 14064-3: verification
  // applies to a fixed, dated statement). Finalizing locks the boundary's
  // numbers; recalculating requires a stated reason, logged as a
  // verification finding so it's part of the same audit trail a verifier
  // already reviews (ISO 14064-1 / GRI 102 recalculation-disclosure).
  app.patch("/api/reporting-boundaries/:id/finalize", requireAuth, requireOrg, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid reporting boundary id" });

    const existing = await storage.getReportingBoundary(req.organizationId!, id);
    if (!existing) return res.status(404).json({ message: "Reporting boundary not found" });

    // Equity-share consolidation requires an ownership percentage for
    // every facility under the entity -- otherwise the rollup (Plan 3's
    // getConsolidatedReport) can't apply a meaningful multiplier and would
    // silently zero out any facility missing one. Caught here, at the
    // finalize gate, rather than left to be discovered in the report.
    if (existing.consolidationApproach === "equity_share") {
      const entityFacilities = await storage.listFacilities(req.organizationId!);
      const missingEquity = entityFacilities.filter(
        (f) => f.reportingEntityId === existing.reportingEntityId && f.equityShareOwnershipPercent === null,
      );
      if (missingEquity.length > 0) {
        return res.status(400).json({
          message: `Cannot finalize: equity share consolidation requires an ownership percentage for every facility. Missing for: ${missingEquity.map((f) => f.name).join(", ")}.`,
        });
      }
    }

    const boundary = await storage.updateReportingBoundary(req.organizationId!, id, {
      status: "finalized",
      finalizedAt: new Date(),
    });
    return res.json({ reportingBoundary: boundary });
  });

  // Consolidated multi-facility rollup report (Plan 3's auditable global
  // data sheet): sums every facility under the boundary's reporting
  // entity for that year, applying equity-share percentages when that's
  // the declared consolidation approach.
  app.get("/api/reporting-boundaries/:id/consolidated-report", requireAuth, requireOrg, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid reporting boundary id" });
    const report = await storage.getConsolidatedReport(req.organizationId!, id);
    if (!report) return res.status(404).json({ message: "Reporting boundary not found" });
    return res.json({ report });
  });

  const recalculateSchema = z.object({ reason: z.string().trim().min(1, "A reason is required to recalculate a finalized report") });

  app.patch("/api/reporting-boundaries/:id/recalculate", requireAuth, requireOrg, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid reporting boundary id" });
    try {
      const { reason } = parseBody(recalculateSchema, req.body);
      const existing = await storage.getReportingBoundary(req.organizationId!, id);
      if (!existing) return res.status(404).json({ message: "Reporting boundary not found" });

      // Record the recalculation as a verification finding so it's part of
      // the same audit trail a verifier already reviews (ISO 14064-1's
      // recalculation-disclosure requirement), then reopen the boundary to
      // draft so edits + recompute (Task 1's pipeline) can proceed; the
      // caller re-finalizes when done. "observation" is the closest fit in
      // verificationFindingTypes for a neutral, descriptive audit note (no
      // "recalculation" value exists); "minor"/"closed" are the closest
      // fits in verificationSeverities/verificationStatuses for a routine,
      // already-resolved event (no "informational"/"resolved" values exist).
      await storage.createVerificationFinding({
        organizationId: req.organizationId!,
        reportingBoundaryId: id,
        findingType: "observation",
        description: `Report reopened for recalculation. Reason: ${reason}`,
        severity: "minor",
        status: "closed",
        resolutionNotes: null,
      });
      const updated = await storage.updateReportingBoundary(req.organizationId!, id, {
        status: "draft",
        finalizedAt: null,
      });
      return res.json({ reportingBoundary: updated });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid recalculate payload" });
    }
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

  // -----------------------------------------------------------------------
  // Facility-level MRV granularity layer
  //
  // Sits on top of the ISO 14064-1 boundary layer above. Every route here
  // follows the same tenant-isolation pattern as /api/facilities and
  // /api/reporting-boundaries: parent resource ownership (facility,
  // reporting boundary, or source stream) is verified against
  // req.organizationId! before any write, returning 404 if the parent
  // doesn't belong to the caller's org. See shared/schema.ts's "Facility-
  // level MRV granularity layer" comment for the full design rationale.
  // -----------------------------------------------------------------------

  // --- Facility identifiers (1:1 with facility) ---
  app.get("/api/facilities/:facilityId/identifier", requireAuth, requireOrg, async (req, res) => {
    const facilityId = Number(req.params.facilityId);
    if (!Number.isInteger(facilityId) || facilityId <= 0) return res.status(400).json({ message: "Invalid facility id" });
    const identifier = await storage.getFacilityIdentifier(req.organizationId!, facilityId);
    return res.json({ identifier: identifier ?? null });
  });

  app.put("/api/facilities/:facilityId/identifier", requireAuth, requireOrg, async (req, res) => {
    const facilityId = Number(req.params.facilityId);
    if (!Number.isInteger(facilityId) || facilityId <= 0) return res.status(400).json({ message: "Invalid facility id" });
    try {
      const data = parseBody(facilityIdentifierUpsertSchema, req.body);
      const facility = await storage.getFacility(req.organizationId!, facilityId);
      if (!facility) return res.status(404).json({ message: "Facility not found" });

      const identifier = await storage.upsertFacilityIdentifier({
        ...data,
        coordinatesLat: toNumericField(data.coordinatesLat),
        coordinatesLng: toNumericField(data.coordinatesLng),
        organizationId: req.organizationId!,
        facilityId,
      });
      return res.json({ identifier });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid facility identifier payload" });
    }
  });

  // --- Facility contacts ---
  app.get("/api/facilities/:facilityId/contacts", requireAuth, requireOrg, async (req, res) => {
    const facilityId = Number(req.params.facilityId);
    if (!Number.isInteger(facilityId) || facilityId <= 0) return res.status(400).json({ message: "Invalid facility id" });
    const contacts = await storage.listFacilityContacts(req.organizationId!, facilityId);
    return res.json({ contacts });
  });

  app.post("/api/facilities/:facilityId/contacts", requireAuth, requireOrg, async (req, res) => {
    const facilityId = Number(req.params.facilityId);
    if (!Number.isInteger(facilityId) || facilityId <= 0) return res.status(400).json({ message: "Invalid facility id" });
    try {
      const data = parseBody(facilityContactSchema, req.body);
      const facility = await storage.getFacility(req.organizationId!, facilityId);
      if (!facility) return res.status(404).json({ message: "Facility not found" });

      const contact = await storage.createFacilityContact({ ...data, organizationId: req.organizationId!, facilityId });
      return res.status(201).json({ contact });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid facility contact payload" });
    }
  });

  app.put("/api/facility-contacts/:id", requireAuth, requireOrg, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid facility contact id" });
    try {
      const data = parseBody(facilityContactSchema, req.body);
      const contact = await storage.updateFacilityContact(req.organizationId!, id, data);
      if (!contact) return res.status(404).json({ message: "Facility contact not found" });
      return res.json({ contact });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid facility contact payload" });
    }
  });

  app.delete("/api/facility-contacts/:id", requireAuth, requireOrg, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid facility contact id" });
    const deleted = await storage.deleteFacilityContact(req.organizationId!, id);
    if (!deleted) return res.status(404).json({ message: "Facility contact not found" });
    return res.status(204).end();
  });

  // --- Facility products ---
  app.get("/api/facilities/:facilityId/products", requireAuth, requireOrg, async (req, res) => {
    const facilityId = Number(req.params.facilityId);
    if (!Number.isInteger(facilityId) || facilityId <= 0) return res.status(400).json({ message: "Invalid facility id" });
    const products = await storage.listFacilityProducts(req.organizationId!, facilityId);
    return res.json({ products });
  });

  app.post("/api/facilities/:facilityId/products", requireAuth, requireOrg, async (req, res) => {
    const facilityId = Number(req.params.facilityId);
    if (!Number.isInteger(facilityId) || facilityId <= 0) return res.status(400).json({ message: "Invalid facility id" });
    try {
      const data = parseBody(facilityProductSchema, req.body);
      const facility = await storage.getFacility(req.organizationId!, facilityId);
      if (!facility) return res.status(404).json({ message: "Facility not found" });

      const product = await storage.createFacilityProduct({
        ...data,
        productionCapacity: toNumericField(data.productionCapacity),
        actualProduction: toNumericField(data.actualProduction),
        organizationId: req.organizationId!,
        facilityId,
      });
      return res.status(201).json({ product });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid facility product payload" });
    }
  });

  app.put("/api/facility-products/:id", requireAuth, requireOrg, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid facility product id" });
    try {
      const data = parseBody(facilityProductSchema, req.body);
      const product = await storage.updateFacilityProduct(req.organizationId!, id, {
        ...data,
        productionCapacity: toNumericField(data.productionCapacity),
        actualProduction: toNumericField(data.actualProduction),
      });
      if (!product) return res.status(404).json({ message: "Facility product not found" });
      return res.json({ product });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid facility product payload" });
    }
  });

  app.delete("/api/facility-products/:id", requireAuth, requireOrg, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid facility product id" });
    const deleted = await storage.deleteFacilityProduct(req.organizationId!, id);
    if (!deleted) return res.status(404).json({ message: "Facility product not found" });
    return res.status(204).end();
  });

  // --- Source streams ---
  app.get("/api/reporting-boundaries/:boundaryId/source-streams", requireAuth, requireOrg, async (req, res) => {
    const boundaryId = Number(req.params.boundaryId);
    if (!Number.isInteger(boundaryId) || boundaryId <= 0) return res.status(400).json({ message: "Invalid reporting boundary id" });
    const sourceStreamsList = await storage.listSourceStreams(req.organizationId!, boundaryId);
    return res.json({ sourceStreams: sourceStreamsList });
  });

  app.post("/api/reporting-boundaries/:boundaryId/source-streams", requireAuth, requireOrg, async (req, res) => {
    const boundaryId = Number(req.params.boundaryId);
    if (!Number.isInteger(boundaryId) || boundaryId <= 0) return res.status(400).json({ message: "Invalid reporting boundary id" });
    try {
      const data = parseBody(sourceStreamCreateSchema, req.body);

      const boundaries = await storage.listReportingBoundaries(req.organizationId!);
      const boundary = boundaries.find((b) => b.id === boundaryId);
      if (!boundary) return res.status(404).json({ message: "Reporting boundary not found" });

      const facility = await storage.getFacility(req.organizationId!, data.facilityId);
      if (!facility) return res.status(404).json({ message: "Facility not found" });

      const sourceStream = await storage.createSourceStream({
        ...data,
        estimatedAnnualEmissionsTco2e: toNumericField(data.estimatedAnnualEmissionsTco2e),
        organizationId: req.organizationId!,
        reportingBoundaryId: boundaryId,
      });
      return res.status(201).json({ sourceStream });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid source stream payload" });
    }
  });

  app.get("/api/source-streams/:id", requireAuth, requireOrg, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid source stream id" });
    const sourceStream = await storage.getSourceStream(req.organizationId!, id);
    if (!sourceStream) return res.status(404).json({ message: "Source stream not found" });
    return res.json({ sourceStream });
  });

  app.put("/api/source-streams/:id", requireAuth, requireOrg, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid source stream id" });
    try {
      const data = parseBody(sourceStreamUpdateSchema, req.body);
      const sourceStream = await storage.updateSourceStream(req.organizationId!, id, {
        ...data,
        estimatedAnnualEmissionsTco2e: toNumericField(data.estimatedAnnualEmissionsTco2e),
      });
      if (!sourceStream) return res.status(404).json({ message: "Source stream not found" });
      return res.json({ sourceStream });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid source stream payload" });
    }
  });

  app.delete("/api/source-streams/:id", requireAuth, requireOrg, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid source stream id" });
    const deleted = await storage.deleteSourceStream(req.organizationId!, id);
    if (!deleted) return res.status(404).json({ message: "Source stream not found" });
    return res.status(204).end();
  });

  // --- Calculation-based approach detail (1:1 with source stream) ---
  app.get("/api/source-streams/:id/calculation-approach", requireAuth, requireOrg, async (req, res) => {
    const sourceStreamId = Number(req.params.id);
    if (!Number.isInteger(sourceStreamId) || sourceStreamId <= 0) return res.status(400).json({ message: "Invalid source stream id" });
    const approach = await storage.getCalculationApproach(req.organizationId!, sourceStreamId);
    return res.json({ calculationApproach: approach ?? null });
  });

  app.put("/api/source-streams/:id/calculation-approach", requireAuth, requireOrg, async (req, res) => {
    const sourceStreamId = Number(req.params.id);
    if (!Number.isInteger(sourceStreamId) || sourceStreamId <= 0) return res.status(400).json({ message: "Invalid source stream id" });
    try {
      const data = parseBody(calculationApproachSchema, req.body);
      const sourceStream = await storage.getSourceStream(req.organizationId!, sourceStreamId);
      if (!sourceStream) return res.status(404).json({ message: "Source stream not found" });

      // Compute the emission server-side whenever we have both an
      // activity-data quantity and a factor, so the persisted number can
      // never drift from its stated inputs (Section 2 of the design spec).
      // activityDataUnit must match emissionFactorUnit exactly -- native-
      // unit conversion (liters/kg -> TJ) is out of scope for this plan
      // (see Global Constraints above); reject with a clear message rather
      // than silently computing something wrong.
      let computedEmissionKg: number | null = null;
      if (
        data.activityDataValue !== undefined &&
        data.activityDataValue !== null &&
        data.emissionFactorValue !== undefined &&
        data.emissionFactorValue !== null
      ) {
        if (
          data.activityDataUnit &&
          data.emissionFactorUnit &&
          data.activityDataUnit.trim().toLowerCase() !== data.emissionFactorUnit.trim().toLowerCase()
        ) {
          return res.status(400).json({
            message: `Activity data unit ("${data.activityDataUnit}") must match the emission factor's unit ("${data.emissionFactorUnit}"). Unit conversion is not yet supported -- enter the activity quantity directly in ${data.emissionFactorUnit}.`,
          });
        }
        computedEmissionKg = Number(data.activityDataValue) * Number(data.emissionFactorValue);
      }

      const approach = await storage.upsertCalculationApproach({
        ...data,
        activityDataValue: toNumericField(data.activityDataValue),
        emissionFactorValue: toNumericField(data.emissionFactorValue),
        oxidationOrCarbonationFactor: toNumericField(data.oxidationOrCarbonationFactor),
        netCalorificValue: toNumericField(data.netCalorificValue),
        // computedEmissionKg is kg CO2e; calculatedEmissionsTco2e is tonnes
        // -- divide by 1000. Falls back to whatever the client sent
        // (manual entry) when there isn't enough data to compute.
        calculatedEmissionsTco2e:
          computedEmissionKg !== null ? String(computedEmissionKg / 1000) : toNumericField(data.calculatedEmissionsTco2e),
        gasBreakdown: data.gasBreakdown ?? null,
        organizationId: req.organizationId!,
        sourceStreamId,
      });

      if (computedEmissionKg !== null) {
        const user = req.user as { id: number };
        await storage.upsertEmissionRecordForCalculationApproach({
          organizationId: req.organizationId!,
          facilityId: sourceStream.facilityId,
          sourceStreamId,
          calculationApproachId: approach.id,
          reportingBoundaryId: sourceStream.reportingBoundaryId,
          createdBy: user.id,
          scope: sourceStream.scope ?? "scope1",
          activity: data.fuelOrMaterialType || sourceStream.name,
          unit: data.activityDataUnit ?? "",
          quantity: String(data.activityDataValue),
          factor: String(data.emissionFactorValue),
          emission: String(computedEmissionKg),
          gasBreakdown: data.gasBreakdown ?? null,
        });
      }

      return res.json({ calculationApproach: approach });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid calculation approach payload" });
    }
  });

  // --- Measurement-based approach detail (1:1 with source stream) ---
  app.get("/api/source-streams/:id/measurement-approach", requireAuth, requireOrg, async (req, res) => {
    const sourceStreamId = Number(req.params.id);
    if (!Number.isInteger(sourceStreamId) || sourceStreamId <= 0) return res.status(400).json({ message: "Invalid source stream id" });
    const approach = await storage.getMeasurementBasedApproach(req.organizationId!, sourceStreamId);
    return res.json({ measurementApproach: approach ?? null });
  });

  app.put("/api/source-streams/:id/measurement-approach", requireAuth, requireOrg, async (req, res) => {
    const sourceStreamId = Number(req.params.id);
    if (!Number.isInteger(sourceStreamId) || sourceStreamId <= 0) return res.status(400).json({ message: "Invalid source stream id" });
    try {
      const data = parseBody(measurementApproachSchema, req.body);
      const sourceStream = await storage.getSourceStream(req.organizationId!, sourceStreamId);
      if (!sourceStream) return res.status(404).json({ message: "Source stream not found" });

      const approach = await storage.upsertMeasurementBasedApproach({
        ...data,
        annualMeasuredQuantity: toNumericField(data.annualMeasuredQuantity),
        organizationId: req.organizationId!,
        sourceStreamId,
      });
      return res.json({ measurementApproach: approach });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid measurement approach payload" });
    }
  });

  // --- Fallback approach detail (1:1 with source stream) ---
  app.get("/api/source-streams/:id/fallback-approach", requireAuth, requireOrg, async (req, res) => {
    const sourceStreamId = Number(req.params.id);
    if (!Number.isInteger(sourceStreamId) || sourceStreamId <= 0) return res.status(400).json({ message: "Invalid source stream id" });
    const approach = await storage.getFallbackApproach(req.organizationId!, sourceStreamId);
    return res.json({ fallbackApproach: approach ?? null });
  });

  app.put("/api/source-streams/:id/fallback-approach", requireAuth, requireOrg, async (req, res) => {
    const sourceStreamId = Number(req.params.id);
    if (!Number.isInteger(sourceStreamId) || sourceStreamId <= 0) return res.status(400).json({ message: "Invalid source stream id" });
    try {
      const data = parseBody(fallbackApproachSchema, req.body);
      const sourceStream = await storage.getSourceStream(req.organizationId!, sourceStreamId);
      if (!sourceStream) return res.status(404).json({ message: "Source stream not found" });

      const estimatedEmissionsTco2e = toNumericField(data.estimatedEmissionsTco2e);
      const approach = await storage.upsertFallbackApproach({
        ...data,
        estimatedEmissionsTco2e,
        organizationId: req.organizationId!,
        sourceStreamId,
      });
      // Mirror the fallback tier's own emissions estimate onto the parent
      // source stream so the source-streams list ("Est. emissions" column)
      // reflects it without requiring a separate manual edit there --
      // calculation/measurement tiers have no equivalent single total to
      // mirror yet (calculatedEmissionsTco2e is never computed, and
      // measurement-based has no emissions-total field at all).
      if (estimatedEmissionsTco2e !== undefined) {
        await storage.updateSourceStream(req.organizationId!, sourceStreamId, {
          estimatedAnnualEmissionsTco2e: estimatedEmissionsTco2e,
        });
      }
      return res.json({ fallbackApproach: approach });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid fallback approach payload" });
    }
  });

  // --- Methane reporting (per facility + reporting boundary) ---
  app.get("/api/methane-reports", requireAuth, requireOrg, async (req, res) => {
    const facilityId = Number(req.query.facilityId);
    const reportingBoundaryId = Number(req.query.reportingBoundaryId);
    if (!Number.isInteger(facilityId) || facilityId <= 0 || !Number.isInteger(reportingBoundaryId) || reportingBoundaryId <= 0) {
      return res.status(400).json({ message: "facilityId and reportingBoundaryId query params are required" });
    }
    const report = await storage.getMethaneReport(req.organizationId!, facilityId, reportingBoundaryId);
    return res.json({ methaneReport: report ?? null });
  });

  app.put("/api/methane-reports", requireAuth, requireOrg, async (req, res) => {
    try {
      const data = parseBody(methaneReportUpsertSchema, req.body);

      const facility = await storage.getFacility(req.organizationId!, data.facilityId);
      if (!facility) return res.status(404).json({ message: "Facility not found" });

      const boundaries = await storage.listReportingBoundaries(req.organizationId!);
      const boundary = boundaries.find((b) => b.id === data.reportingBoundaryId);
      if (!boundary) return res.status(404).json({ message: "Reporting boundary not found" });

      const report = await storage.upsertMethaneReport({
        ...data,
        annualMethaneEmissions: toNumericField(data.annualMethaneEmissions),
        organizationId: req.organizationId!,
      });
      return res.json({ methaneReport: report });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid methane report payload" });
    }
  });

  // --- Data quality / uncertainty (1:1 with source stream) ---
  app.get("/api/source-streams/:id/data-quality", requireAuth, requireOrg, async (req, res) => {
    const sourceStreamId = Number(req.params.id);
    if (!Number.isInteger(sourceStreamId) || sourceStreamId <= 0) return res.status(400).json({ message: "Invalid source stream id" });
    const record = await storage.getDataQualityRecord(req.organizationId!, sourceStreamId);
    return res.json({ dataQualityRecord: record ?? null });
  });

  app.put("/api/source-streams/:id/data-quality", requireAuth, requireOrg, async (req, res) => {
    const sourceStreamId = Number(req.params.id);
    if (!Number.isInteger(sourceStreamId) || sourceStreamId <= 0) return res.status(400).json({ message: "Invalid source stream id" });
    try {
      const data = parseBody(dataQualityRecordSchema, req.body);
      const sourceStream = await storage.getSourceStream(req.organizationId!, sourceStreamId);
      if (!sourceStream) return res.status(404).json({ message: "Source stream not found" });

      const record = await storage.upsertDataQualityRecord({
        ...data,
        uncertaintyPercent: toNumericField(data.uncertaintyPercent),
        usedIpccDefaultFactor: data.usedIpccDefaultFactor ?? false,
        organizationId: req.organizationId!,
        sourceStreamId,
      });
      return res.json({ dataQualityRecord: record });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid data quality payload" });
    }
  });

  // --- Verification findings / data gaps (per reporting boundary) ---
  app.get("/api/reporting-boundaries/:boundaryId/verification-findings", requireAuth, requireOrg, async (req, res) => {
    const boundaryId = Number(req.params.boundaryId);
    if (!Number.isInteger(boundaryId) || boundaryId <= 0) return res.status(400).json({ message: "Invalid reporting boundary id" });
    const findings = await storage.listVerificationFindings(req.organizationId!, boundaryId);
    return res.json({ findings });
  });

  app.post("/api/reporting-boundaries/:boundaryId/verification-findings", requireAuth, requireOrg, async (req, res) => {
    const boundaryId = Number(req.params.boundaryId);
    if (!Number.isInteger(boundaryId) || boundaryId <= 0) return res.status(400).json({ message: "Invalid reporting boundary id" });
    try {
      const data = parseBody(verificationFindingCreateSchema, req.body);

      const boundaries = await storage.listReportingBoundaries(req.organizationId!);
      const boundary = boundaries.find((b) => b.id === boundaryId);
      if (!boundary) return res.status(404).json({ message: "Reporting boundary not found" });

      const finding = await storage.createVerificationFinding({
        ...data,
        status: data.status ?? "open",
        organizationId: req.organizationId!,
        reportingBoundaryId: boundaryId,
      });
      return res.status(201).json({ finding });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid verification finding payload" });
    }
  });

  app.put("/api/verification-findings/:id", requireAuth, requireOrg, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid verification finding id" });
    try {
      const data = parseBody(verificationFindingUpdateSchema, req.body);
      const finding = await storage.updateVerificationFinding(req.organizationId!, id, data);
      if (!finding) return res.status(404).json({ message: "Verification finding not found" });
      return res.json({ finding });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid verification finding payload" });
    }
  });

  app.delete("/api/verification-findings/:id", requireAuth, requireOrg, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid verification finding id" });
    const deleted = await storage.deleteVerificationFinding(req.organizationId!, id);
    if (!deleted) return res.status(404).json({ message: "Verification finding not found" });
    return res.status(204).end();
  });

  // --- Management system & QA procedures (per reporting boundary) ---
  app.get("/api/reporting-boundaries/:boundaryId/management-qa", requireAuth, requireOrg, async (req, res) => {
    const boundaryId = Number(req.params.boundaryId);
    if (!Number.isInteger(boundaryId) || boundaryId <= 0) return res.status(400).json({ message: "Invalid reporting boundary id" });
    const managementQaRecords = await storage.listManagementQaRecords(req.organizationId!, boundaryId);
    return res.json({ managementQaRecords });
  });

  app.post("/api/reporting-boundaries/:boundaryId/management-qa", requireAuth, requireOrg, async (req, res) => {
    const boundaryId = Number(req.params.boundaryId);
    if (!Number.isInteger(boundaryId) || boundaryId <= 0) return res.status(400).json({ message: "Invalid reporting boundary id" });
    try {
      const data = parseBody(managementQaCreateSchema, req.body);

      const boundaries = await storage.listReportingBoundaries(req.organizationId!);
      const boundary = boundaries.find((b) => b.id === boundaryId);
      if (!boundary) return res.status(404).json({ message: "Reporting boundary not found" });

      const managementQaRecord = await storage.createManagementQaRecord({
        ...data,
        lastReviewDate: data.lastReviewDate ? new Date(data.lastReviewDate) : undefined,
        organizationId: req.organizationId!,
        reportingBoundaryId: boundaryId,
      });
      return res.status(201).json({ managementQaRecord });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid management QA payload" });
    }
  });

  app.put("/api/management-qa/:id", requireAuth, requireOrg, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid management QA record id" });
    try {
      const data = parseBody(managementQaUpdateSchema, req.body);
      const managementQaRecord = await storage.updateManagementQaRecord(req.organizationId!, id, {
        ...data,
        lastReviewDate: data.lastReviewDate ? new Date(data.lastReviewDate) : undefined,
      });
      if (!managementQaRecord) return res.status(404).json({ message: "Management QA record not found" });
      return res.json({ managementQaRecord });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid management QA payload" });
    }
  });

  app.delete("/api/management-qa/:id", requireAuth, requireOrg, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid management QA record id" });
    const deleted = await storage.deleteManagementQaRecord(req.organizationId!, id);
    if (!deleted) return res.status(404).json({ message: "Management QA record not found" });
    return res.status(204).end();
  });

  // --- Mitigation measures (per facility) ---
  app.get("/api/facilities/:facilityId/mitigation-measures", requireAuth, requireOrg, async (req, res) => {
    const facilityId = Number(req.params.facilityId);
    if (!Number.isInteger(facilityId) || facilityId <= 0) return res.status(400).json({ message: "Invalid facility id" });
    const measures = await storage.listMitigationMeasures(req.organizationId!, facilityId);
    return res.json({ measures });
  });

  app.post("/api/facilities/:facilityId/mitigation-measures", requireAuth, requireOrg, async (req, res) => {
    const facilityId = Number(req.params.facilityId);
    if (!Number.isInteger(facilityId) || facilityId <= 0) return res.status(400).json({ message: "Invalid facility id" });
    try {
      const data = parseBody(mitigationMeasureCreateSchema, req.body);
      const facility = await storage.getFacility(req.organizationId!, facilityId);
      if (!facility) return res.status(404).json({ message: "Facility not found" });

      const measure = await storage.createMitigationMeasure({
        ...data,
        status: data.status ?? "planned",
        estimatedReductionTco2e: toNumericField(data.estimatedReductionTco2e),
        targetDate: data.targetDate ? new Date(data.targetDate) : undefined,
        organizationId: req.organizationId!,
        facilityId,
      });
      return res.status(201).json({ measure });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid mitigation measure payload" });
    }
  });

  app.put("/api/mitigation-measures/:id", requireAuth, requireOrg, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid mitigation measure id" });
    try {
      const data = parseBody(mitigationMeasureUpdateSchema, req.body);
      const measure = await storage.updateMitigationMeasure(req.organizationId!, id, {
        ...data,
        estimatedReductionTco2e: toNumericField(data.estimatedReductionTco2e),
        targetDate: data.targetDate ? new Date(data.targetDate) : undefined,
      });
      if (!measure) return res.status(404).json({ message: "Mitigation measure not found" });
      return res.json({ measure });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid mitigation measure payload" });
    }
  });

  app.delete("/api/mitigation-measures/:id", requireAuth, requireOrg, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid mitigation measure id" });
    const deleted = await storage.deleteMitigationMeasure(req.organizationId!, id);
    if (!deleted) return res.status(404).json({ message: "Mitigation measure not found" });
    return res.status(204).end();
  });

  // --- Reference data (global, not tenant-scoped -- requireAuth only, no
  // requireOrg, matching shared/schema.ts's note that these tables are
  // seeded once and read by all tenants rather than owned by one) ---
  app.get("/api/reference/primary-activity-types", requireAuth, async (_req, res) => {
    const primaryActivityTypes = await storage.listPrimaryActivityTypes();
    return res.json({ primaryActivityTypes });
  });

  app.get("/api/reference/product-benchmarks", requireAuth, async (_req, res) => {
    const productBenchmarks = await storage.listProductBenchmarks();
    return res.json({ productBenchmarks });
  });

  app.get("/api/reference/isic-divisions", requireAuth, async (_req, res) => {
    const isicDivisions = await storage.listIsicDivisions();
    return res.json({ isicDivisions });
  });

  // Global IPCC default emission factors -- the fallback tier of the
  // emission-factor sourcing hierarchy. Not tenant-scoped, reference-data
  // only, same requireAuth-without-requireOrg pattern as isic-divisions
  // above. Deliberately returns an empty array today -- see
  // scripts/manual-migration-005.mjs and shared/schema.ts (ipccDefaultFactors)
  // for why this table has zero seeded rows.
  app.get("/api/reference/ipcc-default-factors", requireAuth, async (_req, res) => {
    const ipccDefaultFactors = await storage.listIpccDefaultFactors();
    return res.json({ ipccDefaultFactors });
  });

  // AR6 GWP-100 reference values (shared/schema.ts gwpValues) -- the
  // distinct, disclosed GWP-application step ISO/TS 14064-4 requires
  // alongside per-gas IPCC default factors. Same read-only, requireAuth-only
  // pattern as the other /api/reference/* routes above.
  app.get("/api/reference/gwp-values", requireAuth, async (_req, res) => {
    const gwpValues = await storage.listGwpValues();
    return res.json({ gwpValues });
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
          
          const sourceFactor = emissionFactors[input.activity];
          const factor = sourceFactor?.factor || 0;
          const emission = factor * input.qty;

          results[scope] += emission;

          // Per-gas audit trail (ISO/TS 14064-4: quantity_i * GWP_i per
          // gas, disclosed). Only present when the selected factor came
          // from a multi-gas IPCC bundle (client/src/lib/ipccGasBundle.ts)
          // -- simple single-number factors (org factors, non-combustion
          // categories) have no breakdown to report, same as before.
          const gasBreakdown = sourceFactor?.gasBreakdown?.map((component: GasComponent) => ({
            gas: component.gas,
            quantityOfGas: component.nativeFactor * input.qty,
            gwpValue: component.gwpValue,
            gwpVersion: component.gwpVersion,
            gwpSource: component.gwpSource,
            co2e: component.co2ePerUnit * input.qty,
          }));

          emissions.push({
            scope: scope,
            activity: input.activity,
            unit: input.unit,
            quantity: input.qty,
            factor,
            emission,
            year: input.year,
            product: input.product,
            scope3Category: input.scope3Category || emissionFactors[input.activity]?.category,
            gasBreakdown,
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
            gasBreakdown: e.gasBreakdown ?? null,
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
