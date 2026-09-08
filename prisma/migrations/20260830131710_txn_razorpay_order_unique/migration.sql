-- NOTE: the auto-generated diff for this migration also proposed dropping
-- "Listing_movieName_trgm_idx" and "Listing_theaterLocation_idx" (same
-- schema-vs-hand-written-SQL drift as prior migrations touching this repo -
-- see 20260830124200_geo_and_trgm_search and 20260830125716_reservations_and_escrow).
-- Deliberately NOT doing that here.

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_razorpayOrderId_key" ON "Transaction"("razorpayOrderId");
