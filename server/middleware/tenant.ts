import type { Request, Response, NextFunction } from "express";
import { storage } from "../storage";

/**
 * Rejects unauthenticated requests. Must run before requireOrg.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.status(401).json({ message: "Authentication required" });
  }
  next();
}

/**
 * Resolves the organization for this request and attaches it to
 * req.organizationId / req.membership. Enforcement point for tenant
 * isolation: a request is only allowed to proceed if the authenticated
 * user has a membership row for the requested organization.
 *
 * Organization is currently resolved from the user's first (and, for the
 * initial single-org-per-user flow, only) membership. If/when a user can
 * belong to multiple organizations, this should instead read an explicit
 * X-Organization-Id header or a selected-org value in the session, and the
 * membership lookup below already supports checking that specific id --
 * only the "which org" resolution step changes.
 */
export async function requireOrg(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.user as { id: number } | undefined;
    if (!user) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const requestedOrgId = req.header("X-Organization-Id");
    const memberships = await storage.getMembershipsForUser(user.id);

    if (memberships.length === 0) {
      return res.status(403).json({ message: "No organization membership found for this account" });
    }

    const membership = requestedOrgId
      ? memberships.find((m) => m.organizationId === Number(requestedOrgId))
      : memberships[0];

    if (!membership) {
      return res.status(403).json({ message: "Not a member of the requested organization" });
    }

    req.organizationId = membership.organizationId;
    req.membership = membership;
    next();
  } catch (err) {
    next(err);
  }
}
