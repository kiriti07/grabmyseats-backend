import type { User, AdminUser } from "../generated/prisma/client";

declare global {
  namespace Express {
    interface Request {
      user?: User;
      // Set by middleware/adminAuth.ts's attachAdminUser - entirely
      // separate from `user` above (customer auth). A request never has
      // both meaningfully set at once in practice, since customer and
      // admin routes don't overlap, but nothing enforces that at the type
      // level.
      adminUser?: AdminUser;
    }
  }
}

export {};
