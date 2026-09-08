import { prisma } from "../lib/prisma";
import { Prisma } from "../generated/prisma/client";
import { smsProvider } from "../lib/sms";
import { TITLE_SIMILARITY_THRESHOLD } from "../lib/searchMatch";

// In-memory cursor rather than a DB-persisted lastCheckedForAlertsAt
// column - reset to "now" on every process start, so a restart only means
// the next run re-scans at most one job interval's worth of listings.
// That overlap is harmless: AlertNotification's (alertId, listingId)
// unique constraint is the actual "never notify twice" guarantee (see the
// NOT EXISTS check below, which just avoids querying rows that would fail
// it), not this cursor - this only exists to keep each run's scan cheap
// (recently-created listings only, not every live one).
let lastCheckedAt = new Date();

interface AlertMatchRow {
  alertId: string;
  phone: string;
}

// Scans Listings created since the last run against active, non-expired
// TicketAlerts: fuzzy title match (same pg_trgm similarity() + threshold
// GET /api/listings/search uses - see lib/searchMatch.ts), same category,
// and within the alert's own radiusKm of the listing. Each surviving match
// gets exactly one SMS via the existing SmsProvider interface, ever.
export async function matchAlerts(): Promise<number> {
  const checkFrom = lastCheckedAt;
  const runStartedAt = new Date();
  // Advanced before processing, not after - so a mid-run failure can never
  // cause the same listings to be rescanned forever. A listing dropped by
  // a failed run just doesn't get a retry for its alerts - the same
  // never-double-act-but-may-miss-under-failure trade-off
  // jobs/expireReservations.ts and friends make elsewhere in this app.
  lastCheckedAt = runStartedAt;

  const newListings = await prisma.listing.findMany({
    where: {
      createdAt: { gt: checkFrom, lte: runStartedAt },
      status: { in: ["ACTIVE", "PARTIALLY_SOLD"] },
    },
    select: { id: true, movieName: true, category: true, theaterLat: true, theaterLng: true },
  });

  let notifiedCount = 0;

  for (const listing of newListings) {
    const origin = Prisma.sql`ST_SetSRID(ST_MakePoint(${listing.theaterLng}, ${listing.theaterLat}), 4326)::geography`;

    const matches = await prisma.$queryRaw<AlertMatchRow[]>`
      SELECT ta.id AS "alertId", u.phone AS phone
      FROM "TicketAlert" ta
      JOIN "User" u ON u.id = ta."userId"
      WHERE ta."isActive" = true
        AND ta."expiresAt" > now()
        AND ta.category = ${listing.category}::"Category"
        AND similarity(ta."titleQuery", ${listing.movieName}) > ${TITLE_SIMILARITY_THRESHOLD}
        AND ST_DWithin(ta."location", ${origin}, ta."radiusKm" * 1000)
        AND NOT EXISTS (
          SELECT 1 FROM "AlertNotification" an
          WHERE an."alertId" = ta.id AND an."listingId" = ${listing.id}
        )
    `;

    for (const match of matches) {
      try {
        await smsProvider.send(
          match.phone,
          `GrabMySeats: a listing matching "${listing.movieName}" just showed up near you. Open the app before it's gone.`,
        );
        // Recorded even if a concurrent run somehow already inserted this
        // exact pair - the unique constraint would reject the duplicate,
        // caught below, without this notify having been a double-send
        // (the SMS itself already went out; the insert failing just means
        // bookkeeping for an SMS that already happened).
        await prisma.alertNotification.create({
          data: { alertId: match.alertId, listingId: listing.id },
        });
        notifiedCount += 1;
      } catch (err) {
        console.error(
          `[jobs] matchAlerts failed for alert ${match.alertId} / listing ${listing.id}`,
          err,
        );
      }
    }
  }

  return notifiedCount;
}
