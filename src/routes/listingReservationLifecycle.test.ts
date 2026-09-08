import "dotenv/config";
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../lib/prisma";
import { issueSessionToken } from "../lib/session";
import { expireReservations } from "../jobs/expireReservations";

// End-to-end regression coverage for the availableSeats/status lifecycle
// fixed here: reserving seats must remove a listing from buyer search
// immediately (not just at payment), and giving up an unpaid reservation
// (via the expiry cron) must bring it back. Runs against the real local
// Postgres (docker-compose's grabmyseats-postgres) through the actual
// Express app and reservation-expiry job - not mocked - since the bug this
// guards against was exactly two write paths silently disagreeing about
// what these columns mean.
//
// This lifecycle (seats locked at reserve time, atomically) is
// escrow-mode-specific - contact_only mode deliberately does NOT lock
// seats on reserve (see contactOnlyMode.test.ts). Forced to escrow here
// via vi.stubEnv + vi.resetModules() + a dynamic import (same pattern as
// contactOnlyMode.test.ts's forced contact_only) rather than assuming the
// ambient PAYMENT_MODE env var happens to already be escrow.
describe("listing search reflects live reservation state", () => {
  const LAT = 12.9716;
  const LNG = 77.5946;

  let app: Express;
  let sellerId: string;
  let buyerId: string;
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
    buyerToken = await issueSessionToken(buyer);

    const listing = await prisma.listing.create({
      data: {
        sellerId,
        movieName: "Integration Test Movie",
        theaterName: "Integration Test Theater",
        theaterLat: LAT,
        theaterLng: LNG,
        showtime: new Date(Date.now() + 24 * 60 * 60 * 1000),
        bookingId: `TESTBOOKING${suffix}`.slice(0, 20),
        totalSeats: 2,
        availableSeats: 2,
        pricePerSeat: 250,
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

  async function searchIncludesListing(): Promise<boolean> {
    const res = await request(app)
      .get("/api/listings/search")
      .query({ lat: LAT, lng: LNG });
    expect(res.status).toBe(200);
    const listings: { id: string }[] = res.body.data.listings;
    return listings.some((l) => l.id === listingId);
  }

  it("appears in search while seats are available", async () => {
    expect(await searchIncludesListing()).toBe(true);
  });

  it("is excluded from search once fully reserved", async () => {
    const reserveRes = await request(app)
      .post(`/api/listings/${listingId}/reserve`)
      .set("Authorization", `Bearer ${buyerToken}`)
      .send({ seats: 2, deliveryMethod: "IN_PERSON" });

    expect(reserveRes.status).toBe(201);
    transactionId = reserveRes.body.data.transaction.id;

    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listing.availableSeats).toBe(0);
    expect(listing.reservedSeats).toBe(2);
    expect(listing.status).toBe("SOLD");

    expect(await searchIncludesListing()).toBe(false);
  });

  it("reappears in search once the reservation expires", async () => {
    // Fast-forward the hold instead of waiting out RESERVATION_HOLD_MINUTES
    // for real, then run the same job the cron schedule calls.
    await prisma.transaction.update({
      where: { id: transactionId },
      data: { reservationExpiresAt: new Date(Date.now() - 1000) },
    });
    await expireReservations();

    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listing.availableSeats).toBe(2);
    expect(listing.reservedSeats).toBe(0);
    expect(listing.status).toBe("ACTIVE");

    expect(await searchIncludesListing()).toBe(true);
  });
});
