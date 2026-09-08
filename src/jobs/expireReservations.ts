import { prisma } from "../lib/prisma";
import { releaseListingSeats } from "../lib/listingSeats";

interface DueReservation {
  id: string;
}

interface ExpiredClaim {
  listingId: string;
  seatsCount: number;
}

// Expires RESERVED transactions whose hold has passed and gives the seats
// back to the listing. Each candidate is processed in its own short
// transaction with a re-checked, atomic UPDATE - so a transaction that gets
// paid (see POST /api/transactions/:id/pay) in the same instant it would
// otherwise expire is never double-processed by both code paths.
export async function expireReservations(): Promise<number> {
  const due = await prisma.$queryRaw<DueReservation[]>`
    SELECT id FROM "Transaction"
    WHERE status = 'RESERVED' AND "reservationExpiresAt" <= now()
  `;

  let expiredCount = 0;

  for (const { id } of due) {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.$queryRaw<ExpiredClaim[]>`
        UPDATE "Transaction"
        SET status = 'EXPIRED'
        WHERE id = ${id} AND status = 'RESERVED' AND "reservationExpiresAt" <= now()
        RETURNING "listingId", "seatsCount"
      `;

      if (claimed.length === 0) return; // already paid or expired by another run

      const { listingId, seatsCount } = claimed[0];
      await releaseListingSeats(tx, listingId, seatsCount);
      expiredCount += 1;
    });
  }

  return expiredCount;
}
