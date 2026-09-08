-- NOTE: the auto-generated diff for this migration also proposed dropping
-- "Listing_movieName_trgm_idx" and "Listing_theaterLocation_idx" (same
-- schema-vs-hand-written-SQL drift as prior migrations - see
-- 20260830124200_geo_and_trgm_search). Deliberately NOT doing that here.

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "buyerCheckInAt" TIMESTAMP(3),
ADD COLUMN     "buyerCheckInLat" DOUBLE PRECISION,
ADD COLUMN     "buyerCheckInLng" DOUBLE PRECISION,
ADD COLUMN     "sellerCheckInAt" TIMESTAMP(3),
ADD COLUMN     "sellerCheckInLat" DOUBLE PRECISION,
ADD COLUMN     "sellerCheckInLng" DOUBLE PRECISION;
