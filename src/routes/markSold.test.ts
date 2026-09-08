import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../app";
import { prisma } from "../lib/prisma";
import { issueSessionToken } from "../lib/session";

// POST /api/listings/:id/mark-sold - not gated to any PAYMENT_MODE (see
// deliveryMethod.test.ts's neighbor contactOnlyMode.test.ts for the mode
// itself), so this runs against the default escrow-mode app like the rest
// of this suite. Covers: ownership, the atomic consume-vs-oversell guard,
// and that it recomputes status the same way reserve does, without ever
// touching reservedSeats.
describe("POST /api/listings/:id/mark-sold", () => {
  const LAT = 12.9716;
  const LNG = 77.5946;

  let sellerId: string;
  let sellerToken: string;
  let otherUserId: string;
  let otherUserToken: string;
  let listingId: string;

  beforeAll(async () => {
    const suffix = randomUUID();
    const seller = await prisma.user.create({
      data: { phone: `+1555msseller${suffix}`.slice(0, 30), name: "Test Seller" },
    });
    const other = await prisma.user.create({
      data: { phone: `+1555msother${suffix}`.slice(0, 30), name: "Someone Else" },
    });
    sellerId = seller.id;
    sellerToken = await issueSessionToken(seller);
    otherUserId = other.id;
    otherUserToken = await issueSessionToken(other);

    const listing = await prisma.listing.create({
      data: {
        sellerId,
        movieName: "Mark Sold Test Movie",
        theaterName: "Mark Sold Test Theater",
        theaterLat: LAT,
        theaterLng: LNG,
        showtime: new Date(Date.now() + 24 * 60 * 60 * 1000),
        bookingId: `MARKSOLDTEST${suffix}`.slice(0, 20),
        totalSeats: 5,
        availableSeats: 5,
        pricePerSeat: 250,
      },
    });
    listingId = listing.id;
  });

  afterAll(async () => {
    await prisma.listing.delete({ where: { id: listingId } });
    await prisma.user.deleteMany({ where: { id: { in: [sellerId, otherUserId] } } });
  });

  it("403s for someone who isn't the listing's seller", async () => {
    const res = await request(app)
      .post(`/api/listings/${listingId}/mark-sold`)
      .set("Authorization", `Bearer ${otherUserToken}`)
      .send({ seats: 1 });
    expect(res.status).toBe(403);

    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listing.availableSeats).toBe(5);
  });

  it("400s a non-positive seat count", async () => {
    const res = await request(app)
      .post(`/api/listings/${listingId}/mark-sold`)
      .set("Authorization", `Bearer ${sellerToken}`)
      .send({ seats: 0 });
    expect(res.status).toBe(400);
  });

  it("consumes seats and moves status to PARTIALLY_SOLD, without touching reservedSeats", async () => {
    const res = await request(app)
      .post(`/api/listings/${listingId}/mark-sold`)
      .set("Authorization", `Bearer ${sellerToken}`)
      .send({ seats: 2 });
    expect(res.status).toBe(200);
    expect(res.body.data.listing.availableSeats).toBe(3);
    expect(res.body.data.listing.status).toBe("PARTIALLY_SOLD");

    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listing.reservedSeats).toBe(0);
  });

  it("409s when asked to mark more seats sold than are available", async () => {
    const res = await request(app)
      .post(`/api/listings/${listingId}/mark-sold`)
      .set("Authorization", `Bearer ${sellerToken}`)
      .send({ seats: 10 });
    expect(res.status).toBe(409);

    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listing.availableSeats).toBe(3);
  });

  it("moves status to SOLD once the remaining seats are consumed", async () => {
    const res = await request(app)
      .post(`/api/listings/${listingId}/mark-sold`)
      .set("Authorization", `Bearer ${sellerToken}`)
      .send({ seats: 3 });
    expect(res.status).toBe(200);
    expect(res.body.data.listing.availableSeats).toBe(0);
    expect(res.body.data.listing.status).toBe("SOLD");
  });

  it("404s a nonexistent listing", async () => {
    const res = await request(app)
      .post(`/api/listings/${randomUUID()}/mark-sold`)
      .set("Authorization", `Bearer ${sellerToken}`)
      .send({ seats: 1 });
    expect(res.status).toBe(404);
  });
});
