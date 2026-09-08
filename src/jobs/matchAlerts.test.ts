import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma";
import { matchAlerts } from "./matchAlerts";

// End-to-end coverage against the real local Postgres - not mocked. This
// file's matchAlerts import gets its own fresh module (vitest isolates
// each test file's module graph by default), so its internal lastCheckedAt
// cursor starts at "now" the moment this file loads - before any listing
// below is created - which is exactly what makes those listings visible to
// the very first matchAlerts() call in this file without needing to poke
// at the cursor directly.
describe("matchAlerts", () => {
  const LAT = 12.9716;
  const LNG = 77.5946;
  // ~20km away - outside a default 7km alert radius, inside a 50km one.
  const FAR_LAT = LAT + 20 / 111;

  let sellerId: string;
  let buyerId: string;
  let buyerPhone: string;
  const listingIds: string[] = [];
  const alertIds: string[] = [];

  beforeAll(async () => {
    const suffix = randomUUID();
    const seller = await prisma.user.create({
      data: { phone: `+1555masseller${suffix}`.slice(0, 30) },
    });
    const buyer = await prisma.user.create({
      data: { phone: `+1555masbuyer${suffix}`.slice(0, 30) },
    });
    sellerId = seller.id;
    buyerId = buyer.id;
    buyerPhone = buyer.phone;
  });

  afterAll(async () => {
    await prisma.alertNotification.deleteMany({ where: { alertId: { in: alertIds } } });
    await prisma.ticketAlert.deleteMany({ where: { id: { in: alertIds } } });
    await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
    await prisma.user.deleteMany({ where: { id: { in: [sellerId, buyerId] } } });
  });

  async function createListing(overrides: {
    movieName: string;
    category?: "MOVIE" | "EVENT" | "SPORT";
    theaterLat?: number;
  }) {
    const listing = await prisma.listing.create({
      data: {
        sellerId,
        category: overrides.category ?? "MOVIE",
        movieName: overrides.movieName,
        theaterName: "Match Alerts Test Theater",
        theaterLat: overrides.theaterLat ?? LAT,
        theaterLng: LNG,
        showtime: new Date(Date.now() + 24 * 60 * 60 * 1000),
        bookingId: `MATCHALERTS${randomUUID()}`.slice(0, 20),
        totalSeats: 2,
        availableSeats: 2,
        pricePerSeat: 200,
      },
    });
    listingIds.push(listing.id);
    return listing;
  }

  async function createAlert(overrides: {
    titleQuery: string;
    category?: "MOVIE" | "EVENT" | "SPORT";
    radiusKm?: number;
    isActive?: boolean;
    expiresAt?: Date;
  }) {
    const alert = await prisma.ticketAlert.create({
      data: {
        userId: buyerId,
        titleQuery: overrides.titleQuery,
        lat: LAT,
        lng: LNG,
        radiusKm: overrides.radiusKm ?? 7,
        category: overrides.category ?? "MOVIE",
        isActive: overrides.isActive ?? true,
        expiresAt: overrides.expiresAt ?? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      },
    });
    alertIds.push(alert.id);
    return alert;
  }

  it("notifies a matching alert and records an AlertNotification", async () => {
    const alert = await createAlert({ titleQuery: "Jawan" });
    const listing = await createListing({ movieName: "Jawan" });

    const count = await matchAlerts();
    expect(count).toBeGreaterThanOrEqual(1);

    const notification = await prisma.alertNotification.findUnique({
      where: { alertId_listingId: { alertId: alert.id, listingId: listing.id } },
    });
    expect(notification).not.toBeNull();
  });

  it("does not match a listing outside the alert's radius", async () => {
    const alert = await createAlert({ titleQuery: "Pathaan", radiusKm: 7 });
    const listing = await createListing({ movieName: "Pathaan", theaterLat: FAR_LAT });

    await matchAlerts();

    const notification = await prisma.alertNotification.findUnique({
      where: { alertId_listingId: { alertId: alert.id, listingId: listing.id } },
    });
    expect(notification).toBeNull();
  });

  it("matches within a wider radius when the alert specifies one", async () => {
    const alert = await createAlert({ titleQuery: "Animal Park", radiusKm: 50 });
    const listing = await createListing({ movieName: "Animal Park", theaterLat: FAR_LAT });

    await matchAlerts();

    const notification = await prisma.alertNotification.findUnique({
      where: { alertId_listingId: { alertId: alert.id, listingId: listing.id } },
    });
    expect(notification).not.toBeNull();
  });

  it("does not match a dissimilar title", async () => {
    const alert = await createAlert({ titleQuery: "Completely Unrelated Show Title" });
    const listing = await createListing({ movieName: "Jawan" });

    await matchAlerts();

    const notification = await prisma.alertNotification.findUnique({
      where: { alertId_listingId: { alertId: alert.id, listingId: listing.id } },
    });
    expect(notification).toBeNull();
  });

  it("does not match across categories", async () => {
    const alert = await createAlert({ titleQuery: "RCB vs CSK", category: "SPORT" });
    const listing = await createListing({ movieName: "RCB vs CSK", category: "MOVIE" });

    await matchAlerts();

    const notification = await prisma.alertNotification.findUnique({
      where: { alertId_listingId: { alertId: alert.id, listingId: listing.id } },
    });
    expect(notification).toBeNull();
  });

  it("does not match an inactive (cancelled) alert", async () => {
    const alert = await createAlert({ titleQuery: "Dunki", isActive: false });
    const listing = await createListing({ movieName: "Dunki" });

    await matchAlerts();

    const notification = await prisma.alertNotification.findUnique({
      where: { alertId_listingId: { alertId: alert.id, listingId: listing.id } },
    });
    expect(notification).toBeNull();
  });

  it("does not match an expired alert", async () => {
    const alert = await createAlert({
      titleQuery: "Salaar",
      expiresAt: new Date(Date.now() - 60 * 1000),
    });
    const listing = await createListing({ movieName: "Salaar" });

    await matchAlerts();

    const notification = await prisma.alertNotification.findUnique({
      where: { alertId_listingId: { alertId: alert.id, listingId: listing.id } },
    });
    expect(notification).toBeNull();
  });

  it("never sends a second notification for a pair already recorded", async () => {
    const alert = await createAlert({ titleQuery: "Leo" });
    const listing = await createListing({ movieName: "Leo" });

    // Simulates "already notified by an earlier run" without waiting for
    // the job's own cursor to naturally move past this listing.
    await prisma.alertNotification.create({
      data: { alertId: alert.id, listingId: listing.id },
    });

    await matchAlerts();

    const notifications = await prisma.alertNotification.findMany({
      where: { alertId: alert.id, listingId: listing.id },
    });
    expect(notifications).toHaveLength(1);
  });

  it("phone used for the SMS is the alert owner's", async () => {
    const alert = await createAlert({ titleQuery: "Stree" });
    await createListing({ movieName: "Stree" });

    await matchAlerts();

    const notification = await prisma.alertNotification.findFirst({
      where: { alertId: alert.id },
      include: { alert: { include: { user: true } } },
    });
    expect(notification?.alert.user.phone).toBe(buyerPhone);
  });
});
