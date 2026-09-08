-- CreateEnum
CREATE TYPE "Category" AS ENUM ('MOVIE', 'EVENT', 'SPORT');

-- AlterTable
-- NOT NULL with a DEFAULT backfills every existing row to MOVIE in the same
-- statement - no separate data migration needed.
ALTER TABLE "Listing" ADD COLUMN     "category" "Category" NOT NULL DEFAULT 'MOVIE';
