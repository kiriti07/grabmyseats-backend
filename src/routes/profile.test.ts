import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../app";
import { prisma } from "../lib/prisma";
import { issueSessionToken } from "../lib/session";

// End-to-end coverage for GET/PATCH /api/users/me/profile, against the
// real local Postgres through the actual Express app - not mocked. Every
// scenario here submits text fields only (no profileImage file attached) -
// that's a deliberate choice, not a coverage gap: it exercises every
// validation/business rule (fullName required, email format + uniqueness,
// dateOfBirth validation, full-replace semantics, phone staying untouched)
// without needing real Cloudinary credentials for the upload branch,
// matching how the email-forward suite avoids the same dependency
// elsewhere in this repo's tests.
describe("GET/PATCH /api/users/me/profile", () => {
  let userId: string;
  let userToken: string;
  let otherUserId: string;

  beforeAll(async () => {
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: { phone: `+1555profile${suffix}`.slice(0, 30) },
    });
    const other = await prisma.user.create({
      data: {
        phone: `+1555profileother${suffix}`.slice(0, 30),
        email: `taken-${suffix}@example.com`,
      },
    });
    userId = user.id;
    userToken = await issueSessionToken(user);
    otherUserId = other.id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  });

  it("GET returns an empty profile with the phone number, before anything is set", async () => {
    const res = await request(app)
      .get("/api/users/me/profile")
      .set("Authorization", `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.user.phone).toBeTruthy();
    expect(res.body.data.user.fullName).toBeNull();
    expect(res.body.data.user.email).toBeNull();
  });

  it("400s without fullName", async () => {
    const res = await request(app)
      .patch("/api/users/me/profile")
      .set("Authorization", `Bearer ${userToken}`)
      .field("email", "test@example.com");
    expect(res.status).toBe(400);
  });

  it("400s an invalid email", async () => {
    const res = await request(app)
      .patch("/api/users/me/profile")
      .set("Authorization", `Bearer ${userToken}`)
      .field("fullName", "Test User")
      .field("email", "not-an-email");
    expect(res.status).toBe(400);
  });

  it("400s an invalid dateOfBirth", async () => {
    const res = await request(app)
      .patch("/api/users/me/profile")
      .set("Authorization", `Bearer ${userToken}`)
      .field("fullName", "Test User")
      .field("dateOfBirth", "not-a-date");
    expect(res.status).toBe(400);
  });

  it("400s a dateOfBirth in the future", async () => {
    const res = await request(app)
      .patch("/api/users/me/profile")
      .set("Authorization", `Bearer ${userToken}`)
      .field("fullName", "Test User")
      .field("dateOfBirth", new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());
    expect(res.status).toBe(400);
  });

  it("409s an email already used by another account", async () => {
    const other = await prisma.user.findUniqueOrThrow({ where: { id: otherUserId } });
    const res = await request(app)
      .patch("/api/users/me/profile")
      .set("Authorization", `Bearer ${userToken}`)
      .field("fullName", "Test User")
      .field("email", other.email!);
    expect(res.status).toBe(409);
  });

  it("updates fullName/email/dateOfBirth/gender/address, and leaves phone untouched", async () => {
    const originalPhone = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).phone;

    const res = await request(app)
      .patch("/api/users/me/profile")
      .set("Authorization", `Bearer ${userToken}`)
      .field("fullName", "Priya Sharma")
      .field("email", `priya-${randomUUID()}@example.com`)
      .field("dateOfBirth", "1995-06-15")
      .field("gender", "Woman")
      .field("address", "123 MG Road, Bengaluru");

    expect(res.status).toBe(200);
    expect(res.body.data.user.fullName).toBe("Priya Sharma");
    expect(res.body.data.user.gender).toBe("Woman");
    expect(res.body.data.user.address).toBe("123 MG Road, Bengaluru");
    expect(res.body.data.user.dateOfBirth).not.toBeNull();
    expect(res.body.data.user.phone).toBe(originalPhone);

    // phone is not accepted as input at all - sending one is simply ignored.
    const attempted = await request(app)
      .patch("/api/users/me/profile")
      .set("Authorization", `Bearer ${userToken}`)
      .field("fullName", "Priya Sharma")
      .field("phone", "+19995550000");
    expect(attempted.status).toBe(200);
    expect(attempted.body.data.user.phone).toBe(originalPhone);
  });

  it("full-replace semantics: omitting an optional field on a later PATCH clears it", async () => {
    await request(app)
      .patch("/api/users/me/profile")
      .set("Authorization", `Bearer ${userToken}`)
      .field("fullName", "Priya Sharma")
      .field("gender", "Woman");

    const res = await request(app)
      .patch("/api/users/me/profile")
      .set("Authorization", `Bearer ${userToken}`)
      .field("fullName", "Priya Sharma");
    expect(res.status).toBe(200);
    expect(res.body.data.user.gender).toBeNull();
  });

  it("requires auth", async () => {
    const res = await request(app).get("/api/users/me/profile");
    expect(res.status).toBe(401);
  });
});
