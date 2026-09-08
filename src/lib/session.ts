import { encode, decode, getToken, type JWT } from "@auth/core/jwt";
import type { Request } from "express";
import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  getAuthSecret,
} from "./authConfig";
import type { User } from "../generated/prisma/client";

export interface SessionPayload extends JWT {
  sub: string;
  phone: string;
  name: string | null;
}

export async function issueSessionToken(user: User): Promise<string> {
  return encode<SessionPayload>({
    secret: getAuthSecret(),
    salt: SESSION_COOKIE_NAME,
    maxAge: SESSION_MAX_AGE_SECONDS,
    token: { sub: user.id, phone: user.phone, name: user.name },
  });
}

export async function decodeSessionToken(
  token: string,
): Promise<SessionPayload | null> {
  const payload = await decode<SessionPayload>({
    secret: getAuthSecret(),
    salt: SESSION_COOKIE_NAME,
    token,
  });
  return payload;
}

// Reads the session token from either the Auth.js cookie or an
// `Authorization: Bearer` header, matching Auth.js's own lookup order.
export async function getSessionFromRequest(
  req: Request,
): Promise<SessionPayload | null> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.append(key, value);
    else if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    }
  }

  const token = await getToken<false>({
    req: { headers },
    secret: getAuthSecret(),
    salt: SESSION_COOKIE_NAME,
    cookieName: SESSION_COOKIE_NAME,
  });

  return token as SessionPayload | null;
}
