import "dotenv/config";
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../app";
import { prisma } from "../lib/prisma";
import { issueSessionToken } from "../lib/session";

// End-to-end coverage for the WhatsApp-availability flag, against the real
// local Postgres through the actual Express app - not mocked: setting it
// via PATCH /api/users/me/profile, and it surfacing on both contact-reveal
// paths (GET /:id/contact, and the contact-only reserve response).
describe("hasWhatsapp", () => {
  const LAT = 12.9716;
  const LNG = 77.5946;

  let userId: string;
  let userToken: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phone: `+1555wa${randomUUID()}`.slice(0, 30) },
    });
    userId = user.id;
    userToken = await issueSessionToken(user);
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
  });

  describe("PATCH /api/users/me/profile", () => {
    it("defaults to false", async () => {
      const res = await request(app).get("/api/users/me/profile").set("Authorization", `Bearer ${userToken}`);
      expect(res.body.data.user.hasWhatsapp).toBe(false);
    });

    it("sets hasWhatsapp true", async () => {
      const res = await request(app)
        .patch("/api/users/me/profile")
        .set("Authorization", `Bearer ${userToken}`)
        .field("fullName", "WhatsApp Test User")
        .field("hasWhatsapp", "true");
      expect(res.status).toBe(200);
      expect(res.body.data.user.hasWhatsapp).toBe(true);
    });

    it("unsetting it (omitting the field) clears it back to false", async () => {
      const res = await request(app)
        .patch("/api/users/me/profile")
        .set("Authorization", `Bearer ${userToken}`)
        .field("fullName", "WhatsApp Test User");
      expect(res.status).toBe(200);
      expect(res.body.data.user.hasWhatsapp).toBe(false);
    });
  });

  describe("surfaced at contact reveal", () => {
    let sellerId: string;
    let sellerToken: string;
    let buyerId: string;
    let buyerToken: string;
    let listingId: string;
    let transactionId: string;

    beforeAll(async () => {
      const suffix = randomUUID();
      const seller = await prisma.user.create({
        data: {
          phone: `+1555waseller${suffix}`.slice(0, 30),
          name: "WA Seller",
          hasWhatsapp: true,
        },
      });
      const buyer = await prisma.user.create({
        data: { phone: `+1555wabuyer${suffix}`.slice(0, 30) },
      });
      sellerId = seller.id;
      sellerToken = await issueSessionToken(seller);
      buyerId = buyer.id;
      buyerToken = await issueSessionToken(buyer);

      const listing = await prisma.listing.create({
        data: {
          sellerId,
          movieName: "WhatsApp Test Movie",
          theaterName: "WhatsApp Test Theater",
          theaterLat: LAT,
          theaterLng: LNG,
          showtime: new Date(),
          bookingId: `WATEST${suffix}`.slice(0, 20),
          totalSeats: 2,
          availableSeats: 2,
          pricePerSeat: 200,
        },
      });
      listingId = listing.id;
      const transaction = await prisma.transaction.create({
        data: { listingId, buyerId, seatsCount: 1, amountPaid: 200, status: "ESCROWED" },
      });
      transactionId = transaction.id;
    });

    afterAll(async () => {
      await prisma.transaction.deleteMany({ where: { listingId } });
      await prisma.listing.delete({ where: { id: listingId } });
      await prisma.user.deleteMany({ where: { id: { in: [sellerId, buyerId] } } });
    });

    it("GET /:id/contact includes the seller's hasWhatsapp", async () => {
      const res = await request(app)
        .get(`/api/transactions/${transactionId}/contact`)
        .set("Authorization", `Bearer ${buyerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.contact.hasWhatsapp).toBe(true);
    });

    it("GET /:id/contact reflects false for a party without WhatsApp (the buyer, from the seller's side)", async () => {
      const res = await request(app)
        .get(`/api/transactions/${transactionId}/contact`)
        .set("Authorization", `Bearer ${sellerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.contact.hasWhatsapp).toBe(false);
    });
  });

  describe("contact-only reserve response", () => {
    let app: Express;
    let sellerId: string;
    let buyerToken: string;
    let listingId: string;

    beforeAll(async () => {
      vi.stubEnv("PAYMENT_MODE", "contact_only");
      vi.resetModules();
      ({ app } = await import("../app"));

      const suffix = randomUUID();
      const seller = await prisma.user.create({
        data: { phone: `+1555wacoseller${suffix}`.slice(0, 30), hasWhatsapp: true },
      });
      const buyer = await prisma.user.create({
        data: { phone: `+1555wacobuyer${suffix}`.slice(0, 30) },
      });
      sellerId = seller.id;
      buyerToken = await issueSessionToken(buyer);

      const listing = await prisma.listing.create({
        data: {
          sellerId,
          movieName: "WhatsApp Contact Only Movie",
          theaterName: "WhatsApp Contact Only Theater",
          theaterLat: LAT,
          theaterLng: LNG,
          showtime: new Date(Date.now() + 24 * 60 * 60 * 1000),
          bookingId: `WACOTEST${suffix}`.slice(0, 20),
          totalSeats: 2,
          availableSeats: 2,
          pricePerSeat: 200,
        },
      });
      listingId = listing.id;
    });

    afterAll(async () => {
      await prisma.transaction.deleteMany({ where: { listingId } });
      await prisma.listing.delete({ where: { id: listingId } });
      await prisma.user.deleteMany({ where: { id: sellerId } });
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it("includes hasWhatsapp on the immediately-returned contact", async () => {
      const res = await request(app)
        .post(`/api/listings/${listingId}/reserve`)
        .set("Authorization", `Bearer ${buyerToken}`)
        .send({ seats: 1 });
      expect(res.status).toBe(201);
      expect(res.body.data.contact.hasWhatsapp).toBe(true);
    });
  });
});
