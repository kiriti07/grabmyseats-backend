-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "theaterLocation" geography(Point, 4326);

-- The rest of this migration is hand-written: Prisma's schema/diff tooling
-- has no concept of triggers or GiST/trigram indexes, so it can't generate
-- this part. Keep that in mind if this migration is ever regenerated from
-- a schema diff - the pieces below need to be re-added by hand.

-- Backfill theaterLocation for any rows that existed before this migration.
UPDATE "Listing"
SET "theaterLocation" = ST_SetSRID(ST_MakePoint("theaterLng", "theaterLat"), 4326)::geography
WHERE "theaterLocation" IS NULL;

-- Keep theaterLocation in sync with theaterLat/theaterLng automatically,
-- so application code (Prisma Client) never needs to write to it directly.
CREATE OR REPLACE FUNCTION set_listing_theater_location()
RETURNS trigger AS $$
BEGIN
  NEW."theaterLocation" := ST_SetSRID(ST_MakePoint(NEW."theaterLng", NEW."theaterLat"), 4326)::geography;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_listing_theater_location ON "Listing";
CREATE TRIGGER trg_listing_theater_location
BEFORE INSERT OR UPDATE OF "theaterLat", "theaterLng" ON "Listing"
FOR EACH ROW EXECUTE FUNCTION set_listing_theater_location();

-- Speeds up ST_DWithin geo filters.
CREATE INDEX IF NOT EXISTS "Listing_theaterLocation_idx" ON "Listing" USING GIST ("theaterLocation");

-- Speeds up pg_trgm similarity() fuzzy matching on movieName.
CREATE INDEX IF NOT EXISTS "Listing_movieName_trgm_idx" ON "Listing" USING GIST ("movieName" gist_trgm_ops);
