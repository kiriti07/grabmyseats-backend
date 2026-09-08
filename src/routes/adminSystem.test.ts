import "dotenv/config";
import bcrypt from "bcrypt";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../app";
import { prisma } from "../lib/prisma";
import { issueAdminSessionToken } from "../lib/adminSession";
import { issueSessionToken } from "../lib/session";

// End-to-end coverage for the internal admin/support system, against the
// real local Postgres through the actual Express app - not mocked:
//   - POST /api/admin/auth/login (bcrypt compare, isActive gate, its own
//     admin_session cookie/JWT distinct from customer auth)
//   - requireAdminAuth / requireRole role-gating
//   - POST/GET/PATCH /api/admin/staff (ADMIN only)
//   - GET /api/admin/users (phone lookup) and POST .../suspend + unsuspend
//     (ADMIN and SUPPORT)
//   - GET /api/admin/metrics (ADMIN only)
describe("admin system", () => {
  const adminUserIds: string[] = [];

  afterAll(async () => {
    await prisma.adminUser.deleteMany({ where: { id: { in: adminUserIds } } });
  });

  describe("POST /api/admin/auth/login", () => {
    let username: string;
    const password = "correct-horse-battery-staple";
    let adminId: string;

    beforeAll(async () => {
      username = `login-test-${randomUUID()}`;
      const passwordHash = await bcrypt.hash(password, 10);
      const admin = await prisma.adminUser.create({
        data: { username, passwordHash, role: "ADMIN" },
      });
      adminId = admin.id;
      adminUserIds.push(adminId);
    });

    it("400s a missing username or password", async () => {
      const res = await request(app).post("/api/admin/auth/login").send({ username });
      expect(res.status).toBe(400);
    });

    it("401s a wrong password", async () => {
      const res = await request(app)
        .post("/api/admin/auth/login")
        .send({ username, password: "wrong-password" });
      expect(res.status).toBe(401);
    });

    it("401s an unknown username", async () => {
      const res = await request(app)
        .post("/api/admin/auth/login")
        .send({ username: `no-such-user-${randomUUID()}`, password });
      expect(res.status).toBe(401);
    });

    it("logs in with the right credentials, sets admin_session, and returns a token + admin", async () => {
      const res = await request(app).post("/api/admin/auth/login").send({ username, password });
      expect(res.status).toBe(200);
      expect(res.body.data.admin.username).toBe(username);
      expect(res.body.data.admin).not.toHaveProperty("passwordHash");
      expect(typeof res.body.data.token).toBe("string");
      const setCookie = res.headers["set-cookie"];
      expect(setCookie?.some((c: string) => c.startsWith("admin_session="))).toBe(true);
    });

    it("GET /api/admin/auth/me returns the authenticated admin", async () => {
      const login = await request(app).post("/api/admin/auth/login").send({ username, password });
      const token = login.body.data.token;

      const res = await request(app)
        .get("/api/admin/auth/me")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.admin.id).toBe(adminId);
    });

    it("401s login for a deactivated account", async () => {
      await prisma.adminUser.update({ where: { id: adminId }, data: { isActive: false } });
      const res = await request(app).post("/api/admin/auth/login").send({ username, password });
      expect(res.status).toBe(401);
      await prisma.adminUser.update({ where: { id: adminId }, data: { isActive: true } });
    });

    it("a customer session token doesn't authenticate any admin route", async () => {
      const customer = await prisma.user.create({
        data: { phone: `+1555admsyscust${randomUUID()}`.slice(0, 30) },
      });
      const customerToken = await issueSessionToken(customer);

      const res = await request(app)
        .get("/api/admin/auth/me")
        .set("Authorization", `Bearer ${customerToken}`);
      expect(res.status).toBe(401);

      await prisma.user.delete({ where: { id: customer.id } });
    });
  });

  describe("POST /api/admin/auth/logout", () => {
    it("clears the admin_session cookie", async () => {
      const res = await request(app).post("/api/admin/auth/logout");
      expect(res.status).toBe(200);
      const setCookie = res.headers["set-cookie"];
      expect(setCookie?.some((c: string) => c.startsWith("admin_session=;"))).toBe(true);
    });
  });

  describe("staff management (ADMIN only)", () => {
    let adminToken: string;
    let supportToken: string;

    beforeAll(async () => {
      const admin = await prisma.adminUser.create({
        data: { username: `staff-admin-${randomUUID()}`, passwordHash: "n/a", role: "ADMIN" },
      });
      const support = await prisma.adminUser.create({
        data: { username: `staff-support-${randomUUID()}`, passwordHash: "n/a", role: "SUPPORT" },
      });
      adminUserIds.push(admin.id, support.id);
      adminToken = await issueAdminSessionToken(admin);
      supportToken = await issueAdminSessionToken(support);
    });

    it("POST /api/admin/staff requires ADMIN - SUPPORT is forbidden", async () => {
      const res = await request(app)
        .post("/api/admin/staff")
        .set("Authorization", `Bearer ${supportToken}`)
        .send({ username: `should-not-be-created-${randomUUID()}`, role: "SUPPORT" });
      expect(res.status).toBe(403);
    });

    it("400s an invalid role", async () => {
      const res = await request(app)
        .post("/api/admin/staff")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ username: `invalid-role-${randomUUID()}`, role: "SUPERUSER" });
      expect(res.status).toBe(400);
    });

    it("creates a SUPPORT account with a generated temporary password", async () => {
      const username = `new-support-${randomUUID()}`;
      const res = await request(app)
        .post("/api/admin/staff")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ username, role: "SUPPORT" });
      expect(res.status).toBe(201);
      expect(res.body.data.staff.username).toBe(username);
      expect(res.body.data.staff.role).toBe("SUPPORT");
      expect(res.body.data.staff.isActive).toBe(true);
      expect(typeof res.body.data.temporaryPassword).toBe("string");
      expect(res.body.data.temporaryPassword.length).toBeGreaterThanOrEqual(12);
      adminUserIds.push(res.body.data.staff.id);

      // The generated temp password actually logs in.
      const login = await request(app)
        .post("/api/admin/auth/login")
        .send({ username, password: res.body.data.temporaryPassword });
      expect(login.status).toBe(200);
    });

    it("409s creating a duplicate username", async () => {
      const username = `dup-${randomUUID()}`;
      const first = await request(app)
        .post("/api/admin/staff")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ username, role: "SUPPORT" });
      adminUserIds.push(first.body.data.staff.id);

      const second = await request(app)
        .post("/api/admin/staff")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ username, role: "SUPPORT" });
      expect(second.status).toBe(409);
    });

    it("GET /api/admin/staff lists staff, ADMIN only", async () => {
      const forbidden = await request(app)
        .get("/api/admin/staff")
        .set("Authorization", `Bearer ${supportToken}`);
      expect(forbidden.status).toBe(403);

      const res = await request(app)
        .get("/api/admin/staff")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.staff)).toBe(true);
      expect(res.body.data.staff.length).toBeGreaterThan(0);
    });

    it("PATCH /api/admin/staff/:id toggles isActive to revoke access", async () => {
      const created = await request(app)
        .post("/api/admin/staff")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ username: `revoke-me-${randomUUID()}`, role: "SUPPORT" });
      const staffId = created.body.data.staff.id;
      adminUserIds.push(staffId);
      const revokedToken = await issueAdminSessionToken(
        await prisma.adminUser.findUniqueOrThrow({ where: { id: staffId } }),
      );

      const patch = await request(app)
        .patch(`/api/admin/staff/${staffId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ isActive: false });
      expect(patch.status).toBe(200);
      expect(patch.body.data.staff.isActive).toBe(false);

      // Deactivation takes effect immediately, not just at next login -
      // attachAdminUser re-checks isActive on every request.
      const res = await request(app)
        .get("/api/admin/auth/me")
        .set("Authorization", `Bearer ${revokedToken}`);
      expect(res.status).toBe(401);
    });
  });

  describe("shared ADMIN/SUPPORT actions: user lookup, suspend, unsuspend", () => {
    let supportToken: string;
    let userId: string;
    let userPhone: string;

    beforeAll(async () => {
      const support = await prisma.adminUser.create({
        data: { username: `lookup-support-${randomUUID()}`, passwordHash: "n/a", role: "SUPPORT" },
      });
      adminUserIds.push(support.id);
      supportToken = await issueAdminSessionToken(support);

      const user = await prisma.user.create({
        data: { phone: `+1555admsyslookup${randomUUID()}`.slice(0, 30), name: "Lookup Target" },
      });
      userId = user.id;
      userPhone = user.phone;
    });

    afterAll(async () => {
      await prisma.user.delete({ where: { id: userId } });
    });

    it("GET /api/admin/users?phone=... finds the user (SUPPORT can reach it)", async () => {
      const res = await request(app)
        .get("/api/admin/users")
        .query({ phone: userPhone })
        .set("Authorization", `Bearer ${supportToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.user.id).toBe(userId);
      expect(res.body.data.user.suspendedAt).toBeNull();
    });

    it("returns null for a phone that doesn't match anyone", async () => {
      const res = await request(app)
        .get("/api/admin/users")
        .query({ phone: "+19999999999" })
        .set("Authorization", `Bearer ${supportToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.user).toBeNull();
    });

    it("SUPPORT can suspend and unsuspend", async () => {
      const suspend = await request(app)
        .post(`/api/admin/users/${userId}/suspend`)
        .set("Authorization", `Bearer ${supportToken}`)
        .send({ reason: "Testing suspend as SUPPORT" });
      expect(suspend.status).toBe(200);
      expect(suspend.body.data.user.suspendedAt).not.toBeNull();
      expect(suspend.body.data.user.suspensionReason).toBe("Testing suspend as SUPPORT");

      const unsuspend = await request(app)
        .post(`/api/admin/users/${userId}/unsuspend`)
        .set("Authorization", `Bearer ${supportToken}`);
      expect(unsuspend.status).toBe(200);
      expect(unsuspend.body.data.user.suspendedAt).toBeNull();
      expect(unsuspend.body.data.user.suspensionReason).toBeNull();
    });

    it("409s unsuspending a user who isn't suspended", async () => {
      const res = await request(app)
        .post(`/api/admin/users/${userId}/unsuspend`)
        .set("Authorization", `Bearer ${supportToken}`);
      expect(res.status).toBe(409);
    });
  });

  describe("GET /api/admin/metrics (ADMIN only)", () => {
    let adminToken: string;
    let supportToken: string;

    beforeAll(async () => {
      const admin = await prisma.adminUser.create({
        data: { username: `metrics-admin-${randomUUID()}`, passwordHash: "n/a", role: "ADMIN" },
      });
      const support = await prisma.adminUser.create({
        data: {
          username: `metrics-support-${randomUUID()}`,
          passwordHash: "n/a",
          role: "SUPPORT",
        },
      });
      adminUserIds.push(admin.id, support.id);
      adminToken = await issueAdminSessionToken(admin);
      supportToken = await issueAdminSessionToken(support);
    });

    it("403s for SUPPORT", async () => {
      const res = await request(app)
        .get("/api/admin/metrics")
        .set("Authorization", `Bearer ${supportToken}`);
      expect(res.status).toBe(403);
    });

    it("returns all the expected metric fields for ADMIN", async () => {
      const res = await request(app)
        .get("/api/admin/metrics")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const metrics = res.body.data;
      for (const field of [
        "activeUsers30d",
        "activeListings",
        "closedListings",
        "pendingFraudReports",
        "pendingReviewFlags",
        "supportStaffCount",
      ]) {
        expect(typeof metrics[field]).toBe("number");
      }
      // At least the two SUPPORT accounts created across this describe
      // block are still active, so this is never 0 while they exist.
      expect(metrics.supportStaffCount).toBeGreaterThan(0);
    });
  });
});
