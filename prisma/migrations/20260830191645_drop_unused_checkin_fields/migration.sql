-- NOTE: the auto-generated diff for this migration also proposed dropping
-- "Listing_movieName_trgm_idx" and "Listing_theaterLocation_idx" (same
-- schema-vs-hand-written-SQL drift as prior migrations - see
-- 20260830124200_geo_and_trgm_search). Deliberately NOT doing that here.

-- Dropping Transaction.buyerCheckIn/sellerCheckIn: unused since the
-- original schema (superseded by buyerCheckInAt/sellerCheckInAt, added in
-- 20260830190705_transaction_checkin_geo). Confirmed no application code
-- referenced them before dropping.

-- AlterTable
ALTER TABLE "Transaction" DROP COLUMN "buyerCheckIn",
DROP COLUMN "sellerCheckIn";
