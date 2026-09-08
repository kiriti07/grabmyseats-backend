import "dotenv/config";
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../lib/prisma";
import { issueSessionToken } from "../lib/session";

// End-to-end coverage for GET /api/transactions/:id (the endpoint the new
// check-in/contact-reveal UI is built on) plus the check-in -> contact ->
// confirm-receipt flow it feeds, against the real local Postgres through
// the actual Express app - not mocked.
//
// This whole flow (/pay, /check-in, /confirm-receipt) only exists in
// PAYMENT_MODE=escrow (see requireEscrowMode in middleware/paymentMode.ts) -
// PAYMENT_MODE is read once at module load (lib/config.ts), so a plain
// static `import { app } from "../app"` would pick up whatever mode the
// environment's .env happens to have rather than what this suite actually
// needs. vi.stubEnv + vi.resetModules() + a dynamic import after stubbing
// forces this describe block's own fresh module graph under
// PAYMENT_MODE=escrow, isolated from every other test file - same pattern
// as contactOnlyMode.test.ts's forced contact_only.
describe("transaction detail + check-in flow", () => {
  const LAT = 12.9716;
  const LNG = 77.5946;

  let app: Express;
  let sellerId: string;
  let buyerId: string;
  let sellerToken: string;
  let buyerToken: string;
  let listingId: string;
  let transactionId: string;

  beforeAll(async () => {
    vi.stubEnv("PAYMENT_MODE", "escrow");
    vi.resetModules();
    ({ app } = await import("../app"));

    const suffix = randomUUID();
    const seller = await prisma.user.create({
      data: { phone: `+1555seller${suffix}`.slice(0, 30), name: "Test Seller" },
    });
    const buyer = await prisma.user.create({
      data: { phone: `+1555buyer${suffix}`.slice(0, 30), name: "Test Buyer" },
    });
    sellerId = seller.id;
    buyerId = buyer.id;
    sellerToken = await issueSessionToken(seller);
    buyerToken = await issueSessionToken(buyer);

    // showtime = now, so the check-in window (-30min/+20min) and the
    // contact window (±30min) are both open for the whole test.
    const listing = await prisma.listing.create({
      data: {
        sellerId,
        movieName: "Check-In Test Movie",
        theaterName: "Check-In Test Theater",
        theaterLat: LAT,
        theaterLng: LNG,
        showtime: new Date(),
        bookingId: `CHECKINTEST${suffix}`.slice(0, 20),
        totalSeats: 1,
        availableSeats: 1,
        pricePerSeat: 200,
      },
    });
    listingId = listing.id;

    const reserveRes = await request(app)
      .post(`/api/listings/${listingId}/reserve`)
      .set("Authorization", `Bearer ${buyerToken}`)
      .send({ seats: 1, deliveryMethod: "IN_PERSON" });
    expect(reserveRes.status).toBe(201);
    transactionId = reserveRes.body.data.transaction.id;

    // Manually escrow - standing in for a webhook-confirmed payment,
    // matching the pattern used elsewhere in this suite.
    await prisma.transaction.update({
      where: { id: transactionId },
      data: { status: "ESCROWED", confirmedAt: new Date() },
    });
  });

  afterAll(async () => {
    await prisma.transaction.deleteMany({ where: { listingId } });
    await prisma.listing.delete({ where: { id: listingId } });
    await prisma.user.deleteMany({ where: { id: { in: [sellerId, buyerId] } } });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("GET /:id reports party correctly for each side, with no check-ins yet", async () => {
    const buyerRes = await request(app)
      .get(`/api/transactions/${transactionId}`)
      .set("Authorization", `Bearer ${buyerToken}`);
    expect(buyerRes.status).toBe(200);
    expect(buyerRes.body.data.party).toBe("buyer");
    expect(buyerRes.body.data.transaction.status).toBe("ESCROWED");
    expect(buyerRes.body.data.transaction.buyerCheckInAt).toBeNull();
    expect(buyerRes.body.data.transaction.sellerCheckInAt).toBeNull();
    expect(buyerRes.body.data.listing.movieName).toBe("Check-In Test Movie");

    const sellerRes = await request(app)
      .get(`/api/transactions/${transactionId}`)
      .set("Authorization", `Bearer ${sellerToken}`);
    expect(sellerRes.status).toBe(200);
    expect(sellerRes.body.data.party).toBe("seller");
  });

  it("GET /:id 403s for someone who is neither party", async () => {
    const stranger = await prisma.user.create({
      data: { phone: `+1555stranger${randomUUID()}`.slice(0, 30) },
    });
    const strangerToken = await issueSessionToken(stranger);
    const res = await request(app)
      .get(`/api/transactions/${transactionId}`)
      .set("Authorization", `Bearer ${strangerToken}`);
    expect(res.status).toBe(403);
    await prisma.user.delete({ where: { id: stranger.id } });
  });

  it("both parties can check in near the venue", async () => {
    const buyerCheckIn = await request(app)
      .post(`/api/transactions/${transactionId}/check-in`)
      .set("Authorization", `Bearer ${buyerToken}`)
      .send({ lat: LAT, lng: LNG });
    expect(buyerCheckIn.status).toBe(200);
    expect(buyerCheckIn.body.data.transaction.buyerCheckInAt).not.toBeNull();

    const sellerCheckIn = await request(app)
      .post(`/api/transactions/${transactionId}/check-in`)
      .set("Authorization", `Bearer ${sellerToken}`)
      .send({ lat: LAT, lng: LNG });
    expect(sellerCheckIn.status).toBe(200);
    expect(sellerCheckIn.body.data.transaction.sellerCheckInAt).not.toBeNull();

    const detail = await request(app)
      .get(`/api/transactions/${transactionId}`)
      .set("Authorization", `Bearer ${buyerToken}`);
    expect(detail.body.data.transaction.buyerCheckInAt).not.toBeNull();
    expect(detail.body.data.transaction.sellerCheckInAt).not.toBeNull();
  });

  it("check-in 422s when too far from the venue", async () => {
    const res = await request(app)
      .post(`/api/transactions/${transactionId}/check-in`)
      .set("Authorization", `Bearer ${buyerToken}`)
      .send({ lat: LAT + 1, lng: LNG + 1 }); // ~150km away
    expect(res.status).toBe(422);
  });

  it("GET /:id/contact reveals the other party once both are checked in", async () => {
    const res = await request(app)
      .get(`/api/transactions/${transactionId}/contact`)
      .set("Authorization", `Bearer ${buyerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.contact.phone).toBeTruthy();
  });

  it("buyer can confirm receipt once both check-ins are present", async () => {
    const res = await request(app)
      .post(`/api/transactions/${transactionId}/confirm-receipt`)
      .set("Authorization", `Bearer ${buyerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.transaction.status).toBe("BUYER_CONFIRMED");
  });

  it("seller cannot confirm receipt", async () => {
    const res = await request(app)
      .post(`/api/transactions/${transactionId}/confirm-receipt`)
      .set("Authorization", `Bearer ${sellerToken}`);
    expect(res.status).toBe(403);
  });
});
