import { Router } from "express";
import type { ApiResponse, User as SharedUser } from "@grabmyseats/shared";
import { prisma } from "../lib/prisma";
import { issueOtp, verifyOtp } from "../lib/otpStore";
import { smsProvider } from "../lib/sms";
import { issueSessionToken } from "../lib/session";
import { SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS } from "../lib/authConfig";
import { toSharedUser } from "../lib/serialize";
import { requireAuth } from "../middleware/auth";
import { otpPhoneLimiter, otpIpLimiter } from "../middleware/rateLimit";

export const authRouter = Router();

const PHONE_RE = /^\+[1-9]\d{7,14}$/;
const CODE_RE = /^\d{6}$/;

authRouter.post("/otp/request", otpPhoneLimiter, otpIpLimiter, async (req, res) => {
  const phone = typeof req.body?.phone === "string" ? req.body.phone.trim() : "";

  if (!PHONE_RE.test(phone)) {
    const body: ApiResponse<never> = {
      success: false,
      error: "phone must be in E.164 format, e.g. +14155551234",
    };
    res.status(400).json(body);
    return;
  }

  const code = await issueOtp(phone);
  await smsProvider.send(phone, `Your GrabMySeats code is ${code}`);

  const body: ApiResponse<{ message: string }> = {
    success: true,
    data: { message: "OTP sent" },
  };
  res.json(body);
});

authRouter.post("/otp/verify", async (req, res) => {
  const phone = typeof req.body?.phone === "string" ? req.body.phone.trim() : "";
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";

  if (!PHONE_RE.test(phone) || !CODE_RE.test(code)) {
    const body: ApiResponse<never> = {
      success: false,
      error: "phone and code are required",
    };
    res.status(400).json(body);
    return;
  }

  // DEV-ONLY escape hatch so local/dev clients can sign in without wiring
  // up real SMS delivery. Gated on NODE_ENV so it can never fire in
  // production even if DEV_OTP_BYPASS_CODE is left set in an env file -
  // see the matching startup check in index.ts, which refuses to boot in
  // production if that var is set at all. This must never be reachable in
  // production under any circumstance.
  const devBypassCode = process.env.DEV_OTP_BYPASS_CODE;
  const isDevBypass =
    process.env.NODE_ENV !== "production" &&
    !!devBypassCode &&
    code === devBypassCode;

  if (isDevBypass) {
    console.log(`[dev] bypass OTP used for ${phone}`);
  } else if (!(await verifyOtp(phone, code))) {
    const body: ApiResponse<never> = {
      success: false,
      error: "Invalid or expired code",
    };
    res.status(401).json(body);
    return;
  }

  // First verified OTP for a phone number signs the user up; subsequent
  // ones log them back in.
  const user = await prisma.user.upsert({
    where: { phone },
    create: { phone },
    update: {},
  });

  // A brand-new upsert can never be suspended, so this only ever fires for
  // an existing suspended user trying to log back in - same clear-message
  // requirement as requireAuth (middleware/auth.ts), which this route
  // never reaches (issuing the session is the whole point of this
  // endpoint, so it has to check for itself).
  if (user.suspendedAt) {
    const body: ApiResponse<never> = {
      success: false,
      error: user.suspensionReason
        ? `Your account has been suspended: ${user.suspensionReason}`
        : "Your account has been suspended.",
    };
    res.status(403).json(body);
    return;
  }

  // Every successful verify, not just first-time signup - see the
  // lastLoginAt comment on the User model. Not folded into the upsert
  // above since a brand-new signup and a returning login should both set
  // it "now", but the upsert's `create`/`update` branches would otherwise
  // need this repeated in both.
  const loggedInUser = await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  const token = await issueSessionToken(loggedInUser);

  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE_SECONDS * 1000,
    path: "/",
  });

  const body: ApiResponse<{ user: SharedUser; token: string }> = {
    success: true,
    data: { user: toSharedUser(loggedInUser), token },
  };
  res.json(body);
});

authRouter.get("/me", requireAuth, (req, res) => {
  const body: ApiResponse<{ user: SharedUser }> = {
    success: true,
    data: { user: toSharedUser(req.user!) },
  };
  res.json(body);
});
