import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../app";
import { prisma } from "../lib/prisma";
import { issueAdminSessionToken } from "../lib/adminSession";

// End-to-end regression coverage for POST /api/admin/transactions/:id/refund
// against the real local Postgres, through the actual Express app - not
// mocked. Mirrors the manual verification steps from the task: dispute a
// transaction, refund it, confirm status/seats/review-flag all update
// together, and confirm a second refund on the same (now-terminal)
// transaction 409s instead of double-refunding.
describe("POST /api/admin/transactions/:id/refund", () => {
  const LAT = 12.9716;
  const LNG = 77.5946;

  let sellerId: string;
  let buyerId: string;
  let adminId: string;
  let adminToken: string;
  let listingId: string;
  let transactionId: string;
  let reviewFlagId: string;

  beforeAll(async () => {
    const suffix = randomUUID();
    const seller = await prisma.user.create({
      data: { phone: `+1555seller${suffix}`.slice(0, 30), name: "Test Seller" },
    });
    const buyer = await prisma.user.create({
      data: { phone: `+1555buyer${suffix}`.slice(0, 30), name: "Test Buyer" },
    });
    const admin = await prisma.adminUser.create({
      data: { username: `refund-admin-${suffix}`, passwordHash: "n/a", role: "ADMIN" },
    });
    sellerId = seller.id;
    buyerId = buyer.id;
    adminId = admin.id;
    adminToken = await issueAdminSessionToken(admin);

    const listing = await prisma.listing.create({
      data: {
        sellerId,
        movieName: "Refund Test Movie",
        theaterName: "Refund Test Theater",
        theaterLat: LAT,
        theaterLng: LNG,
        showtime: new Date(Date.now() + 24 * 60 * 60 * 1000),
        bookingId: `REFUNDTEST${suffix}`.slice(0, 20),
        totalSeats: 2,
        availableSeats: 2,
        pricePerSeat: 300,
      },
    });
    listingId = listing.id;

    // Seats reserved (mirrors POST /:id/reserve's own effect on the
    // listing), then manually escrowed - standing in for a buyer having
    // actually paid, and disputed - standing in for the seller having
    // no-showed, without needing a real Razorpay webhook delivery or the
    // full check-in window to exercise this endpoint.
    await prisma.$executeRaw`
      UPDATE "Listing"
      SET "reservedSeats" = 2, "availableSeats" = 0, status = 'SOLD'
      WHERE id = ${listingId}
    `;
    const transaction = await prisma.transaction.create({
      data: {
        listingId,
        buyerId,
        seatsCount: 2,
        amountPaid: 600,
        status: "DISPUTED",
        razorpayOrderId: `order_test_${suffix}`,
      },
    });
    transactionId = transaction.id;

    const flag = await prisma.manualReviewFlag.create({
      data: {
        transactionId,
        reason: "seller_no_show",
        razorpayOrderId: transaction.razorpayOrderId!,
        amountPaid: transaction.amountPaid,
      },
    });
    reviewFlagId = flag.id;
  });

  afterAll(async () => {
    await prisma.manualReviewFlag.deleteMany({ where: { transactionId } });
    await prisma.transaction.deleteMany({ where: { listingId } });
    await prisma.listing.delete({ where: { id: listingId } });
    await prisma.user.deleteMany({ where: { id: { in: [sellerId, buyerId] } } });
    await prisma.adminUser.delete({ where: { id: adminId } });
  });

  async function searchIncludesListing(): Promise<boolean> {
    const res = await request(app)
      .get("/api/listings/search")
      .query({ lat: LAT, lng: LNG });
    expect(res.status).toBe(200);
    const listings: { id: string }[] = res.body.data.listings;
    return listings.some((l) => l.id === listingId);
  }

  it("is excluded from search while sold out", async () => {
    expect(await searchIncludesListing()).toBe(false);
  });

  it("refunds a DISPUTED transaction: status, seats, and the review flag all update together", async () => {
    const res = await request(app)
      .post(`/api/admin/transactions/${transactionId}/refund`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.transaction.status).toBe("REFUNDED");
    expect(res.body.data.transaction.refundId).toMatch(/^mock_refund_/);
    expect(res.body.data.transaction.refundedAt).not.toBeNull();

    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listing.availableSeats).toBe(2);
    expect(listing.reservedSeats).toBe(0);
    expect(listing.status).toBe("ACTIVE");

    expect(await searchIncludesListing()).toBe(true);

    const flag = await prisma.manualReviewFlag.findUniqueOrThrow({
      where: { id: reviewFlagId },
    });
    expect(flag.resolvedAt).not.toBeNull();
  });

  it("409s on a second refund of the same (now-terminal) transaction", async () => {
    const res = await request(app)
      .post(`/api/admin/transactions/${transactionId}/refund`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  it("requires admin auth", async () => {
    const res = await request(app).post(`/api/admin/transactions/${transactionId}/refund`);
    expect(res.status).toBe(401);
  });
});
