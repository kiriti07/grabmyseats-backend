import bcrypt from "bcrypt";
import { Router } from "express";
import type {
  ApiResponse,
  AdminRole,
  AdminUser as SharedAdminUser,
  CreateStaffResult,
} from "@grabmyseats/shared";
import { prisma } from "../lib/prisma";
import { toSharedAdminUser } from "../lib/serialize";
import { requireAdminAuth, requireRole } from "../middleware/adminAuth";
import { generateTempPassword } from "../lib/generateTempPassword";

export const adminStaffRouter = Router();

const BCRYPT_ROUNDS = 12;
const ADMIN_ROLES: AdminRole[] = ["ADMIN", "SUPPORT"];

class StaffNotFoundError extends Error {}

// Creates a new AdminUser with a generated temporary password, handed back
// once in the response for the creating ADMIN to relay securely (Slack DM,
// in person) - this is the only public-facing way any AdminUser ever gets
// created besides the one-off backend/scripts/seedAdmin.ts. No "set your
// own password" flow exists yet, so the temp password IS the login
// password until someone builds one - out of scope for this pass.
adminStaffRouter.post(
  "/staff",
  requireAdminAuth,
  requireRole(["ADMIN"]),
  async (req, res) => {
    const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
    const role = req.body?.role;

    const errors: string[] = [];
    if (!username) errors.push("username is required");
    if (!ADMIN_ROLES.includes(role)) errors.push(`role must be one of ${ADMIN_ROLES.join(", ")}`);
    if (errors.length > 0) {
      const body: ApiResponse<never> = { success: false, error: errors.join("; ") };
      res.status(400).json(body);
      return;
    }

    try {
      const temporaryPassword = generateTempPassword();
      const passwordHash = await bcrypt.hash(temporaryPassword, BCRYPT_ROUNDS);

      const staff = await prisma.adminUser.create({
        data: {
          username,
          passwordHash,
          role: role as AdminRole,
          createdByAdminId: req.adminUser!.id,
        },
      });

      const body: ApiResponse<CreateStaffResult> = {
        success: true,
        data: { staff: toSharedAdminUser(staff), temporaryPassword },
      };
      res.status(201).json(body);
    } catch (err) {
      // Unique constraint violation on username (Prisma error code P2002) -
      // checked structurally rather than importing
      // PrismaClientKnownRequestError, same pattern as PATCH
      // /api/users/me/profile's email-uniqueness check. Fires when
      // `username` collides with an existing AdminUser, including a
      // deactivated one - usernames are never freed up on deactivation.
      if (err && typeof err === "object" && "code" in err && err.code === "P2002") {
        const body: ApiResponse<never> = { success: false, error: "Username is already taken" };
        res.status(409).json(body);
        return;
      }
      throw err;
    }
  },
);

adminStaffRouter.get("/staff", requireAdminAuth, requireRole(["ADMIN"]), async (_req, res) => {
  const staff = await prisma.adminUser.findMany({ orderBy: { createdAt: "asc" } });

  const body: ApiResponse<{ staff: SharedAdminUser[] }> = {
    success: true,
    data: { staff: staff.map(toSharedAdminUser) },
  };
  res.json(body);
});

// Toggles isActive - the only way access is revoked. No delete route:
// same audit-preserving pattern as suspending a User rather than deleting
// it (createdByAdminId, and anything else logged by admin id elsewhere,
// stays attributable to a real row).
adminStaffRouter.patch(
  "/staff/:id",
  requireAdminAuth,
  requireRole(["ADMIN"]),
  async (req, res) => {
    const staffId = req.params.id as string;
    const isActive = req.body?.isActive;

    if (typeof isActive !== "boolean") {
      const body: ApiResponse<never> = { success: false, error: "isActive must be a boolean" };
      res.status(400).json(body);
      return;
    }

    try {
      const existing = await prisma.adminUser.findUnique({ where: { id: staffId } });
      if (!existing) throw new StaffNotFoundError();

      const updated = await prisma.adminUser.update({
        where: { id: staffId },
        data: { isActive },
      });

      const body: ApiResponse<{ staff: SharedAdminUser }> = {
        success: true,
        data: { staff: toSharedAdminUser(updated) },
      };
      res.json(body);
    } catch (err) {
      if (err instanceof StaffNotFoundError) {
        const body: ApiResponse<never> = { success: false, error: "Staff account not found" };
        res.status(404).json(body);
        return;
      }
      throw err;
    }
  },
);
