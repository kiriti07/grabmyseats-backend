import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../app";
import { prisma } from "../lib/prisma";

// GET /api/listings/search's movieName param matches against either
// movieName or theaterName (see the OR condition in routes/listings.ts) -
// this is also what powers the frontend's autocomplete suggestions, which
// draw title and venue suggestions from these same results.
describe("GET /api/listings/search theater-name matching", () => {
  const LAT = 12.9716;
  const LNG = 77.5946;

  let sellerId: string;
  let listingId: string;

  beforeAll(async () => {
    const suffix = randomUUID();
    const seller = await prisma.user.create({
      data: { phone: `+1555searchtxt${suffix}`.slice(0, 30) },
    });
    sellerId = seller.id;

    const listing = await prisma.listing.create({
      data: {
        sellerId,
        movieName: "Search Text Match Movie",
        theaterName: "Grand Cineplex Downtown",
        theaterLat: LAT,
        theaterLng: LNG,
        showtime: new Date(Date.now() + 24 * 60 * 60 * 1000),
        bookingId: `SEARCHTXT${suffix}`.slice(0, 20),
        totalSeats: 2,
        availableSeats: 2,
        pricePerSeat: 200,
      },
    });
    listingId = listing.id;
  });

  afterAll(async () => {
    await prisma.listing.delete({ where: { id: listingId } });
    await prisma.user.delete({ where: { id: sellerId } });
  });

  it("matches on theaterName even when movieName is unrelated", async () => {
    const res = await request(app)
      .get("/api/listings/search")
      .query({ lat: LAT, lng: LNG, movieName: "Grand Cineplex" });
    expect(res.status).toBe(200);
    const ids = res.body.data.listings.map((l: { id: string }) => l.id);
    expect(ids).toContain(listingId);
  });

  it("still matches on movieName as before", async () => {
    const res = await request(app)
      .get("/api/listings/search")
      .query({ lat: LAT, lng: LNG, movieName: "Search Text Match" });
    expect(res.status).toBe(200);
    const ids = res.body.data.listings.map((l: { id: string }) => l.id);
    expect(ids).toContain(listingId);
  });

  it("excludes it when the term matches neither field", async () => {
    const res = await request(app)
      .get("/api/listings/search")
      .query({ lat: LAT, lng: LNG, movieName: "Completely Unrelated Query Zzz" });
    expect(res.status).toBe(200);
    const ids = res.body.data.listings.map((l: { id: string }) => l.id);
    expect(ids).not.toContain(listingId);
  });
});
