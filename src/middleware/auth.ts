import type { NextFunction, Request, Response } from "express";
import { getSessionFromRequest } from "../lib/session";
import { prisma } from "../lib/prisma";

// Attaches `req.user` when a valid Auth.js session token is present
// (cookie or `Authorization: Bearer`). Never blocks the request -
// use `requireAuth` on routes that must be authenticated.
export async function attachUser(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const session = await getSessionFromRequest(req);
    if (session?.sub) {
      const user = await prisma.user.findUnique({ where: { id: session.sub } });
      if (user) req.user = user;
    }
  } catch {
    // Malformed/expired token: proceed unauthenticated.
  }
  next();
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.user) {
    res.status(401).json({ success: false, error: "Authentication required" });
    return;
  }
  // Rejected here (not a generic 401) so every authenticated route gets
  // this for free - suspension is set by POST /api/admin/users/:id/suspend
  // or POST /api/admin/fraud-reports/:id/resolve. The equivalent check at
  // login itself (POST /api/auth/otp/verify, which never reaches this
  // middleware) is separate - see that route.
  if (req.user.suspendedAt) {
    res.status(403).json({
      success: false,
      error: req.user.suspensionReason
        ? `Your account has been suspended: ${req.user.suspensionReason}`
        : "Your account has been suspended.",
    });
    return;
  }
  next();
}

// Mount after requireAuth - relies on req.user already being set.
export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.user?.isAdmin) {
    res.status(403).json({ success: false, error: "Admin access required" });
    return;
  }
  next();
}
