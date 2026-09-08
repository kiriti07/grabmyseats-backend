-- CreateTable
CREATE TABLE "TicketAlert" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "titleQuery" TEXT NOT NULL,
    "cityId" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "location" geography(Point, 4326),
    "radiusKm" DOUBLE PRECISION NOT NULL DEFAULT 7,
    "category" "Category" NOT NULL DEFAULT 'MOVIE',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertNotification" (
    "id" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "notifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TicketAlert_isActive_expiresAt_idx" ON "TicketAlert"("isActive", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AlertNotification_alertId_listingId_key" ON "AlertNotification"("alertId", "listingId");

-- AddForeignKey
ALTER TABLE "TicketAlert" ADD CONSTRAINT "TicketAlert_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertNotification" ADD CONSTRAINT "AlertNotification_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "TicketAlert"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertNotification" ADD CONSTRAINT "AlertNotification_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The rest of this migration is hand-written, mirroring
-- 20260830124200_geo_and_trgm_search's Listing.theaterLocation setup:
-- Prisma's schema/diff tooling has no concept of triggers or GiST/trigram
-- indexes, so it can't generate this part. Keep that in mind if this
-- migration is ever regenerated from a schema diff.

-- Keep TicketAlert.location in sync with lat/lng automatically, so
-- application code (Prisma Client) never needs to write to it directly.
CREATE OR REPLACE FUNCTION set_ticket_alert_location()
RETURNS trigger AS $$
BEGIN
  NEW."location" := ST_SetSRID(ST_MakePoint(NEW."lng", NEW."lat"), 4326)::geography;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ticket_alert_location ON "TicketAlert";
CREATE TRIGGER trg_ticket_alert_location
BEFORE INSERT OR UPDATE OF "lat", "lng" ON "TicketAlert"
FOR EACH ROW EXECUTE FUNCTION set_ticket_alert_location();

-- Speeds up matchAlerts.ts's ST_DWithin geo filter.
CREATE INDEX IF NOT EXISTS "TicketAlert_location_idx" ON "TicketAlert" USING GIST ("location");

-- Speeds up matchAlerts.ts's similarity() fuzzy matching on titleQuery -
-- same reasoning as Listing_movieName_trgm_idx.
CREATE INDEX IF NOT EXISTS "TicketAlert_titleQuery_trgm_idx" ON "TicketAlert" USING GIST ("titleQuery" gist_trgm_ops);
