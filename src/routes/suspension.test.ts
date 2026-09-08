import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../app";
import { prisma } from "../lib/prisma";
import { issueSessionToken } from "../lib/session";
import { issueOtp } from "../lib/otpStore";

// End-to-end coverage for suspension enforcement, against the real local
// Postgres through the actual Express app - not mocked: requireAuth
// rejecting a suspended user's session on any authenticated action, login
// itself refusing a suspended user, and a suspended seller's listing being
// invisible to search/detail/reserve and their contact being hidden.
describe("suspension", () => {
  const LAT = 12.9716;
  const LNG = 77.5946;

  let sellerId: string;
  let sellerToken: string;
  let sellerPhone: string;
  let buyerId: string;
  let buyerToken: string;
  let listingId: string;
  let transactionId: string;

  beforeAll(async () => {
    const suffix = randomUUID();
    // The seller's phone has to satisfy POST /api/auth/otp/verify's own
    // PHONE_RE (digits only) for the login-rejection test below to reach
    // the suspension check at all, rather than 400ing on format first -
    // unlike every other test's UUID-suffixed phone (fine everywhere else,
    // since nothing else here calls the real OTP endpoint with it).
    const seller = await prisma.user.create({
      data: {
        phone: `+1${Math.floor(1_000_000_000 + Math.random() * 9_000_000_000)}`,
        name: "Suspended Seller",
      },
    });
    const buyer = await prisma.user.create({
      data: { phone: `+1555suspbuyer${suffix}`.slice(0, 30) },
    });
    sellerId = seller.id;
    sellerToken = await issueSessionToken(seller);
    sellerPhone = seller.phone;
    buyerId = buyer.id;
    buyerToken = await issueSessionToken(buyer);

    const listing = await prisma.listing.create({
      data: {
        sellerId,
        movieName: "Suspension Test Movie",
        theaterName: "Suspension Test Theater",
        theaterLat: LAT,
        theaterLng: LNG,
        showtime: new Date(),
        bookingId: `SUSPTEST${randomUUID()}`.slice(0, 20),
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

  it("listing is visible/reservable and contact works before suspension", async () => {
    const search = await request(app).get("/api/listings/search").query({ lat: LAT, lng: LNG });
    expect(search.body.data.listings.some((l: { id: string }) => l.id === listingId)).toBe(true);

    const detail = await request(app).get(`/api/listings/${listingId}`);
    expect(detail.status).toBe(200);

    const contact = await request(app)
      .get(`/api/transactions/${transactionId}/contact`)
      .set("Authorization", `Bearer ${buyerToken}`);
    expect(contact.status).toBe(200);
  });

  it("suspends the seller", async () => {
    const updated = await prisma.user.update({
      where: { id: sellerId },
      data: { suspendedAt: new Date(), suspensionReason: "Fraud confirmed" },
    });
    expect(updated.suspendedAt).not.toBeNull();
  });

  it("requireAuth rejects the suspended seller's session with a clear message, not a generic 401", async () => {
    const res = await request(app)
      .get("/api/listings/mine")
      .set("Authorization", `Bearer ${sellerToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("suspended");
    expect(res.body.error).toContain("Fraud confirmed");
  });

  it("login (OTP verify) refuses a suspended user", async () => {
    const code = await issueOtp(sellerPhone);
    const res = await request(app).post("/api/auth/otp/verify").send({ phone: sellerPhone, code });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("suspended");
  });

  it("the suspended seller's listing no longer appears in search", async () => {
    const res = await request(app).get("/api/listings/search").query({ lat: LAT, lng: LNG });
    expect(res.body.data.listings.some((l: { id: string }) => l.id === listingId)).toBe(false);
  });

  it("the suspended seller's listing detail page 404s like it doesn't exist", async () => {
    const res = await request(app).get(`/api/listings/${listingId}`);
    expect(res.status).toBe(404);
  });

  it("reserving the suspended seller's listing 404s", async () => {
    const res = await request(app)
      .post(`/api/listings/${listingId}/reserve`)
      .set("Authorization", `Bearer ${buyerToken}`)
      .send({ seats: 1, deliveryMethod: "IN_PERSON" });
    expect(res.status).toBe(404);

    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listing.availableSeats).toBe(2); // unchanged - the seat-lock rolled back
  });

  it("the suspended seller's contact is hidden on a pre-existing transaction", async () => {
    const res = await request(app)
      .get(`/api/transactions/${transactionId}/contact`)
      .set("Authorization", `Bearer ${buyerToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/no longer active/i);
  });
});
