import type { Prisma } from "../generated/prisma/client";

// Gives seatsCount seats back to a listing (availableSeats + reservedSeats)
// and, if the listing's status is currently PARTIALLY_SOLD/SOLD, recomputes
// it from the resulting availableSeats - landing back on PARTIALLY_SOLD
// rather than always forcing ACTIVE, since other seats on the same listing
// can still be genuinely, permanently sold/held elsewhere. FLAGGED/EXPIRED/
// ACTIVE are left untouched. Mirrors the forward transition in POST
// /api/listings/:id/reserve (routes/listings.ts).
//
// Shared by jobs/expireReservations.ts (an unpaid reservation hold timing
// out) and POST /api/admin/transactions/:id/refund (routes/admin.ts, an
// admin refunding a paid/disputed transaction) - kept in one place so the
// two "give seats back" paths can never drift on what that means.
export async function releaseListingSeats(
  tx: Prisma.TransactionClient,
  listingId: string,
  seatsCount: number,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "Listing"
    SET
      "reservedSeats" = GREATEST("reservedSeats" - ${seatsCount}, 0),
      "availableSeats" = LEAST("availableSeats" + ${seatsCount}, "totalSeats"),
      status = CASE
        WHEN status NOT IN ('PARTIALLY_SOLD', 'SOLD') THEN status
        WHEN LEAST("availableSeats" + ${seatsCount}, "totalSeats") >= "totalSeats" THEN 'ACTIVE'
        WHEN LEAST("availableSeats" + ${seatsCount}, "totalSeats") > 0 THEN 'PARTIALLY_SOLD'
        ELSE status
      END
    WHERE id = ${listingId}
  `;
}

// The reverse of releaseListingSeats above: permanently consumes
// seatsCount seats (decrementing availableSeats, recomputing status toward
// PARTIALLY_SOLD/SOLD) instead of giving them back. Used by POST
// /api/listings/:id/mark-sold, where a seller declares seats sold outside
// the app - there's no hold to release here (unlike releaseListingSeats,
// this deliberately never touches reservedSeats), just fewer seats
// available from now on. Atomic and re-checked (status/availableSeats in
// the WHERE clause) so a concurrent reserve or another mark-sold call can't
// oversell; returns whether it actually applied.
export async function consumeListingSeats(
  tx: Prisma.TransactionClient,
  listingId: string,
  seatsCount: number,
): Promise<boolean> {
  const affectedRows = await tx.$executeRaw`
    UPDATE "Listing"
    SET
      "availableSeats" = "availableSeats" - ${seatsCount},
      status = (CASE
        WHEN "availableSeats" - ${seatsCount} <= 0 THEN 'SOLD'
        ELSE 'PARTIALLY_SOLD'
      END)::"ListingStatus"
    WHERE id = ${listingId}
      AND status IN ('ACTIVE', 'PARTIALLY_SOLD')
      AND "availableSeats" >= ${seatsCount}
  `;
  return affectedRows > 0;
}
