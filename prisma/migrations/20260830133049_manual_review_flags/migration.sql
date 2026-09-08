-- NOTE: the auto-generated diff for this migration also proposed dropping
-- "Listing_movieName_trgm_idx" and "Listing_theaterLocation_idx" (same
-- schema-vs-hand-written-SQL drift as prior migrations - see
-- 20260830124200_geo_and_trgm_search). Deliberately NOT doing that here.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isAdmin" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ManualReviewFlag" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "razorpayOrderId" TEXT NOT NULL,
    "amountPaid" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "ManualReviewFlag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ManualReviewFlag_resolvedAt_idx" ON "ManualReviewFlag"("resolvedAt");

-- AddForeignKey
ALTER TABLE "ManualReviewFlag" ADD CONSTRAINT "ManualReviewFlag_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
