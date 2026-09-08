import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../app";
import { prisma } from "../lib/prisma";
import { issueSessionToken } from "../lib/session";

// End-to-end coverage for the listing-management additions on
// /sell/my-listings: POST /:id/deactivate and PATCH /:id, against the real
// local Postgres through the actual Express app - not mocked.
describe("listing management", () => {
  const LAT = 12.9716;
  const LNG = 77.5946;

  async function createUser(label: string) {
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: { phone: `+1555${label}${suffix}`.slice(0, 30), name: `Test ${label}` },
    });
    const token = await issueSessionToken(user);
    return { id: user.id, token };
  }

  async function createListing(
    sellerId: string,
    overrides: Partial<{
      totalSeats: number;
      availableSeats: number;
      pricePerSeat: number;
      totalAmountPaid: number | null;
      showtime: Date;
      status: "ACTIVE" | "PARTIALLY_SOLD" | "SOLD" | "WITHDRAWN";
    }> = {},
  ) {
    const listing = await prisma.listing.create({
      data: {
        sellerId,
        movieName: "Listing Mgmt Test Movie",
        theaterName: "Listing Mgmt Test Theater",
        theaterLat: LAT,
        theaterLng: LNG,
        showtime: overrides.showtime ?? new Date(Date.now() + 24 * 60 * 60 * 1000),
        bookingId: `LISTMGMT${randomUUID()}`.slice(0, 20),
        totalSeats: overrides.totalSeats ?? 4,
        availableSeats: overrides.availableSeats ?? overrides.totalSeats ?? 4,
        pricePerSeat: overrides.pricePerSeat ?? 250,
        totalAmountPaid: overrides.totalAmountPaid ?? null,
        status: overrides.status ?? "ACTIVE",
      },
    });
    return listing.id;
  }

  let sellerId: string;
  let sellerToken: string;
  let otherUserId: string;
  let otherUserToken: string;
  const listingIds: string[] = [];

  beforeAll(async () => {
    const seller = await createUser("lmseller");
    const other = await createUser("lmother");
    sellerId = seller.id;
    sellerToken = seller.token;
    otherUserId = other.id;
    otherUserToken = other.token;
  });

  afterAll(async () => {
    await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
    await prisma.user.deleteMany({ where: { id: { in: [sellerId, otherUserId] } } });
  });

  describe("POST /api/listings/:id/deactivate", () => {
    it("403s for someone who isn't the seller", async () => {
      const listingId = await createListing(sellerId);
      listingIds.push(listingId);

      const res = await request(app)
        .post(`/api/listings/${listingId}/deactivate`)
        .set("Authorization", `Bearer ${otherUserToken}`);
      expect(res.status).toBe(403);

      const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
      expect(listing.status).toBe("ACTIVE");
    });

    it("moves an ACTIVE listing to WITHDRAWN without touching seat counts", async () => {
      const listingId = await createListing(sellerId, { totalSeats: 5, availableSeats: 5 });
      listingIds.push(listingId);

      const res = await request(app)
        .post(`/api/listings/${listingId}/deactivate`)
        .set("Authorization", `Bearer ${sellerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.listing.status).toBe("WITHDRAWN");
      expect(res.body.data.listing.availableSeats).toBe(5);
      expect(res.body.data.listing.totalSeats).toBe(5);
    });

    it("is excluded from search once withdrawn", async () => {
      const listingId = await createListing(sellerId);
      listingIds.push(listingId);

      const before = await request(app).get("/api/listings/search").query({ lat: LAT, lng: LNG });
      expect(before.body.data.listings.some((l: { id: string }) => l.id === listingId)).toBe(true);

      await request(app)
        .post(`/api/listings/${listingId}/deactivate`)
        .set("Authorization", `Bearer ${sellerToken}`);

      const after = await request(app).get("/api/listings/search").query({ lat: LAT, lng: LNG });
      expect(after.body.data.listings.some((l: { id: string }) => l.id === listingId)).toBe(false);
    });

    it("409s deactivating an already-SOLD listing", async () => {
      const listingId = await createListing(sellerId, {
        totalSeats: 2,
        availableSeats: 0,
        status: "SOLD",
      });
      listingIds.push(listingId);

      const res = await request(app)
        .post(`/api/listings/${listingId}/deactivate`)
        .set("Authorization", `Bearer ${sellerToken}`);
      expect(res.status).toBe(409);
    });

    it("404s a nonexistent listing", async () => {
      const res = await request(app)
        .post(`/api/listings/${randomUUID()}/deactivate`)
        .set("Authorization", `Bearer ${sellerToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /api/listings/:id", () => {
    it("403s for someone who isn't the seller", async () => {
      const listingId = await createListing(sellerId);
      listingIds.push(listingId);

      const res = await request(app)
        .patch(`/api/listings/${listingId}`)
        .set("Authorization", `Bearer ${otherUserToken}`)
        .send({ pricePerSeat: 300 });
      expect(res.status).toBe(403);
    });

    it("400s an empty body", async () => {
      const listingId = await createListing(sellerId);
      listingIds.push(listingId);

      const res = await request(app)
        .patch(`/api/listings/${listingId}`)
        .set("Authorization", `Bearer ${sellerToken}`)
        .send({});
      expect(res.status).toBe(400);
    });

    it("updates pricePerSeat alone", async () => {
      const listingId = await createListing(sellerId, { pricePerSeat: 200 });
      listingIds.push(listingId);

      const res = await request(app)
        .patch(`/api/listings/${listingId}`)
        .set("Authorization", `Bearer ${sellerToken}`)
        .send({ pricePerSeat: 275 });
      expect(res.status).toBe(200);
      expect(res.body.data.listing.pricePerSeat).toBe(275);
    });

    it("400s a showtime that isn't in the future", async () => {
      const listingId = await createListing(sellerId);
      listingIds.push(listingId);

      const res = await request(app)
        .patch(`/api/listings/${listingId}`)
        .set("Authorization", `Bearer ${sellerToken}`)
        .send({ showtime: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
      expect(res.status).toBe(400);
    });

    it("updates totalSeats (and keeps availableSeats in lockstep) when nothing is reserved", async () => {
      const listingId = await createListing(sellerId, { totalSeats: 4, availableSeats: 4 });
      listingIds.push(listingId);

      const res = await request(app)
        .patch(`/api/listings/${listingId}`)
        .set("Authorization", `Bearer ${sellerToken}`)
        .send({ totalSeats: 6 });
      expect(res.status).toBe(200);
      expect(res.body.data.listing.totalSeats).toBe(6);
      expect(res.body.data.listing.availableSeats).toBe(6);
    });

    it("409s changing totalSeats once any seats are reserved/sold", async () => {
      const listingId = await createListing(sellerId, { totalSeats: 4, availableSeats: 2 });
      listingIds.push(listingId);

      const res = await request(app)
        .patch(`/api/listings/${listingId}`)
        .set("Authorization", `Bearer ${sellerToken}`)
        .send({ totalSeats: 5 });
      expect(res.status).toBe(409);

      const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
      expect(listing.totalSeats).toBe(4);
    });

    it("still allows editing pricePerSeat/showtime on a partially-sold listing", async () => {
      const listingId = await createListing(sellerId, { totalSeats: 4, availableSeats: 2 });
      listingIds.push(listingId);

      const res = await request(app)
        .patch(`/api/listings/${listingId}`)
        .set("Authorization", `Bearer ${sellerToken}`)
        .send({ pricePerSeat: 350 });
      expect(res.status).toBe(200);
      expect(res.body.data.listing.pricePerSeat).toBe(350);
    });

    it("400s a price/seat combination that would exceed totalAmountPaid", async () => {
      const listingId = await createListing(sellerId, {
        totalSeats: 2,
        availableSeats: 2,
        pricePerSeat: 200,
        totalAmountPaid: 500,
      });
      listingIds.push(listingId);

      // 2 seats * 300 = 600, more than the 500 the seller says they paid.
      const res = await request(app)
        .patch(`/api/listings/${listingId}`)
        .set("Authorization", `Bearer ${sellerToken}`)
        .send({ pricePerSeat: 300 });
      expect(res.status).toBe(400);
    });

    it("409s editing a listing that's no longer live", async () => {
      const listingId = await createListing(sellerId, {
        totalSeats: 2,
        availableSeats: 0,
        status: "SOLD",
      });
      listingIds.push(listingId);

      const res = await request(app)
        .patch(`/api/listings/${listingId}`)
        .set("Authorization", `Bearer ${sellerToken}`)
        .send({ pricePerSeat: 300 });
      expect(res.status).toBe(409);
    });

    it("404s a nonexistent listing", async () => {
      const res = await request(app)
        .patch(`/api/listings/${randomUUID()}`)
        .set("Authorization", `Bearer ${sellerToken}`)
        .send({ pricePerSeat: 300 });
      expect(res.status).toBe(404);
    });
  });
});
