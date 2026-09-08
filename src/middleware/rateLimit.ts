import { rateLimit, ipKeyGenerator, MINUTE, HOUR } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import type { ApiResponse } from "@grabmyseats/shared";
import { redis } from "../lib/redis";

function sendCommand(...args: string[]) {
  const [command, ...rest] = args;
  return redis.call(command, rest) as Promise<
    string | number | boolean | (string | number | boolean)[]
  >;
}

// Max 3 OTP requests per phone number per 10 minutes.
export const otpPhoneLimiter = rateLimit({
  windowMs: 10 * MINUTE,
  limit: 3,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({
    sendCommand,
    prefix: "rl:otp-phone:",
  }),
  keyGenerator: (req) => {
    const phone = typeof req.body?.phone === "string" ? req.body.phone.trim() : "";
    return phone || ipKeyGenerator(req.ip ?? "unknown");
  },
  handler: (_req, res) => {
    const body: ApiResponse<never> = {
      success: false,
      error: "Too many OTP requests for this phone number. Please try again in a few minutes.",
    };
    res.status(429).json(body);
  },
});

// Max 10 OTP requests per IP per hour.
export const otpIpLimiter = rateLimit({
  windowMs: HOUR,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({
    sendCommand,
    prefix: "rl:otp-ip:",
  }),
  handler: (_req, res) => {
    const body: ApiResponse<never> = {
      success: false,
      error: "Too many OTP requests from this network. Please try again later.",
    };
    res.status(429).json(body);
  },
});

// Max 5 admin login attempts per username per 15 minutes - a
// password-based login (unlike customer OTP) is directly brute-forceable,
// and this endpoint guards accounts that can suspend users and issue
// refunds.
export const adminLoginLimiter = rateLimit({
  windowMs: 15 * MINUTE,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({
    sendCommand,
    prefix: "rl:admin-login:",
  }),
  keyGenerator: (req) => {
    const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
    return username || ipKeyGenerator(req.ip ?? "unknown");
  },
  handler: (_req, res) => {
    const body: ApiResponse<never> = {
      success: false,
      error: "Too many login attempts. Please try again in a few minutes.",
    };
    res.status(429).json(body);
  },
});
