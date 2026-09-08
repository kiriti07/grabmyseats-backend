import bcrypt from "bcrypt";
import { Router } from "express";
import type { ApiResponse, AdminUser as SharedAdminUser } from "@grabmyseats/shared";
import { prisma } from "../lib/prisma";
import { issueAdminSessionToken } from "../lib/adminSession";
import {
  ADMIN_SESSION_COOKIE_NAME,
  ADMIN_SESSION_MAX_AGE_SECONDS,
} from "../lib/adminAuthConfig";
import { toSharedAdminUser } from "../lib/serialize";
import { requireAdminAuth } from "../middleware/adminAuth";
import { adminLoginLimiter } from "../middleware/rateLimit";

export const adminAuthRouter = Router();

// Separate login endpoint from customer auth (POST /api/auth/otp/verify):
// username + bcrypt-compared password instead of phone + OTP, and issues
// its own admin_session cookie/JWT (see lib/adminSession.ts) - a customer
// session token is never valid here and vice versa.
adminAuthRouter.post("/login", adminLoginLimiter, async (req, res) => {
  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";

  if (!username || !password) {
    const body: ApiResponse<never> = {
      success: false,
      error: "username and password are required",
    };
    res.status(400).json(body);
    return;
  }

  // Same error message whether the username doesn't exist, the password
  // is wrong, or the account is deactivated - never let a login attempt
  // distinguish "no such account" from "wrong password" or "revoked".
  const invalidCredentials = (): void => {
    const body: ApiResponse<never> = { success: false, error: "Invalid username or password" };
    res.status(401).json(body);
  };

  const admin = await prisma.adminUser.findUnique({ where: { username } });
  if (!admin || !admin.isActive) {
    invalidCredentials();
    return;
  }

  const passwordMatches = await bcrypt.compare(password, admin.passwordHash);
  if (!passwordMatches) {
    invalidCredentials();
    return;
  }

  const token = await issueAdminSessionToken(admin);

  res.cookie(ADMIN_SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: ADMIN_SESSION_MAX_AGE_SECONDS * 1000,
    path: "/",
  });

  const body: ApiResponse<{ admin: SharedAdminUser; token: string }> = {
    success: true,
    data: { admin: toSharedAdminUser(admin), token },
  };
  res.json(body);
});

adminAuthRouter.post("/logout", (_req, res) => {
  res.clearCookie(ADMIN_SESSION_COOKIE_NAME, { path: "/" });
  const body: ApiResponse<{ message: string }> = {
    success: true,
    data: { message: "Logged out" },
  };
  res.json(body);
});

// Lets the admin frontend layout confirm session validity and know the
// caller's role on load (ADMIN vs SUPPORT renders a different dashboard) -
// see /admin's layout, which is entirely separate from the customer app's
// useAuth context.
adminAuthRouter.get("/me", requireAdminAuth, (req, res) => {
  const body: ApiResponse<{ admin: SharedAdminUser }> = {
    success: true,
    data: { admin: toSharedAdminUser(req.adminUser!) },
  };
  res.json(body);
});
