import type { Request, Response, NextFunction } from "express";

/**
 * Rejects requests from non-super-admin users. Must run after requireAuth
 * (reads req.user). Deliberately never paired with requireOrg -- a
 * super-admin isn't scoped to any one tenant, matching the requireAuth-only
 * pattern already used by the reference-data routes in server/routes.ts
 * (~line 2055 onward).
 */
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user?.isSuperAdmin) {
    return res.status(403).json({ message: "Super-admin access required" });
  }
  next();
}
