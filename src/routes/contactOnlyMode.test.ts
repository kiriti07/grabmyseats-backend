import "dotenv/config";
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../lib/prisma";
import { issueSessionToken } from "../lib/session";

// PAYMENT_MODE is read once at module load (see lib/config.ts) - a plain
// static `import { app } from "../app"` would just pick up whatever mode
// another test file already cached escrow as. vi.resetModules() + a
// dynamic import *after* stubbing the env var forces this describe block's
// own fresh evaluation of the whole module graph (app, routes, lib/config,
// and everything they transitively import) under PAYMENT_MODE=
// contact_only - isolated from every other test file's escrow-mode `app`.
describe("PAYMENT_MODE=contact_only", () => {
  const LAT = 12.9716;
  const LNG = 77.5946;

  let app: Express;
  let sellerId: string;
  let sellerToken: string;
  let buyerId: string;
  let buyerToken: string;
  let sellerName: string;
  let sellerPhone: string;
  let listingId: string;
  let transactionId: string;

  beforeAll(async () => {
    vi.stubEnv("PAYMENT_MODE", "contact_only");
    vi.resetModules();
    ({ app } = await import("../app"));

    const suffix = randomUUID();
    const seller = await prisma.user.create({
      data: { phone: `+1555comseller${suffix}`.slice(0, 30), name: "Contact Only Seller" },
    });
    const buyer = await prisma.user.create({
      data: { phone: `+1555combuyer${suffix}`.slice(0, 30), name: "Contact Only Buyer" },
    });
    sellerId = seller.id;
    sellerToken = await issueSessionToken(seller);
    sellerName = seller.name!;
    sellerPhone = seller.phone;
    buyerId = buyer.id;
    buyerToken = await issueSessionToken(buyer);

    // showtime far in the future - proves GET /:id/contact isn't gated by
    // the usual 30-minute showtime window in this mode.
    const listing = await prisma.listing.create({
      data: {
        sellerId,
        movieName: "Contact Only Test Movie",
        theaterName: "Contact Only Test Theater",
        theaterLat: LAT,
        theaterLng: LNG,
        showtime: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        bookingId: `CONTACTONLY${suffix}`.slice(0, 20),
        totalSeats: 3,
        availableSeats: 3,
        pricePerSeat: 300,
      },
    });
    listingId = listing.id;
  });

  afterAll(async () => {
    await prisma.transaction.deleteMany({ where: { listingId } });
    await prisma.listing.delete({ where: { id: listingId } });
    await prisma.user.deleteMany({ where: { id: { in: [sellerId, buyerId] } } });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("GET /api/listings/:id reports paymentMode contact_only", async () => {
    const res = await request(app).get(`/api/listings/${listingId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.listing.paymentMode).toBe("contact_only");
  });

  it("reserve does NOT touch availableSeats/status - it only hands back the seller's contact immediately", async () => {
    const res = await request(app)
      .post(`/api/listings/${listingId}/reserve`)
      .set("Authorization", `Bearer ${buyerToken}`)
      .send({ seats: 1 });

    expect(res.status).toBe(201);
    expect(res.body.data.paymentMode).toBe("contact_only");
    expect(res.body.data.contact).toEqual({
      name: sellerName,
      phone: sellerPhone,
      hasWhatsapp: false,
      ratingSummary: { averageStars: null, totalRatings: 0, recentComments: [] },
    });
    expect(res.body.data.transaction.status).toBe("RESERVED");
    expect(res.body.data.transaction.deliveryMethod).toBe("IN_PERSON");
    expect(res.body.data.transaction.reservationExpiresAt).toBeNull();
    transactionId = res.body.data.transaction.id;

    // The bug this covers: requesting contact info used to permanently
    // decrement availableSeats and flip status, hiding the listing from
    // search even when no sale ever happened. Neither should change here -
    // only POST /:id/mark-sold is allowed to touch them in this mode.
    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listing.availableSeats).toBe(3);
    expect(listing.reservedSeats).toBe(0);
    expect(listing.status).toBe("ACTIVE");

    const search = await request(app).get("/api/listings/search").query({ lat: LAT, lng: LNG });
    expect(search.body.data.listings.some((l: { id: string }) => l.id === listingId)).toBe(true);
  });

  it("a second, concurrent-ish contact request from a different buyer also doesn't touch seats/status", async () => {
    const suffix = randomUUID();
    const secondBuyer = await prisma.user.create({
      data: { phone: `+1555combuyer2${suffix}`.slice(0, 30) },
    });
    const secondBuyerToken = await issueSessionToken(secondBuyer);

    const res = await request(app)
      .post(`/api/listings/${listingId}/reserve`)
      .set("Authorization", `Bearer ${secondBuyerToken}`)
      .send({ seats: 1 });
    expect(res.status).toBe(201);

    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listing.availableSeats).toBe(3);
    expect(listing.status).toBe("ACTIVE");

    await prisma.transaction.deleteMany({ where: { buyerId: secondBuyer.id } });
    await prisma.user.delete({ where: { id: secondBuyer.id } });
  });

  it("GET /:id/contact is available immediately, with no showtime-window gate", async () => {
    const res = await request(app)
      .get(`/api/transactions/${transactionId}/contact`)
      .set("Authorization", `Bearer ${buyerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.contact).toEqual({
      name: sellerName,
      phone: sellerPhone,
      hasWhatsapp: false,
      ratingSummary: { averageStars: null, totalRatings: 0, recentComments: [] },
    });
  });

  it("GET /:id reports paymentMode contact_only on the transaction too", async () => {
    const res = await request(app)
      .get(`/api/transactions/${transactionId}`)
      .set("Authorization", `Bearer ${buyerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.paymentMode).toBe("contact_only");
  });

  it("POST /:id/pay is unreachable", async () => {
    const res = await request(app)
      .post(`/api/transactions/${transactionId}/pay`)
      .set("Authorization", `Bearer ${buyerToken}`);
    expect(res.status).toBe(404);
  });

  it("POST /:id/check-in is unreachable", async () => {
    const res = await request(app)
      .post(`/api/transactions/${transactionId}/check-in`)
      .set("Authorization", `Bearer ${buyerToken}`)
      .send({ lat: LAT, lng: LNG });
    expect(res.status).toBe(404);
  });

  it("POST /:id/confirm-receipt is unreachable", async () => {
    const res = await request(app)
      .post(`/api/transactions/${transactionId}/confirm-receipt`)
      .set("Authorization", `Bearer ${buyerToken}`);
    expect(res.status).toBe(404);
  });

  it("seller can still mark seats sold independently of the reservation - this is the only thing that reduces availableSeats/changes status in this mode", async () => {
    const res = await request(app)
      .post(`/api/listings/${listingId}/mark-sold`)
      .set("Authorization", `Bearer ${sellerToken}`)
      .send({ seats: 1 });
    expect(res.status).toBe(200);
    // Started at 3 (never decremented by either reserve call above) - 1
    // marked sold leaves 2, not (as it would if reserve had wrongly locked
    // a seat first) 1.
    expect(res.body.data.listing.availableSeats).toBe(2);
    expect(res.body.data.listing.status).toBe("PARTIALLY_SOLD");
  });
});
