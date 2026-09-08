import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../app";
import { prisma } from "../lib/prisma";
import { issueSessionToken } from "../lib/session";

// End-to-end coverage for the ticket category system, against the real
// local Postgres through the actual Express app - not mocked:
//   - defaulting to MOVIE (creation, and existing rows via the migration's
//     column default)
//   - creation storing/returning a chosen category
//   - GET /search filtering by category
//   - POST /ocr skipping the movie-tuned parsing pipeline for non-MOVIE
//     categories, verified against the same real ticket screenshot used by
//     parseListingText.test.ts (same image, category is the only variable)
describe("category", () => {
  const LAT = 12.9716;
  const LNG = 77.5946;

  let sellerId: string;
  let sellerToken: string;
  const listingIds: string[] = [];

  const onePixelPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );

  beforeAll(async () => {
    const suffix = randomUUID();
    const seller = await prisma.user.create({
      data: { phone: `+1555catseller${suffix}`.slice(0, 30), name: "Test Seller" },
    });
    sellerId = seller.id;
    sellerToken = await issueSessionToken(seller);
  });

  afterAll(async () => {
    await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
    await prisma.user.delete({ where: { id: sellerId } });
  });

  function attachListingForm(req: request.Test, overrides: Record<string, string> = {}) {
    return req
      .field("movieName", overrides.movieName ?? "Category Test Title")
      .field("theaterName", overrides.theaterName ?? "Category Test Venue")
      .field("bookingId", overrides.bookingId ?? `CATTEST${randomUUID()}`.slice(0, 20))
      .field("totalSeats", overrides.totalSeats ?? "1")
      .field("pricePerSeat", overrides.pricePerSeat ?? "200")
      .field("showtime", overrides.showtime ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString())
      .field("theaterLat", String(LAT))
      .field("theaterLng", String(LNG))
      .attach("screenshot", onePixelPng, { filename: "test.png", contentType: "image/png" });
  }

  describe("POST /api/listings", () => {
    it("defaults to MOVIE when category isn't sent", async () => {
      const res = await attachListingForm(
        request(app).post("/api/listings").set("Authorization", `Bearer ${sellerToken}`),
      );
      expect(res.status).toBe(201);
      expect(res.body.data.listing.category).toBe("MOVIE");
      listingIds.push(res.body.data.listing.id);
    });

    it("stores and returns a chosen category", async () => {
      const res = await attachListingForm(
        request(app)
          .post("/api/listings")
          .set("Authorization", `Bearer ${sellerToken}`)
          .field("category", "EVENT"),
      );
      expect(res.status).toBe(201);
      expect(res.body.data.listing.category).toBe("EVENT");
      listingIds.push(res.body.data.listing.id);
    });

    it("falls back to MOVIE for an invalid category value", async () => {
      const res = await attachListingForm(
        request(app)
          .post("/api/listings")
          .set("Authorization", `Bearer ${sellerToken}`)
          .field("category", "NOT_A_REAL_CATEGORY"),
      );
      expect(res.status).toBe(201);
      expect(res.body.data.listing.category).toBe("MOVIE");
      listingIds.push(res.body.data.listing.id);
    });

    it("round-trips category through GET /:id and GET /mine", async () => {
      const created = await attachListingForm(
        request(app)
          .post("/api/listings")
          .set("Authorization", `Bearer ${sellerToken}`)
          .field("category", "SPORT"),
      );
      const listingId = created.body.data.listing.id;
      listingIds.push(listingId);

      const detail = await request(app).get(`/api/listings/${listingId}`);
      expect(detail.body.data.listing.category).toBe("SPORT");

      const mine = await request(app)
        .get("/api/listings/mine")
        .set("Authorization", `Bearer ${sellerToken}`);
      const found = mine.body.data.listings.find((l: { id: string }) => l.id === listingId);
      expect(found.category).toBe("SPORT");
    });
  });

  describe("GET /api/listings/search category filter", () => {
    let movieListingId: string;
    let eventListingId: string;

    beforeAll(async () => {
      const movie = await prisma.listing.create({
        data: {
          sellerId,
          category: "MOVIE",
          movieName: "Search Filter Movie",
          theaterName: "Search Filter Theater",
          theaterLat: LAT,
          theaterLng: LNG,
          showtime: new Date(Date.now() + 24 * 60 * 60 * 1000),
          bookingId: `SEARCHMOVIE${randomUUID()}`.slice(0, 20),
          totalSeats: 2,
          availableSeats: 2,
          pricePerSeat: 200,
        },
      });
      const eventListing = await prisma.listing.create({
        data: {
          sellerId,
          category: "EVENT",
          movieName: "Search Filter Event",
          theaterName: "Search Filter Venue",
          theaterLat: LAT,
          theaterLng: LNG,
          showtime: new Date(Date.now() + 24 * 60 * 60 * 1000),
          bookingId: `SEARCHEVENT${randomUUID()}`.slice(0, 20),
          totalSeats: 2,
          availableSeats: 2,
          pricePerSeat: 200,
        },
      });
      movieListingId = movie.id;
      eventListingId = eventListing.id;
      listingIds.push(movieListingId, eventListingId);
    });

    it("returns every category when none is specified", async () => {
      const res = await request(app).get("/api/listings/search").query({ lat: LAT, lng: LNG });
      const ids = res.body.data.listings.map((l: { id: string }) => l.id);
      expect(ids).toContain(movieListingId);
      expect(ids).toContain(eventListingId);
    });

    it("filters to just the requested category", async () => {
      const res = await request(app)
        .get("/api/listings/search")
        .query({ lat: LAT, lng: LNG, category: "EVENT" });
      const ids = res.body.data.listings.map((l: { id: string }) => l.id);
      expect(ids).toContain(eventListingId);
      expect(ids).not.toContain(movieListingId);
    });

    it("400s an invalid category value", async () => {
      const res = await request(app)
        .get("/api/listings/search")
        .query({ lat: LAT, lng: LNG, category: "NOT_A_REAL_CATEGORY" });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/listings/search radius defaults", () => {
    // ~20km north of LAT/LNG (1 degree latitude is ~111km) - inside the
    // EVENT/SPORT default radius (50km) but outside the MOVIE/no-category
    // default (7km), so this one listing's presence/absence in results is
    // exactly what distinguishes the two defaults.
    const FAR_LAT = LAT + 20 / 111;

    let farMovieListingId: string;
    let farEventListingId: string;

    beforeAll(async () => {
      const farMovie = await prisma.listing.create({
        data: {
          sellerId,
          category: "MOVIE",
          movieName: "Radius Default Movie",
          theaterName: "Radius Default Theater",
          theaterLat: FAR_LAT,
          theaterLng: LNG,
          showtime: new Date(Date.now() + 24 * 60 * 60 * 1000),
          bookingId: `RADIUSMOVIE${randomUUID()}`.slice(0, 20),
          totalSeats: 2,
          availableSeats: 2,
          pricePerSeat: 200,
        },
      });
      const farEvent = await prisma.listing.create({
        data: {
          sellerId,
          category: "EVENT",
          movieName: "Radius Default Event",
          theaterName: "Radius Default Venue",
          theaterLat: FAR_LAT,
          theaterLng: LNG,
          showtime: new Date(Date.now() + 24 * 60 * 60 * 1000),
          bookingId: `RADIUSEVENT${randomUUID()}`.slice(0, 20),
          totalSeats: 2,
          availableSeats: 2,
          pricePerSeat: 200,
        },
      });
      farMovieListingId = farMovie.id;
      farEventListingId = farEvent.id;
      listingIds.push(farMovieListingId, farEventListingId);
    });

    it("MOVIE search still defaults to 7km - a ~20km listing is out of range", async () => {
      const res = await request(app)
        .get("/api/listings/search")
        .query({ lat: LAT, lng: LNG, category: "MOVIE" });
      const ids = res.body.data.listings.map((l: { id: string }) => l.id);
      expect(ids).not.toContain(farMovieListingId);
    });

    it("EVENT search defaults to the wide (50km) radius - the same ~20km distance is in range", async () => {
      const res = await request(app)
        .get("/api/listings/search")
        .query({ lat: LAT, lng: LNG, category: "EVENT" });
      const ids = res.body.data.listings.map((l: { id: string }) => l.id);
      expect(ids).toContain(farEventListingId);
    });

    it("an explicit radiusKm still overrides the category default", async () => {
      const res = await request(app)
        .get("/api/listings/search")
        .query({ lat: LAT, lng: LNG, category: "MOVIE", radiusKm: "25" });
      const ids = res.body.data.listings.map((l: { id: string }) => l.id);
      expect(ids).toContain(farMovieListingId);
    });
  });

  describe("GET /api/listings/search relevance-first ordering for EVENT/SPORT", () => {
    // "Close" is ~0.1km from the search origin (would win on pure
    // distance); "far" is ~10km away (still well inside the 50km
    // EVENT/SPORT default) but is the one that actually matches the
    // search term - proving relevance beats distance for these
    // categories, not just that both happen to be returned.
    const CLOSE_LAT = LAT + 0.1 / 111;
    const FAR_LAT = LAT + 10 / 111;

    let closeIrrelevantEventId: string;
    let farRelevantEventId: string;
    let closeIrrelevantSportId: string;
    let farRelevantSportId: string;

    beforeAll(async () => {
      const closeIrrelevantEvent = await prisma.listing.create({
        data: {
          sellerId,
          category: "EVENT",
          movieName: "Random Local Comedy Show",
          theaterName: "Nearby Club",
          theaterLat: CLOSE_LAT,
          theaterLng: LNG,
          showtime: new Date(Date.now() + 24 * 60 * 60 * 1000),
          bookingId: `RELEVEVENTA${randomUUID()}`.slice(0, 20),
          totalSeats: 2,
          availableSeats: 2,
          pricePerSeat: 200,
        },
      });
      const farRelevantEvent = await prisma.listing.create({
        data: {
          sellerId,
          category: "EVENT",
          movieName: "Arijit Singh Live in Concert",
          theaterName: "Far Arena",
          theaterLat: FAR_LAT,
          theaterLng: LNG,
          showtime: new Date(Date.now() + 24 * 60 * 60 * 1000),
          bookingId: `RELEVEVENTB${randomUUID()}`.slice(0, 20),
          totalSeats: 2,
          availableSeats: 2,
          pricePerSeat: 200,
        },
      });
      const closeIrrelevantSport = await prisma.listing.create({
        data: {
          sellerId,
          category: "SPORT",
          movieName: "Local Football Friendly",
          theaterName: "Nearby Ground",
          theaterLat: CLOSE_LAT,
          theaterLng: LNG,
          showtime: new Date(Date.now() + 24 * 60 * 60 * 1000),
          bookingId: `RELEVSPORTA${randomUUID()}`.slice(0, 20),
          totalSeats: 2,
          availableSeats: 2,
          pricePerSeat: 200,
        },
      });
      const farRelevantSport = await prisma.listing.create({
        data: {
          sellerId,
          category: "SPORT",
          movieName: "India vs Pakistan T20 World Cup",
          theaterName: "Far Stadium",
          theaterLat: FAR_LAT,
          theaterLng: LNG,
          showtime: new Date(Date.now() + 24 * 60 * 60 * 1000),
          bookingId: `RELEVSPORTB${randomUUID()}`.slice(0, 20),
          totalSeats: 2,
          availableSeats: 2,
          pricePerSeat: 200,
        },
      });
      closeIrrelevantEventId = closeIrrelevantEvent.id;
      farRelevantEventId = farRelevantEvent.id;
      closeIrrelevantSportId = closeIrrelevantSport.id;
      farRelevantSportId = farRelevantSport.id;
      listingIds.push(
        closeIrrelevantEventId,
        farRelevantEventId,
        closeIrrelevantSportId,
        farRelevantSportId,
      );
    });

    it("EVENT: a farther but relevant listing outranks a closer, irrelevant one", async () => {
      const res = await request(app)
        .get("/api/listings/search")
        .query({ lat: LAT, lng: LNG, category: "EVENT", movieName: "Arijit Singh" });
      const ids = res.body.data.listings.map((l: { id: string }) => l.id);
      expect(ids).toContain(farRelevantEventId);
      // The irrelevant listing may or may not clear the similarity
      // threshold at all - what matters is that if the relevant one
      // appears, it isn't ranked behind a closer non-match.
      const irrelevantIndex = ids.indexOf(closeIrrelevantEventId);
      const relevantIndex = ids.indexOf(farRelevantEventId);
      if (irrelevantIndex !== -1) expect(relevantIndex).toBeLessThan(irrelevantIndex);
    });

    it("SPORT: a farther but relevant listing outranks a closer, irrelevant one", async () => {
      const res = await request(app)
        .get("/api/listings/search")
        .query({ lat: LAT, lng: LNG, category: "SPORT", movieName: "India vs Pakistan" });
      const ids = res.body.data.listings.map((l: { id: string }) => l.id);
      expect(ids).toContain(farRelevantSportId);
      const irrelevantIndex = ids.indexOf(closeIrrelevantSportId);
      const relevantIndex = ids.indexOf(farRelevantSportId);
      if (irrelevantIndex !== -1) expect(relevantIndex).toBeLessThan(irrelevantIndex);
    });
  });

  describe("POST /api/listings/ocr category branch", () => {
    // Same real ticket screenshot parseListingText.test.ts confirms
    // extracts "Irumudi" as the movie name when run through the full
    // pipeline - category is the only variable here, so a difference in
    // output proves the category branch (not just "this image parses to
    // nothing") is what's doing the work.
    const fixture = fs.readFileSync(
      path.join(__dirname, "../lib/__fixtures__/tickets/irumudi-static-card.jpg"),
    );

    it("MOVIE runs the full parsing pipeline", async () => {
      const res = await request(app)
        .post("/api/listings/ocr")
        .set("Authorization", `Bearer ${sellerToken}`)
        .field("category", "MOVIE")
        .attach("screenshot", fixture, { filename: "ticket.jpg", contentType: "image/jpeg" });
      expect(res.status).toBe(200);
      expect(res.body.data.fields.movieName).not.toBeNull();
      expect((res.body.data.fields.movieName as string).toLowerCase()).toContain("irumudi");
    });

    it("EVENT skips parsing entirely - every field comes back null on the identical image", async () => {
      const res = await request(app)
        .post("/api/listings/ocr")
        .set("Authorization", `Bearer ${sellerToken}`)
        .field("category", "EVENT")
        .attach("screenshot", fixture, { filename: "ticket.jpg", contentType: "image/jpeg" });
      expect(res.status).toBe(200);
      expect(res.body.data.fields).toEqual({
        movieName: null,
        theaterName: null,
        showtime: null,
        totalSeats: null,
        pricePerSeat: null,
        bookingId: null,
        totalAmountPaid: null,
      });
    });

    it("SPORT also skips parsing entirely", async () => {
      const res = await request(app)
        .post("/api/listings/ocr")
        .set("Authorization", `Bearer ${sellerToken}`)
        .field("category", "SPORT")
        .attach("screenshot", fixture, { filename: "ticket.jpg", contentType: "image/jpeg" });
      expect(res.status).toBe(200);
      expect(res.body.data.fields.movieName).toBeNull();
    });
  });
});
