-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('ACTIVE', 'PARTIALLY_SOLD', 'SOLD', 'EXPIRED', 'FLAGGED');

-- CreateEnum
CREATE TYPE "TxnStatus" AS ENUM ('PENDING', 'ESCROWED', 'BUYER_CONFIRMED', 'PAYOUT_RELEASED', 'DISPUTED', 'REFUNDED');

-- DropForeignKey
ALTER TABLE "Event" DROP CONSTRAINT "Event_venueId_fkey";

-- DropForeignKey
ALTER TABLE "Seat" DROP CONSTRAINT "Seat_eventId_fkey";

-- DropIndex
DROP INDEX "User_email_key";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "email",
ADD COLUMN     "phone" TEXT NOT NULL,
ADD COLUMN     "strikes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "trustScore" INTEGER NOT NULL DEFAULT 100;

-- DropTable
DROP TABLE "Event";

-- DropTable
DROP TABLE "Seat";

-- DropTable
DROP TABLE "Venue";

-- DropEnum
DROP TYPE "SeatStatus";

-- CreateTable
CREATE TABLE "Listing" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "movieName" TEXT NOT NULL,
    "theaterName" TEXT NOT NULL,
    "theaterLat" DOUBLE PRECISION NOT NULL,
    "theaterLng" DOUBLE PRECISION NOT NULL,
    "showtime" TIMESTAMP(3) NOT NULL,
    "bookingId" TEXT NOT NULL,
    "totalSeats" INTEGER NOT NULL,
    "availableSeats" INTEGER NOT NULL,
    "pricePerSeat" DOUBLE PRECISION NOT NULL,
    "qrData" TEXT,
    "status" "ListingStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Listing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "seatsCount" INTEGER NOT NULL,
    "amountPaid" DOUBLE PRECISION NOT NULL,
    "status" "TxnStatus" NOT NULL DEFAULT 'PENDING',
    "buyerCheckIn" TIMESTAMP(3),
    "sellerCheckIn" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "payoutAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

