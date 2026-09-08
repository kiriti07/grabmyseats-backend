import type { NextFunction, Request, Response } from "express";
import type { AdminRole } from "../generated/prisma/client";
import { getAdminSessionFromRequest } from "../lib/adminSession";
import { prisma } from "../lib/prisma";

// Attaches `req.adminUser` when a valid admin session is present (cookie
// or `Authorization: Bearer`) AND the account is still active - unlike
// customer suspension (checked separately in requireAuth), a deactivated
// AdminUser is treated as if it were never authenticated at all, since
// PATCH /api/admin/staff/:id's whole point is immediate revocation.
// Never blocks the request itself - use requireAdminAuth for that.
export async function attachAdminUser(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const session = await getAdminSessionFromRequest(req);
    if (session?.sub) {
      const admin = await prisma.adminUser.findUnique({ where: { id: session.sub } });
      if (admin && admin.isActive) req.adminUser = admin;
    }
  } catch {
    // Malformed/expired token: proceed unauthenticated.
  }
  next();
}

export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.adminUser) {
    res.status(401).json({ success: false, error: "Admin authentication required" });
    return;
  }
  next();
}

// Mount after requireAdminAuth - relies on req.adminUser already being set.
export function requireRole(roles: AdminRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.adminUser || !roles.includes(req.adminUser.role)) {
      res.status(403).json({ success: false, error: "You don't have access to this action" });
      return;
    }
    next();
  };
}
