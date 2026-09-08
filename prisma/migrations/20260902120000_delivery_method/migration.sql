-- NOTE: the auto-generated diff for this migration would also propose
-- dropping "Listing_movieName_trgm_idx" and "Listing_theaterLocation_idx"
-- (same schema-vs-hand-written-SQL drift as prior migrations - see
-- 20260830124200_geo_and_trgm_search). Deliberately NOT doing that here.

-- CreateEnum
CREATE TYPE "DeliveryMethod" AS ENUM ('IN_PERSON', 'EMAIL_FORWARD');

-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "availableDeliveryMethods" "DeliveryMethod"[] NOT NULL DEFAULT ARRAY['IN_PERSON']::"DeliveryMethod"[];

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "deliveryMethod" "DeliveryMethod" NOT NULL DEFAULT 'IN_PERSON',
ADD COLUMN     "emailForwardFileUrl" TEXT,
ADD COLUMN     "emailForwardText" TEXT,
ADD COLUMN     "emailForwardSubmittedAt" TIMESTAMP(3);
