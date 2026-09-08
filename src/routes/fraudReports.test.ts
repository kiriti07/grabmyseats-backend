import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../app";
import { prisma } from "../lib/prisma";
import { issueSessionToken } from "../lib/session";
import { issueAdminSessionToken } from "../lib/adminSession";

// End-to-end coverage for POST /api/fraud-reports (reporter-facing) and
// GET /api/admin/fraud-reports, POST /api/admin/users/:id/suspend, POST
// /api/admin/fraud-reports/:id/resolve (admin-facing), against the real
// local Postgres through the actual Express app - not mocked.
describe("fraud reports", () => {
  const LAT = 12.9716;
  const LNG = 77.5946;

  let reporterId: string;
  let reporterToken: string;
  let reportedId: string;
  let reportedPhone: string;
  let adminId: string;
  let adminToken: string;
  let listingId: string;
  let transactionId: string;
  const reportIds: string[] = [];

  beforeAll(async () => {
    const suffix = randomUUID();
    const reporter = await prisma.user.create({
      data: { phone: `+1555fraudrptr${suffix}`.slice(0, 30) },
    });
    const reported = await prisma.user.create({
      data: { phone: `+1555fraudtgt${suffix}`.slice(0, 30) },
    });
    // SUPPORT, not ADMIN: proves the fraud-report queue and suspend/resolve
    // actions are reachable by both roles, not admin-exclusive - see
    // requireRole(['ADMIN', 'SUPPORT']) on these routes in routes/admin.ts.
    const admin = await prisma.adminUser.create({
      data: { username: `fraud-support-${suffix}`, passwordHash: "n/a", role: "SUPPORT" },
    });
    reporterId = reporter.id;
    reporterToken = await issueSessionToken(reporter);
    reportedId = reported.id;
    reportedPhone = reported.phone;
    adminId = admin.id;
    adminToken = await issueAdminSessionToken(admin);

    // A real transaction the reporter (buyer) and reported (seller) are
    // both actually party to, so the relatedTransactionId authorization
    // check has something legitimate to accept.
    const listing = await prisma.listing.create({
      data: {
        sellerId: reportedId,
        movieName: "Fraud Report Test Movie",
        theaterName: "Fraud Report Test Theater",
        theaterLat: LAT,
        theaterLng: LNG,
        showtime: new Date(Date.now() + 24 * 60 * 60 * 1000),
        bookingId: `FRAUDTEST${randomUUID()}`.slice(0, 20),
        totalSeats: 2,
        availableSeats: 1,
        pricePerSeat: 200,
      },
    });
    listingId = listing.id;
    const transaction = await prisma.transaction.create({
      data: { listingId, buyerId: reporterId, seatsCount: 1, amountPaid: 200, status: "RESERVED" },
    });
    transactionId = transaction.id;
  });

  afterAll(async () => {
    await prisma.fraudReport.deleteMany({ where: { id: { in: reportIds } } });
    await prisma.transaction.deleteMany({ where: { listingId } });
    await prisma.listing.delete({ where: { id: listingId } });
    await prisma.user.deleteMany({ where: { id: { in: [reporterId, reportedId] } } });
    await prisma.adminUser.delete({ where: { id: adminId } });
  });

  describe("POST /api/fraud-reports", () => {
    it("requires auth", async () => {
      const res = await request(app)
        .post("/api/fraud-reports")
        .send({ reportedUserId: reportedId, description: "Scammed me" });
      expect(res.status).toBe(401);
    });

    it("400s without a description", async () => {
      const res = await request(app)
        .post("/api/fraud-reports")
        .set("Authorization", `Bearer ${reporterToken}`)
        .field("reportedUserId", reportedId);
      expect(res.status).toBe(400);
    });

    it("400s without either reportedUserId or reportedPhone", async () => {
      const res = await request(app)
        .post("/api/fraud-reports")
        .set("Authorization", `Bearer ${reporterToken}`)
        .field("description", "Scammed me");
      expect(res.status).toBe(400);
    });

    it("400s reporting yourself", async () => {
      const res = await request(app)
        .post("/api/fraud-reports")
        .set("Authorization", `Bearer ${reporterToken}`)
        .field("reportedUserId", reporterId)
        .field("description", "Testing");
      expect(res.status).toBe(400);
    });

    it("404s a reportedUserId that doesn't exist", async () => {
      const res = await request(app)
        .post("/api/fraud-reports")
        .set("Authorization", `Bearer ${reporterToken}`)
        .field("reportedUserId", randomUUID())
        .field("description", "Testing");
      expect(res.status).toBe(404);
    });

    it("403s a relatedTransactionId the reporter isn't a party to", async () => {
      const suffix = randomUUID();
      const stranger = await prisma.user.create({
        data: { phone: `+1555fraudstranger${suffix}`.slice(0, 30) },
      });
      const strangerToken = await issueSessionToken(stranger);

      const res = await request(app)
        .post("/api/fraud-reports")
        .set("Authorization", `Bearer ${strangerToken}`)
        .field("reportedUserId", reportedId)
        .field("relatedTransactionId", transactionId)
        .field("description", "Testing");
      expect(res.status).toBe(403);

      await prisma.user.delete({ where: { id: stranger.id } });
    });

    it("creates a report by reportedUserId, with relatedTransactionId", async () => {
      const res = await request(app)
        .post("/api/fraud-reports")
        .set("Authorization", `Bearer ${reporterToken}`)
        .field("reportedUserId", reportedId)
        .field("relatedTransactionId", transactionId)
        .field("description", "Seller never showed up and won't respond.");
      expect(res.status).toBe(201);
      expect(res.body.data.report.status).toBe("PENDING");
      expect(res.body.data.report.reportedUserId).toBe(reportedId);
      expect(res.body.data.report.relatedTransactionId).toBe(transactionId);
      expect(res.body.data.report.evidenceUrls).toEqual([]);
      reportIds.push(res.body.data.report.id);
    });

    it("creates a report by reportedPhone alone (no id) - the contact-reveal case", async () => {
      const res = await request(app)
        .post("/api/fraud-reports")
        .set("Authorization", `Bearer ${reporterToken}`)
        .field("reportedPhone", reportedPhone)
        .field("description", "Suspicious before I even reserved.");
      expect(res.status).toBe(201);
      expect(res.body.data.report.reportedUserId).toBe(reportedId);
      expect(res.body.data.report.relatedTransactionId).toBeNull();
      reportIds.push(res.body.data.report.id);
    });
  });

  describe("admin fraud-report workflow", () => {
    it("GET /api/admin/fraud-reports requires admin auth - a customer session doesn't count", async () => {
      const res = await request(app)
        .get("/api/admin/fraud-reports")
        .set("Authorization", `Bearer ${reporterToken}`);
      expect(res.status).toBe(401);
    });

    it("GET /api/admin/fraud-reports lists open (PENDING/REVIEWED) reports", async () => {
      const res = await request(app)
        .get("/api/admin/fraud-reports")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const ids = res.body.data.reports.map((r: { id: string }) => r.id);
      expect(ids).toEqual(expect.arrayContaining(reportIds));
    });

    it("POST /users/:id/suspend requires a reason", async () => {
      const res = await request(app)
        .post(`/api/admin/users/${reportedId}/suspend`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({});
      expect(res.status).toBe(400);
    });

    it("POST /fraud-reports/:id/resolve 400s an invalid action", async () => {
      const res = await request(app)
        .post(`/api/admin/fraud-reports/${reportIds[0]}/resolve`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ action: "NOT_A_REAL_ACTION" });
      expect(res.status).toBe(400);
    });

    it("400s suspend without action ACTIONED", async () => {
      const res = await request(app)
        .post(`/api/admin/fraud-reports/${reportIds[0]}/resolve`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ action: "DISMISSED", suspend: true, suspensionReason: "x" });
      expect(res.status).toBe(400);
    });

    it("resolves ACTIONED with suspend: true, suspending the reported user in the same call", async () => {
      const res = await request(app)
        .post(`/api/admin/fraud-reports/${reportIds[0]}/resolve`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ action: "ACTIONED", suspend: true, suspensionReason: "Confirmed no-show fraud" });
      expect(res.status).toBe(200);
      expect(res.body.data.report.status).toBe("ACTIONED");
      expect(res.body.data.report.reviewedAt).not.toBeNull();

      const reportedUser = await prisma.user.findUniqueOrThrow({ where: { id: reportedId } });
      expect(reportedUser.suspendedAt).not.toBeNull();
      expect(reportedUser.suspensionReason).toBe("Confirmed no-show fraud");
    });

    it("409s resolving an already-resolved report again", async () => {
      const res = await request(app)
        .post(`/api/admin/fraud-reports/${reportIds[0]}/resolve`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ action: "DISMISSED" });
      expect(res.status).toBe(409);
    });

    it("dismisses the second report without suspending anyone further", async () => {
      const res = await request(app)
        .post(`/api/admin/fraud-reports/${reportIds[1]}/resolve`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ action: "DISMISSED" });
      expect(res.status).toBe(200);
      expect(res.body.data.report.status).toBe("DISMISSED");
    });

    it("no longer lists resolved reports in the open queue", async () => {
      const res = await request(app)
        .get("/api/admin/fraud-reports")
        .set("Authorization", `Bearer ${adminToken}`);
      const ids = res.body.data.reports.map((r: { id: string }) => r.id);
      expect(ids).not.toEqual(expect.arrayContaining(reportIds));
    });
  });
});
