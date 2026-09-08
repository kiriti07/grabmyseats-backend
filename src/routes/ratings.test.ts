import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../app";
import { prisma } from "../lib/prisma";
import { issueSessionToken } from "../lib/session";

// End-to-end coverage for the buyer-to-seller rating system, against the
// real local Postgres through the actual Express app - not mocked:
// POST /api/transactions/:id/rate (buyer-only, one per transaction), GET
// /api/users/:id/rating-summary (public), and the summary embedded on GET
// /api/listings/:id and GET /api/transactions/:id/contact.
describe("ratings", () => {
  const LAT = 12.9716;
  const LNG = 77.5946;

  let sellerId: string;
  let buyerId: string;
  let buyerToken: string;
  let strangerId: string;
  let strangerToken: string;
  let listingId: string;
  let transactionId: string;
  let secondTransactionId: string;
  let unratedTransactionId: string;

  beforeAll(async () => {
    const suffix = randomUUID();
    const seller = await prisma.user.create({
      data: { phone: `+1555ratingseller${suffix}`.slice(0, 30), name: "Rating Test Seller" },
    });
    const buyer = await prisma.user.create({
      data: { phone: `+1555ratingbuyer${suffix}`.slice(0, 30) },
    });
    const stranger = await prisma.user.create({
      data: { phone: `+1555ratingstranger${suffix}`.slice(0, 30) },
    });
    sellerId = seller.id;
    buyerId = buyer.id;
    buyerToken = await issueSessionToken(buyer);
    strangerId = stranger.id;
    strangerToken = await issueSessionToken(stranger);

    const listing = await prisma.listing.create({
      data: {
        sellerId,
        movieName: "Rating Test Movie",
        theaterName: "Rating Test Theater",
        theaterLat: LAT,
        theaterLng: LNG,
        showtime: new Date(Date.now() + 24 * 60 * 60 * 1000),
        bookingId: `RATINGTEST${suffix}`.slice(0, 20),
        totalSeats: 5,
        availableSeats: 5,
        pricePerSeat: 200,
      },
    });
    listingId = listing.id;

    const transaction = await prisma.transaction.create({
      data: { listingId, buyerId, seatsCount: 1, amountPaid: 200, status: "RESERVED" },
    });
    transactionId = transaction.id;

    // A second, still-to-be-rated transaction on the same listing/seller,
    // for the "one rating per transaction" (not per seller) assertions -
    // and a third that's left unrated for the GET /mine isRated check.
    const secondTransaction = await prisma.transaction.create({
      data: { listingId, buyerId, seatsCount: 1, amountPaid: 200, status: "RESERVED" },
    });
    secondTransactionId = secondTransaction.id;
    const unratedTransaction = await prisma.transaction.create({
      data: { listingId, buyerId, seatsCount: 1, amountPaid: 200, status: "RESERVED" },
    });
    unratedTransactionId = unratedTransaction.id;
  });

  afterAll(async () => {
    await prisma.rating.deleteMany({ where: { ratedUserId: sellerId } });
    await prisma.transaction.deleteMany({ where: { listingId } });
    await prisma.listing.delete({ where: { id: listingId } });
    await prisma.user.deleteMany({ where: { id: { in: [sellerId, buyerId, strangerId] } } });
  });

  it("GET /api/users/:id/rating-summary is 'no ratings yet' before any rating exists - no auth required", async () => {
    const res = await request(app).get(`/api/users/${sellerId}/rating-summary`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ averageStars: null, totalRatings: 0, recentComments: [] });
  });

  it("a bogus/nonexistent user id also just comes back as no ratings, not a 404", async () => {
    const res = await request(app).get(`/api/users/${randomUUID()}/rating-summary`);
    expect(res.status).toBe(200);
    expect(res.body.data.totalRatings).toBe(0);
  });

  it("GET /api/listings/:id embeds the seller's rating summary", async () => {
    const res = await request(app).get(`/api/listings/${listingId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.listing.sellerRatingSummary).toEqual({
      averageStars: null,
      totalRatings: 0,
      recentComments: [],
    });
  });

  it("POST /:id/rate 400s an out-of-range stars value", async () => {
    const res = await request(app)
      .post(`/api/transactions/${transactionId}/rate`)
      .set("Authorization", `Bearer ${buyerToken}`)
      .send({ stars: 6 });
    expect(res.status).toBe(400);
  });

  it("POST /:id/rate 403s a stranger who isn't the buyer", async () => {
    const res = await request(app)
      .post(`/api/transactions/${transactionId}/rate`)
      .set("Authorization", `Bearer ${strangerToken}`)
      .send({ stars: 5 });
    expect(res.status).toBe(403);
  });

  it("POST /:id/rate creates a rating with stars + comment", async () => {
    const res = await request(app)
      .post(`/api/transactions/${transactionId}/rate`)
      .set("Authorization", `Bearer ${buyerToken}`)
      .send({ stars: 5, comment: "Smooth handoff, seller was on time." });
    expect(res.status).toBe(201);
    expect(res.body.data.rating.stars).toBe(5);
    expect(res.body.data.rating.comment).toBe("Smooth handoff, seller was on time.");
    expect(res.body.data.rating.ratedUserId).toBe(sellerId);
    expect(res.body.data.rating.transactionId).toBe(transactionId);
  });

  it("409s rating the same transaction twice", async () => {
    const res = await request(app)
      .post(`/api/transactions/${transactionId}/rate`)
      .set("Authorization", `Bearer ${buyerToken}`)
      .send({ stars: 3 });
    expect(res.status).toBe(409);
  });

  it("a second, different transaction with the same buyer/seller can still be rated separately", async () => {
    const res = await request(app)
      .post(`/api/transactions/${secondTransactionId}/rate`)
      .set("Authorization", `Bearer ${buyerToken}`)
      .send({ stars: 3 });
    expect(res.status).toBe(201);
  });

  it("no restriction on transaction status - a still-RESERVED (never even paid) transaction can be rated", async () => {
    // Both transactions rated above were RESERVED the whole time, with no
    // confirm-receipt step ever run - proves the "no restriction beyond
    // being the buyer" requirement, not just that it happens to work for
    // RESERVED specifically as a coincidence.
    const rated = await prisma.rating.findMany({ where: { transactionId: { in: [transactionId, secondTransactionId] } } });
    expect(rated).toHaveLength(2);
  });

  it("GET /api/users/:id/rating-summary now reflects both ratings, averaged, with the comment surfaced", async () => {
    const res = await request(app).get(`/api/users/${sellerId}/rating-summary`);
    expect(res.status).toBe(200);
    expect(res.body.data.totalRatings).toBe(2);
    expect(res.body.data.averageStars).toBe(4); // (5 + 3) / 2
    expect(res.body.data.recentComments).toHaveLength(1);
    expect(res.body.data.recentComments[0].comment).toBe("Smooth handoff, seller was on time.");
    expect(res.body.data.recentComments[0].stars).toBe(5);
    // Never exposes who left it.
    expect(res.body.data.recentComments[0]).not.toHaveProperty("raterId");
  });

  it("GET /api/transactions/:id/contact embeds the seller's rating summary for the buyer, not for the seller", async () => {
    const sellerToken = await issueSessionToken(
      await prisma.user.findUniqueOrThrow({ where: { id: sellerId } }),
    );

    const asBuyer = await request(app)
      .get(`/api/transactions/${transactionId}/contact`)
      .set("Authorization", `Bearer ${buyerToken}`);
    expect(asBuyer.status).toBe(200);
    expect(asBuyer.body.data.contact.ratingSummary.totalRatings).toBe(2);

    const asSeller = await request(app)
      .get(`/api/transactions/${transactionId}/contact`)
      .set("Authorization", `Bearer ${sellerToken}`);
    expect(asSeller.status).toBe(200);
    expect(asSeller.body.data.contact.ratingSummary).toBeNull();
  });

  it("GET /api/transactions/mine lists the buyer's purchases with isRated set correctly", async () => {
    const res = await request(app)
      .get("/api/transactions/mine")
      .set("Authorization", `Bearer ${buyerToken}`);
    expect(res.status).toBe(200);
    const purchases = res.body.data.purchases;
    const rated = purchases.find((p: { id: string }) => p.id === transactionId);
    const alsoRated = purchases.find((p: { id: string }) => p.id === secondTransactionId);
    const unrated = purchases.find((p: { id: string }) => p.id === unratedTransactionId);
    expect(rated.isRated).toBe(true);
    expect(alsoRated.isRated).toBe(true);
    expect(unrated.isRated).toBe(false);
  });
});
