import { encode, decode, getToken, type JWT } from "@auth/core/jwt";
import type { Request } from "express";
import {
  ADMIN_SESSION_COOKIE_NAME,
  ADMIN_SESSION_MAX_AGE_SECONDS,
  getAdminAuthSecret,
} from "./adminAuthConfig";
import type { AdminUser, AdminRole } from "../generated/prisma/client";

export interface AdminSessionPayload extends JWT {
  sub: string;
  username: string;
  role: AdminRole;
}

// Same @auth/core JWT encode/decode mechanism as lib/session.ts (the
// customer session), but with its own secret and salt/cookie name - see
// adminAuthConfig.ts for why that separation matters.
export async function issueAdminSessionToken(admin: AdminUser): Promise<string> {
  return encode<AdminSessionPayload>({
    secret: getAdminAuthSecret(),
    salt: ADMIN_SESSION_COOKIE_NAME,
    maxAge: ADMIN_SESSION_MAX_AGE_SECONDS,
    token: { sub: admin.id, username: admin.username, role: admin.role },
  });
}

export async function decodeAdminSessionToken(
  token: string,
): Promise<AdminSessionPayload | null> {
  return decode<AdminSessionPayload>({
    secret: getAdminAuthSecret(),
    salt: ADMIN_SESSION_COOKIE_NAME,
    token,
  });
}

// Reads the admin session token from either the admin_session cookie or an
// `Authorization: Bearer` header - same lookup order as
// getSessionFromRequest (lib/session.ts), just against the admin
// secret/cookie name so a customer bearer token can never decode here.
export async function getAdminSessionFromRequest(
  req: Request,
): Promise<AdminSessionPayload | null> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.append(key, value);
    else if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    }
  }

  const token = await getToken<false>({
    req: { headers },
    secret: getAdminAuthSecret(),
    salt: ADMIN_SESSION_COOKIE_NAME,
    cookieName: ADMIN_SESSION_COOKIE_NAME,
  });

  return token as AdminSessionPayload | null;
}
