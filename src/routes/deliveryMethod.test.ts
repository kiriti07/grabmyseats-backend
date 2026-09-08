import "dotenv/config";
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../lib/prisma";
import { issueSessionToken } from "../lib/session";
import { SELLER_TRUST_MIN_COMPLETED_SALES } from "../lib/sellerTrust";

// End-to-end coverage for the delivery-method feature, against the real
// local Postgres through the actual Express app - not mocked:
//   - the seller trust gate (GET /me/delivery-eligibility, and POST
//     /api/listings rejecting EMAIL_FORWARD for an ineligible seller)
//   - reserve validating the chosen method is actually offered
//   - confirm-receipt's method-aware gate: EMAIL_FORWARD skips the seller's
//     venue check-in but requires the forwarded email instead; the buyer's
//     own check-in stays mandatory either way
//   - the email-forward submit/view endpoints' access control
//
// POST /api/listings and POST /:id/email-forward both accept a file upload,
// but every scenario here only reaches the codepaths that run *before* the
// actual storageProvider.upload() call (rejected by validation first, or a
// text-only email-forward submission) - so none of this needs real
// Cloudinary credentials, matching how the OCR/screenshot suites are
// avoided elsewhere in this repo's test setup.
//
// The last nested describe below (reserve + confirm-receipt gate) needs
// PAYMENT_MODE=escrow (/check-in, /confirm-receipt, /email-forward's
// ESCROWED requirement all only exist in that mode). PAYMENT_MODE is read
// once at module load (lib/config.ts), so a plain static
// `import { app } from "../app"` would pick up whatever mode the
// environment's .env happens to have rather than what this suite actually
// needs - forced here for the whole file (harmless for the other two
// describes, which never touch a payment-mode-gated route) via
// vi.stubEnv + vi.resetModules() + a dynamic import, same pattern as
// contactOnlyMode.test.ts's forced contact_only.
describe("delivery method", () => {
  const LAT = 12.9716;
  const LNG = 77.5946;

  let app: Express;

  beforeAll(async () => {
    vi.stubEnv("PAYMENT_MODE", "escrow");
    vi.resetModules();
    ({ app } = await import("../app"));
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function createUser(label: string) {
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: { phone: `+1555${label}${suffix}`.slice(0, 30), name: `Test ${label}` },
    });
    const token = await issueSessionToken(user);
    return { id: user.id, token };
  }

  describe("GET /api/users/me/delivery-eligibility", () => {
    let sellerId: string;
    let sellerToken: string;
    let buyerId: string;
    let listingId: string;

    beforeAll(async () => {
      const seller = await createUser("eligseller");
      const buyer = await createUser("eligbuyer");
      sellerId = seller.id;
      sellerToken = seller.token;
      buyerId = buyer.id;

      const listing = await prisma.listing.create({
        data: {
          sellerId,
          movieName: "Eligibility Test Movie",
          theaterName: "Eligibility Test Theater",
          theaterLat: LAT,
          theaterLng: LNG,
          showtime: new Date(Date.now() + 24 * 60 * 60 * 1000),
          bookingId: `ELIGTEST${randomUUID()}`.slice(0, 20),
          totalSeats: 10,
          availableSeats: 10,
          pricePerSeat: 200,
        },
      });
      listingId = listing.id;
    });

    afterAll(async () => {
      await prisma.manualReviewFlag.deleteMany({ where: { transaction: { listingId } } });
      await prisma.transaction.deleteMany({ where: { listingId } });
      await prisma.listing.delete({ where: { id: listingId } });
      await prisma.user.deleteMany({ where: { id: { in: [sellerId, buyerId] } } });
    });

    it("is ineligible with zero completed sales", async () => {
      const res = await request(app)
        .get("/api/users/me/delivery-eligibility")
        .set("Authorization", `Bearer ${sellerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        emailForwardEligible: false,
        completedSales: 0,
        requiredCompletedSales: SELLER_TRUST_MIN_COMPLETED_SALES,
        hasUnresolvedReviewFlags: false,
      });
    });

    it("becomes eligible once the seller has enough PAYOUT_RELEASED transactions", async () => {
      for (let i = 0; i < SELLER_TRUST_MIN_COMPLETED_SALES; i++) {
        await prisma.transaction.create({
          data: {
            listingId,
            buyerId,
            seatsCount: 1,
            amountPaid: 200,
            status: "PAYOUT_RELEASED",
            payoutAt: new Date(),
          },
        });
      }

      const res = await request(app)
        .get("/api/users/me/delivery-eligibility")
        .set("Authorization", `Bearer ${sellerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.completedSales).toBe(SELLER_TRUST_MIN_COMPLETED_SALES);
      expect(res.body.data.emailForwardEligible).toBe(true);
    });

    it("becomes ineligible again with an unresolved review flag, even with enough sales", async () => {
      const [txn] = await prisma.transaction.findMany({ where: { listingId }, take: 1 });
      await prisma.manualReviewFlag.create({
        data: {
          transactionId: txn!.id,
          reason: "test_flag",
          razorpayOrderId: `order_${randomUUID()}`,
          amountPaid: 200,
        },
      });

      const res = await request(app)
        .get("/api/users/me/delivery-eligibility")
        .set("Authorization", `Bearer ${sellerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.hasUnresolvedReviewFlags).toBe(true);
      expect(res.body.data.emailForwardEligible).toBe(false);
    });
  });

  describe("POST /api/listings trust gate", () => {
    let sellerId: string;
    let sellerToken: string;

    beforeAll(async () => {
      const seller = await createUser("gateseller");
      sellerId = seller.id;
      sellerToken = seller.token;
    });

    afterAll(async () => {
      await prisma.user.delete({ where: { id: sellerId } });
    });

    it("403s an ineligible seller offering EMAIL_FORWARD, before touching upload", async () => {
      // A real (tiny) image is attached so the request clears the sync
      // validation stage (screenshot required) and actually reaches the
      // trust gate check - which runs before storageProvider.upload(), so
      // this never touches Cloudinary regardless.
      const onePixelPng = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      );

      const res = await request(app)
        .post("/api/listings")
        .set("Authorization", `Bearer ${sellerToken}`)
        .field("movieName", "Gate Test Movie")
        .field("theaterName", "Gate Test Theater")
        .field("bookingId", "GATETEST123")
        .field("totalSeats", "1")
        .field("pricePerSeat", "200")
        .field("showtime", new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString())
        .field("theaterLat", String(LAT))
        .field("theaterLng", String(LNG))
        .field("availableDeliveryMethods", JSON.stringify(["IN_PERSON", "EMAIL_FORWARD"]))
        .attach("screenshot", onePixelPng, { filename: "test.png", contentType: "image/png" });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);

      const listingCount = await prisma.listing.count({ where: { sellerId } });
      expect(listingCount).toBe(0);
    });
  });

  describe("reserve + confirm-receipt gate for EMAIL_FORWARD", () => {
    let sellerId: string;
    let sellerToken: string;
    let buyerId: string;
    let buyerToken: string;
    let inPersonOnlyListingId: string;
    let emailForwardListingId: string;
    let transactionId: string;

    beforeAll(async () => {
      const seller = await createUser("efseller");
      const buyer = await createUser("efbuyer");
      sellerId = seller.id;
      sellerToken = seller.token;
      buyerId = buyer.id;
      buyerToken = buyer.token;

      // Bypasses the trust gate deliberately (this suite is about
      // reserve/confirm-receipt, not the gate itself - covered above) by
      // seeding the listing directly, same pattern the rest of this repo's
      // test suite uses for setup.
      const inPersonOnly = await prisma.listing.create({
        data: {
          sellerId,
          movieName: "IN_PERSON Only Movie",
          theaterName: "Test Theater",
          theaterLat: LAT,
          theaterLng: LNG,
          showtime: new Date(),
          bookingId: `INPERSONONLY${randomUUID()}`.slice(0, 20),
          totalSeats: 1,
          availableSeats: 1,
          pricePerSeat: 200,
          availableDeliveryMethods: ["IN_PERSON"],
        },
      });
      inPersonOnlyListingId = inPersonOnly.id;

      // showtime = now, so the check-in window is open for the whole test.
      const emailForwardListing = await prisma.listing.create({
        data: {
          sellerId,
          movieName: "Email Forward Movie",
          theaterName: "Test Theater",
          theaterLat: LAT,
          theaterLng: LNG,
          showtime: new Date(),
          bookingId: `EMAILFWD${randomUUID()}`.slice(0, 20),
          totalSeats: 1,
          availableSeats: 1,
          pricePerSeat: 200,
          availableDeliveryMethods: ["IN_PERSON", "EMAIL_FORWARD"],
        },
      });
      emailForwardListingId = emailForwardListing.id;
    });

    afterAll(async () => {
      await prisma.transaction.deleteMany({
        where: { listingId: { in: [inPersonOnlyListingId, emailForwardListingId] } },
      });
      await prisma.listing.deleteMany({
        where: { id: { in: [inPersonOnlyListingId, emailForwardListingId] } },
      });
      await prisma.user.deleteMany({ where: { id: { in: [sellerId, buyerId] } } });
    });

    it("409s reserving a delivery method the listing doesn't offer", async () => {
      const res = await request(app)
        .post(`/api/listings/${inPersonOnlyListingId}/reserve`)
        .set("Authorization", `Bearer ${buyerToken}`)
        .send({ seats: 1, deliveryMethod: "EMAIL_FORWARD" });
      expect(res.status).toBe(409);
    });

    it("400s reserving without a deliveryMethod", async () => {
      const res = await request(app)
        .post(`/api/listings/${emailForwardListingId}/reserve`)
        .set("Authorization", `Bearer ${buyerToken}`)
        .send({ seats: 1 });
      expect(res.status).toBe(400);
    });

    it("reserves with EMAIL_FORWARD and records it on the transaction", async () => {
      const res = await request(app)
        .post(`/api/listings/${emailForwardListingId}/reserve`)
        .set("Authorization", `Bearer ${buyerToken}`)
        .send({ seats: 1, deliveryMethod: "EMAIL_FORWARD" });
      expect(res.status).toBe(201);
      expect(res.body.data.transaction.deliveryMethod).toBe("EMAIL_FORWARD");
      transactionId = res.body.data.transaction.id;

      // Manually escrow - standing in for a webhook-confirmed payment,
      // matching the pattern used elsewhere in this suite.
      await prisma.transaction.update({
        where: { id: transactionId },
        data: { status: "ESCROWED", confirmedAt: new Date() },
      });
    });

    it("confirm-receipt 409s before the buyer has checked in", async () => {
      const res = await request(app)
        .post(`/api/transactions/${transactionId}/confirm-receipt`)
        .set("Authorization", `Bearer ${buyerToken}`);
      expect(res.status).toBe(409);
    });

    it("buyer checks in", async () => {
      const res = await request(app)
        .post(`/api/transactions/${transactionId}/check-in`)
        .set("Authorization", `Bearer ${buyerToken}`)
        .send({ lat: LAT, lng: LNG });
      expect(res.status).toBe(200);
      expect(res.body.data.transaction.buyerCheckInAt).not.toBeNull();
    });

    it("confirm-receipt still 409s - buyer checked in, but seller hasn't forwarded the email yet", async () => {
      const res = await request(app)
        .post(`/api/transactions/${transactionId}/confirm-receipt`)
        .set("Authorization", `Bearer ${buyerToken}`);
      expect(res.status).toBe(409);
    });

    it("GET /:id/email-forward as buyer returns nulls before the seller submits", async () => {
      const res = await request(app)
        .get(`/api/transactions/${transactionId}/email-forward`)
        .set("Authorization", `Bearer ${buyerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ text: null, fileUrl: null, submittedAt: null });
    });

    it("POST /:id/email-forward 403s for the buyer - only the seller can submit", async () => {
      const res = await request(app)
        .post(`/api/transactions/${transactionId}/email-forward`)
        .set("Authorization", `Bearer ${buyerToken}`)
        .field("emailText", "Booking confirmed for seat A1");
      expect(res.status).toBe(403);
    });

    it("POST /:id/email-forward 400s with neither a file nor text", async () => {
      const res = await request(app)
        .post(`/api/transactions/${transactionId}/email-forward`)
        .set("Authorization", `Bearer ${sellerToken}`);
      expect(res.status).toBe(400);
    });

    it("seller submits the forwarded email as text (no file, so no storage upload needed)", async () => {
      const res = await request(app)
        .post(`/api/transactions/${transactionId}/email-forward`)
        .set("Authorization", `Bearer ${sellerToken}`)
        .field("emailText", "Booking confirmed for seat A1");
      expect(res.status).toBe(200);
      expect(res.body.data.transaction.emailForwardSubmittedAt).not.toBeNull();
      // Never leaked to the seller's own response either - only the buyer
      // ever sees the content, via GET /:id/email-forward.
      expect(res.body.data.transaction).not.toHaveProperty("emailForwardText");
    });

    it("GET /:id/email-forward as buyer now returns the submitted text", async () => {
      const res = await request(app)
        .get(`/api/transactions/${transactionId}/email-forward`)
        .set("Authorization", `Bearer ${buyerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.text).toBe("Booking confirmed for seat A1");
      expect(res.body.data.submittedAt).not.toBeNull();
    });

    it("buyer can now confirm receipt, without the seller ever checking in", async () => {
      const detail = await prisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
      expect(detail.sellerCheckInAt).toBeNull();

      const res = await request(app)
        .post(`/api/transactions/${transactionId}/confirm-receipt`)
        .set("Authorization", `Bearer ${buyerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.transaction.status).toBe("BUYER_CONFIRMED");
    });
  });
});
