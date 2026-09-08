import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../app";
import { prisma } from "../lib/prisma";
import { issueSessionToken } from "../lib/session";

// End-to-end coverage for POST/GET/DELETE /api/alerts, against the real
// local Postgres through the actual Express app - not mocked.
describe("alerts routes", () => {
  const LAT = 12.9716;
  const LNG = 77.5946;

  let userId: string;
  let userToken: string;
  let otherUserId: string;
  let otherUserToken: string;
  const alertIds: string[] = [];

  beforeAll(async () => {
    const suffix = randomUUID();
    const user = await prisma.user.create({ data: { phone: `+1555alerts${suffix}`.slice(0, 30) } });
    const other = await prisma.user.create({
      data: { phone: `+1555alertsother${suffix}`.slice(0, 30) },
    });
    userId = user.id;
    userToken = await issueSessionToken(user);
    otherUserId = other.id;
    otherUserToken = await issueSessionToken(other);
  });

  afterAll(async () => {
    await prisma.alertNotification.deleteMany({ where: { alertId: { in: alertIds } } });
    await prisma.ticketAlert.deleteMany({ where: { id: { in: alertIds } } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  });

  describe("POST /api/alerts", () => {
    it("400s without titleQuery", async () => {
      const res = await request(app)
        .post("/api/alerts")
        .set("Authorization", `Bearer ${userToken}`)
        .send({ lat: LAT, lng: LNG });
      expect(res.status).toBe(400);
    });

    it("400s an out-of-range lat", async () => {
      const res = await request(app)
        .post("/api/alerts")
        .set("Authorization", `Bearer ${userToken}`)
        .send({ titleQuery: "Jawan", lat: 999, lng: LNG });
      expect(res.status).toBe(400);
    });

    it("400s an invalid category", async () => {
      const res = await request(app)
        .post("/api/alerts")
        .set("Authorization", `Bearer ${userToken}`)
        .send({ titleQuery: "Jawan", lat: LAT, lng: LNG, category: "NOT_A_CATEGORY" });
      expect(res.status).toBe(400);
    });

    it("creates an alert with defaults (radiusKm 7, category MOVIE) when unspecified", async () => {
      const res = await request(app)
        .post("/api/alerts")
        .set("Authorization", `Bearer ${userToken}`)
        .send({ titleQuery: "Jawan", lat: LAT, lng: LNG });
      expect(res.status).toBe(201);
      expect(res.body.data.alert.radiusKm).toBe(7);
      expect(res.body.data.alert.category).toBe("MOVIE");
      expect(res.body.data.alert.isActive).toBe(true);
      expect(res.body.data.alert.cityId).toBeNull();
      alertIds.push(res.body.data.alert.id);
    });

    it("respects an explicit radiusKm/category/cityId", async () => {
      const res = await request(app)
        .post("/api/alerts")
        .set("Authorization", `Bearer ${userToken}`)
        .send({
          titleQuery: "Coldplay Live",
          cityId: "bengaluru",
          lat: LAT,
          lng: LNG,
          radiusKm: 50,
          category: "EVENT",
        });
      expect(res.status).toBe(201);
      expect(res.body.data.alert.radiusKm).toBe(50);
      expect(res.body.data.alert.category).toBe("EVENT");
      expect(res.body.data.alert.cityId).toBe("bengaluru");
      alertIds.push(res.body.data.alert.id);
    });

    it("requires auth", async () => {
      const res = await request(app).post("/api/alerts").send({ titleQuery: "Jawan", lat: LAT, lng: LNG });
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/alerts/mine", () => {
    it("returns only the caller's own alerts", async () => {
      const res = await request(app)
        .get("/api/alerts/mine")
        .set("Authorization", `Bearer ${userToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.alerts.length).toBeGreaterThanOrEqual(2);

      const otherRes = await request(app)
        .get("/api/alerts/mine")
        .set("Authorization", `Bearer ${otherUserToken}`);
      expect(otherRes.status).toBe(200);
      expect(otherRes.body.data.alerts).toEqual([]);
    });
  });

  describe("DELETE /api/alerts/:id", () => {
    it("403s for someone who doesn't own the alert", async () => {
      const res = await request(app)
        .delete(`/api/alerts/${alertIds[0]}`)
        .set("Authorization", `Bearer ${otherUserToken}`);
      expect(res.status).toBe(403);

      const alert = await prisma.ticketAlert.findUniqueOrThrow({ where: { id: alertIds[0] } });
      expect(alert.isActive).toBe(true);
    });

    it("404s a nonexistent alert", async () => {
      const res = await request(app)
        .delete(`/api/alerts/${randomUUID()}`)
        .set("Authorization", `Bearer ${userToken}`);
      expect(res.status).toBe(404);
    });

    it("soft-cancels (isActive false), not a hard delete", async () => {
      const res = await request(app)
        .delete(`/api/alerts/${alertIds[0]}`)
        .set("Authorization", `Bearer ${userToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.alert.isActive).toBe(false);

      const alert = await prisma.ticketAlert.findUnique({ where: { id: alertIds[0] } });
      expect(alert).not.toBeNull();
      expect(alert!.isActive).toBe(false);
    });
  });
});
