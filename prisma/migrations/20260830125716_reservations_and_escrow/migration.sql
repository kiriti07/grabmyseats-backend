-- AlterEnum
ALTER TYPE "TxnStatus" ADD VALUE 'RESERVED';
ALTER TYPE "TxnStatus" ADD VALUE 'EXPIRED';

-- NOTE: the auto-generated diff for this migration also proposed dropping
-- "Listing_movieName_trgm_idx" and "Listing_theaterLocation_idx". Those are
-- hand-written GiST indexes from a prior migration that aren't representable
-- in schema.prisma (see 20260830124200_geo_and_trgm_search), so Prisma's
-- schema-driven diff sees them as drift and wants to drop them. Deliberately
-- NOT doing that here - they're still in use by the search endpoint.

-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "reservedSeats" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "razorpayOrderId" TEXT,
ADD COLUMN     "reservationExpiresAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "razorpayAccountId" TEXT;

-- Speeds up the reservation-expiry cron job's scan for due reservations.
CREATE INDEX IF NOT EXISTS "Transaction_status_reservationExpiresAt_idx"
  ON "Transaction" (status, "reservationExpiresAt")
  WHERE status = 'RESERVED';
