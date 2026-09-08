import { randomUUID } from "node:crypto";
import { Router } from "express";
import type {
  ApiResponse,
  Category,
  DeliveryMethod,
  GeocodePreview,
  Listing as SharedListing,
  ListingDetail,
  ListingSearchResult,
  MyListing,
  OcrExtractedFields,
  OcrResult,
  ReserveResult,
  TransactionContact,
} from "@grabmyseats/shared";
import { LIVE_LISTING_STATUSES } from "@grabmyseats/shared";
import { TITLE_SIMILARITY_THRESHOLD } from "../lib/searchMatch";
import { prisma } from "../lib/prisma";
import { Prisma } from "../generated/prisma/client";
import { PAYMENT_MODE } from "../lib/config";
import { storageProvider } from "../lib/storage";
import { geocodeAddress } from "../lib/geocode";
import { cleanTheaterName } from "../lib/geo/cleanTheaterName";
import { haversineDistanceMeters } from "../lib/geo/haversine";
import { extractTextFromImage } from "../lib/ocr";
import { decodeQrCode } from "../lib/qr";
import { parseListingText } from "../lib/parseListingText";
import { getSellerDeliveryEligibility } from "../lib/sellerTrust";
import { consumeListingSeats } from "../lib/listingSeats";
import { getRatingSummary } from "../lib/ratingSummary";
import {
  toListingDetail,
  toMyListing,
  toSharedListing,
  toSharedTransaction,
} from "../lib/serialize";
import { requireAuth } from "../middleware/auth";
import { uploadScreenshot } from "../middleware/upload";

const ALL_DELIVERY_METHODS: DeliveryMethod[] = ["IN_PERSON", "EMAIL_FORWARD"];
const ALL_CATEGORIES: Category[] = ["MOVIE", "EVENT", "SPORT"];

// Not sent (or malformed) falls back to MOVIE - existing rows and every
// caller written before this feature default the same way (see the
// migration and Listing.category's @default(MOVIE)).
function parseCategory(value: unknown): Category {
  return typeof value === "string" && ALL_CATEGORIES.includes(value as Category)
    ? (value as Category)
    : "MOVIE";
}

// Parses availableDeliveryMethods off a multipart body: the sell form sends
// it as a JSON-stringified array (multipart fields are otherwise always
// strings). Returns null on anything malformed/empty so the caller can
// treat that as "not sent" and fall back to the IN_PERSON-only default,
// same graceful-degradation pattern as the OCR-sourced fields on this form.
function parseDeliveryMethods(value: unknown): DeliveryMethod[] | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const methods = [...new Set(parsed)];
  const allValid = methods.every((m): m is DeliveryMethod =>
    ALL_DELIVERY_METHODS.includes(m as DeliveryMethod),
  );
  return allValid ? (methods as DeliveryMethod[]) : null;
}

export const listingsRouter = Router();

// ₹ - rounding and OCR-figure precision noise, not a loophole for actually
// overpricing a listing. See the price-integrity check in POST "/" below.
const PRICE_INTEGRITY_TOLERANCE = 10;

function requireNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Accepts a real number (JSON bodies) or a numeric string (multipart bodies,
// query strings) since this helper is reused across all three.
//
// Deliberately rejects blank/whitespace-only strings even though
// `Number("")` itself is 0, not NaN - without this a field left empty
// (e.g. a lat/lng that failed to populate) would silently resolve to a
// "valid" 0 instead of failing validation.
function requireFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

listingsRouter.post("/", requireAuth, uploadScreenshot, async (req, res) => {
  const category = parseCategory(req.body?.category);
  const movieName = requireNonEmptyString(req.body?.movieName);
  const theaterName = requireNonEmptyString(req.body?.theaterName);
  // Optional hint used only to disambiguate the geocoding query below
  // (e.g. two "PVR" theaters in different cities) - not stored.
  const city = requireNonEmptyString(req.body?.city);
  const bookingId = requireNonEmptyString(req.body?.bookingId);
  const totalSeats = requireFiniteNumber(req.body?.totalSeats);
  const pricePerSeat = requireFiniteNumber(req.body?.pricePerSeat);
  // Optional: what the booking confirmation showed as actually paid (OCR'd,
  // or seller-corrected on the sell form). null covers both "not sent" and
  // "sent but not a valid number" - either way there's nothing to check
  // against, so the price-integrity check below is skipped rather than
  // treated as a validation error, same graceful-degradation pattern as
  // every other OCR-sourced field on this form.
  const totalAmountPaid = requireFiniteNumber(req.body?.totalAmountPaid);
  const showtimeRaw = requireNonEmptyString(req.body?.showtime);
  const showtime = showtimeRaw ? new Date(showtimeRaw) : null;

  // theaterLat/theaterLng can be supplied directly by a caller that already
  // has them (e.g. a future map-pin picker); otherwise they're resolved
  // server-side from theaterName via geocodeAddress once the rest of the
  // form validates, so sellers only ever have to type a theater name.
  let theaterLat = requireFiniteNumber(req.body?.theaterLat);
  let theaterLng = requireFiniteNumber(req.body?.theaterLng);
  const coordsSupplied = req.body?.theaterLat !== undefined || req.body?.theaterLng !== undefined;

  // Not sent (or malformed) falls back to IN_PERSON-only, same as the
  // pre-delivery-method behavior - the sell form always sends this, but a
  // caller hitting this endpoint directly shouldn't get a hard validation
  // error over an optional-with-a-safe-default field.
  const availableDeliveryMethods = parseDeliveryMethods(req.body?.availableDeliveryMethods) ?? [
    "IN_PERSON",
  ];

  const errors: string[] = [];
  if (!movieName) errors.push("movieName is required");
  if (!theaterName) errors.push("theaterName is required");
  if (!bookingId) errors.push("bookingId is required");
  if (coordsSupplied) {
    if (theaterLat === null || theaterLat < -90 || theaterLat > 90) {
      errors.push("theaterLat must be a number between -90 and 90");
    }
    if (theaterLng === null || theaterLng < -180 || theaterLng > 180) {
      errors.push("theaterLng must be a number between -180 and 180");
    }
  }
  if (totalSeats === null || totalSeats <= 0 || !Number.isInteger(totalSeats)) {
    errors.push("totalSeats must be a positive integer");
  }
  if (pricePerSeat === null || pricePerSeat <= 0) {
    errors.push("pricePerSeat must be a positive number");
  }
  if (!showtime || Number.isNaN(showtime.getTime())) {
    errors.push("showtime must be a valid date");
  }
  if (!req.file) {
    errors.push("screenshot (booking confirmation image) is required");
  }

  // Never trust the client-side version of this check (see the sell
  // form's own pre-submit comparison) - it's trivially bypassed by calling
  // this endpoint directly. Only enforced when totalAmountPaid is actually
  // known; tolerance absorbs rounding and the OCR's own ₹-figure precision
  // noise, not meant to paper over a genuinely inflated listing.
  if (
    totalAmountPaid !== null &&
    totalSeats !== null &&
    pricePerSeat !== null &&
    pricePerSeat * totalSeats > totalAmountPaid + PRICE_INTEGRITY_TOLERANCE
  ) {
    const listedTotal = pricePerSeat * totalSeats;
    errors.push(
      `Your listed price (₹${listedTotal.toFixed(2)} total) is higher than what you paid for this ticket (₹${totalAmountPaid.toFixed(2)}) — sellers can only recover up to what they originally paid.`,
    );
  }

  if (errors.length > 0) {
    const body: ApiResponse<never> = { success: false, error: errors.join("; ") };
    res.status(400).json(body);
    return;
  }

  // Trust gate: EMAIL_FORWARD is only offerable by sellers with a track
  // record - see lib/sellerTrust.ts. Never trust a client-side check here
  // either, same reasoning as the price-integrity check above.
  if (availableDeliveryMethods.includes("EMAIL_FORWARD")) {
    const eligibility = await getSellerDeliveryEligibility(req.user!.id);
    if (!eligibility.emailForwardEligible) {
      const body: ApiResponse<never> = {
        success: false,
        error: `Email-forward delivery isn't available yet - it unlocks after ${eligibility.requiredCompletedSales} completed sales with no unresolved review flags (you have ${eligibility.completedSales}).`,
      };
      res.status(403).json(body);
      return;
    }
  }

  if (!coordsSupplied) {
    // The sell form is expected to have already resolved and confirmed
    // coordinates via POST /geocode (or the manual venue picker) before
    // ever reaching this endpoint - this is a fallback for callers that
    // skip that step entirely.
    const query = [cleanTheaterName(theaterName!), city, "India"].filter(Boolean).join(", ");
    const geocoded = await geocodeAddress(query);
    if (!geocoded) {
      const body: ApiResponse<never> = {
        success: false,
        error: "Could not locate that theater. Check the spelling, or include the city.",
      };
      res.status(422).json(body);
      return;
    }
    theaterLat = geocoded.lat;
    theaterLng = geocoded.lng;
  }

  // Belt-and-suspenders: by this point theaterLat/theaterLng must have come
  // from either the validated coordsSupplied branch or a successful
  // geocodeAddress() call, both of which guarantee finite in-range values -
  // but trusting that invariant with a bare `!` assertion is exactly how a
  // future change to either branch would turn into an uncaught 500 here
  // instead of a clear 400. Fails loud and clean if it's ever wrong.
  if (
    theaterLat === null ||
    theaterLng === null ||
    !Number.isFinite(theaterLat) ||
    !Number.isFinite(theaterLng)
  ) {
    const body: ApiResponse<never> = {
      success: false,
      error: "Invalid location data for this listing. Please re-select the venue and try again.",
    };
    res.status(400).json(body);
    return;
  }

  const filename = `${req.user!.id}-${randomUUID()}`;
  const { url: screenshotUrl } = await storageProvider.upload(req.file!.buffer, filename);

  // Set only when the client forwards a value it already decoded (see
  // POST /ocr below) - never parsed or validated, just stored as-is.
  const qrData = requireNonEmptyString(req.body?.qrData);

  let listing;
  try {
    listing = await prisma.listing.create({
      data: {
        sellerId: req.user!.id,
        category,
        movieName: movieName!,
        theaterName: theaterName!,
        theaterLat,
        theaterLng,
        showtime: showtime!,
        bookingId: bookingId!,
        totalSeats: totalSeats!,
        availableSeats: totalSeats!,
        pricePerSeat: pricePerSeat!,
        totalAmountPaid,
        screenshotUrl,
        qrData,
        availableDeliveryMethods,
      },
    });
  } catch (err) {
    // The theaterLocation trigger (see migration 20260830124200) is the
    // one place a structurally "valid" lat/lng pair could still fail at
    // the DB layer - surface that as a clean 400 instead of the generic
    // error handler's 500.
    console.error("Failed to create listing with theaterLat/theaterLng", {
      theaterLat,
      theaterLng,
      err,
    });
    const body: ApiResponse<never> = {
      success: false,
      error: "Could not save this listing's location. Please re-select the venue and try again.",
    };
    res.status(400).json(body);
    return;
  }

  const body: ApiResponse<{ listing: SharedListing }> = {
    success: true,
    data: { listing: toSharedListing(listing) },
  };
  res.status(201).json(body);
});

// Runs OCR + QR decoding on a ticket screenshot and returns best-effort
// pre-fill values for the /sell form. Never creates a listing itself -
// the seller still has to review and submit via POST "/" above. Reuses
// uploadScreenshot so this only ever accepts the same image/8MB
// constraints as listing creation.
// EVENT/SPORT tickets don't share the movie-poster-ticket layout
// parseListingText.ts's heuristics are tuned against - a poster
// thumbnail in the corner (cropPosterRegion), cinema-brand keywords for
// theaterName, a title heuristic that strips certification tags and
// excludes "Screen N" lines. Rather than force those onto a different
// ticket format, this returns an all-null fields object for non-MOVIE
// categories - the seller just types everything in. QR decoding is
// unaffected either way (it isn't OCR/text-heuristic based).
const EMPTY_OCR_FIELDS: OcrExtractedFields = {
  movieName: null,
  theaterName: null,
  showtime: null,
  totalSeats: null,
  pricePerSeat: null,
  bookingId: null,
  totalAmountPaid: null,
};

listingsRouter.post("/ocr", requireAuth, uploadScreenshot, async (req, res) => {
  if (!req.file) {
    const body: ApiResponse<never> = { success: false, error: "screenshot is required" };
    res.status(400).json(body);
    return;
  }

  const category = parseCategory(req.body?.category);
  const isMovie = category === "MOVIE";

  const [extraction, qrData] = await Promise.all([
    extractTextFromImage(req.file.buffer, { skipPosterCrop: !isMovie }).catch(() => ({
      text: "",
      lines: [],
    })),
    decodeQrCode(req.file.buffer).catch(() => null),
  ]);

  const fields = isMovie ? parseListingText(extraction.text, extraction.lines) : EMPTY_OCR_FIELDS;

  const body: ApiResponse<OcrResult> = {
    success: true,
    data: { fields, qrData },
  };
  res.json(body);
});

// Previews where a theater name + city would resolve to, so the sell form
// can show the seller "Located: X" for confirmation before they submit,
// instead of only finding out about a geocoding failure at creation time.
// found=false is a normal outcome (200), not an error - the frontend uses
// it to fall back to a manual venue picker, seeded with cleanedName.
listingsRouter.post("/geocode", requireAuth, async (req, res) => {
  const theaterName = requireNonEmptyString(req.body?.theaterName);
  const city = requireNonEmptyString(req.body?.city);

  if (!theaterName) {
    const body: ApiResponse<never> = { success: false, error: "theaterName is required" };
    res.status(400).json(body);
    return;
  }

  const cleanedName = cleanTheaterName(theaterName);
  const query = [cleanedName, city, "India"].filter(Boolean).join(", ");
  const geocoded = await geocodeAddress(query);

  const data: GeocodePreview = geocoded
    ? { found: true, lat: geocoded.lat, lng: geocoded.lng, displayName: geocoded.displayName, cleanedName }
    : { found: false, lat: null, lng: null, displayName: null, cleanedName };

  const body: ApiResponse<GeocodePreview> = { success: true, data };
  res.json(body);
});

const ACTIVE_STATUSES = Prisma.sql`('ACTIVE', 'PARTIALLY_SOLD')`;
const DEFAULT_RADIUS_KM = 7;
// EVENT/SPORT venues (a stadium, an arena) are far sparser than movie
// theaters and buyers are typically willing to travel much further for a
// specific show or match - a tight movie-theater radius would hide most
// of what's actually out there. Effectively city-wide for a typical
// Indian metro. Only applies as a *default* - an explicit radiusKm param
// always wins, for either category.
const WIDE_RADIUS_KM = 50;
const DEFAULT_MIN_SEATS = 1;
const RESULT_LIMIT = 50;

interface ListingSearchRow {
  id: string;
  movieName: string;
  theaterName: string;
  showtime: Date;
  availableSeats: number;
  pricePerSeat: number;
  distanceKm: number;
}

// Mounted before any future `/:id` route so it isn't shadowed by a param match.
listingsRouter.get("/search", async (req, res) => {
  const errors: string[] = [];

  const lat = requireFiniteNumber(req.query.lat);
  const lng = requireFiniteNumber(req.query.lng);
  if (lat === null || lat < -90 || lat > 90) {
    errors.push("lat is required and must be a number between -90 and 90");
  }
  if (lng === null || lng < -180 || lng > 180) {
    errors.push("lng is required and must be a number between -180 and 180");
  }

  // Not sent (or "ALL") means every category - the buy page's category
  // tabs are the only caller, and "All" there just omits this param.
  // Parsed before radiusKm below since the default radius depends on it.
  let category: Category | undefined;
  if (typeof req.query.category === "string" && req.query.category.trim() !== "") {
    if (!ALL_CATEGORIES.includes(req.query.category as Category)) {
      errors.push(`category must be one of ${ALL_CATEGORIES.join(", ")}`);
    } else {
      category = req.query.category as Category;
    }
  }
  const isWideRadiusCategory = category === "EVENT" || category === "SPORT";

  let radiusKm = isWideRadiusCategory ? WIDE_RADIUS_KM : DEFAULT_RADIUS_KM;
  if (typeof req.query.radiusKm === "string" && req.query.radiusKm.trim() !== "") {
    const parsed = requireFiniteNumber(req.query.radiusKm);
    if (parsed === null || parsed <= 0) {
      errors.push("radiusKm must be a positive number");
    } else {
      radiusKm = parsed;
    }
  }

  let minSeats = DEFAULT_MIN_SEATS;
  if (typeof req.query.minSeats === "string" && req.query.minSeats.trim() !== "") {
    const parsed = requireFiniteNumber(req.query.minSeats);
    if (parsed === null || parsed < 0 || !Number.isInteger(parsed)) {
      errors.push("minSeats must be a non-negative integer");
    } else {
      minSeats = parsed;
    }
  }

  let showtimeFrom: Date | undefined;
  if (typeof req.query.showtimeFrom === "string" && req.query.showtimeFrom.trim() !== "") {
    const d = new Date(req.query.showtimeFrom);
    if (Number.isNaN(d.getTime())) errors.push("showtimeFrom must be a valid date");
    else showtimeFrom = d;
  }

  let showtimeTo: Date | undefined;
  if (typeof req.query.showtimeTo === "string" && req.query.showtimeTo.trim() !== "") {
    const d = new Date(req.query.showtimeTo);
    if (Number.isNaN(d.getTime())) errors.push("showtimeTo must be a valid date");
    else showtimeTo = d;
  }

  const movieName = requireNonEmptyString(req.query.movieName);

  if (errors.length > 0) {
    const body: ApiResponse<never> = { success: false, error: errors.join("; ") };
    res.status(400).json(body);
    return;
  }

  const radiusMeters = radiusKm * 1000;
  const origin = Prisma.sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography`;

  const conditions: Prisma.Sql[] = [
    Prisma.sql`status IN ${ACTIVE_STATUSES}`,
    Prisma.sql`"availableSeats" >= ${minSeats}`,
    Prisma.sql`"theaterLocation" IS NOT NULL`,
    Prisma.sql`ST_DWithin("theaterLocation", ${origin}, ${radiusMeters})`,
    // A suspended seller's listings never surface here, full stop - see
    // the matching checks on GET /:id and POST /:id/reserve, which close
    // the direct-link/bookmark gap this alone doesn't cover.
    Prisma.sql`NOT EXISTS (
      SELECT 1 FROM "User" WHERE "User".id = "Listing"."sellerId" AND "User"."suspendedAt" IS NOT NULL
    )`,
  ];
  // Matches on either field - the search box (and the autocomplete
  // suggestions drawn from these same results) is a single free-text box
  // labeled "Search movies or theaters", not two separate fields.
  if (movieName) {
    conditions.push(
      Prisma.sql`(similarity("movieName", ${movieName}) > ${TITLE_SIMILARITY_THRESHOLD} OR similarity("theaterName", ${movieName}) > ${TITLE_SIMILARITY_THRESHOLD})`,
    );
  }
  if (category) conditions.push(Prisma.sql`category = ${category}::"Category"`);
  if (showtimeFrom) conditions.push(Prisma.sql`showtime >= ${showtimeFrom}`);
  if (showtimeTo) conditions.push(Prisma.sql`showtime <= ${showtimeTo}`);

  // MOVIE (and no-category/"All") search stays distance-ascending - movie
  // theaters are dense enough that "nearest first" is the useful order.
  // EVENT/SPORT venues are sparse and the radius is already wide (see
  // WIDE_RADIUS_KM above), so distance stops being the meaningful signal -
  // title/venue relevance to the search term leads instead (whichever
  // field matched best), with distance only as a tiebreaker. similarity()
  // against an empty string (no movieName param given) scores every row 0,
  // so this degrades to plain distance-ascending when there's nothing to
  // rank relevance against - no separate branch needed for that case.
  const orderClause = isWideRadiusCategory
    ? Prisma.sql`ORDER BY GREATEST(similarity("movieName", ${movieName ?? ""}), similarity("theaterName", ${movieName ?? ""})) DESC, "distanceKm" ASC`
    : Prisma.sql`ORDER BY "distanceKm" ASC`;

  // screenshotUrl is deliberately not selected here - it's the buyer's
  // proof-of-purchase (and exposes the QR code + booking ID), so it's only
  // ever revealed via GET /api/transactions/:id/screenshot post-purchase.
  const rows = await prisma.$queryRaw<ListingSearchRow[]>`
    SELECT
      id,
      "movieName",
      "theaterName",
      showtime,
      "availableSeats",
      "pricePerSeat",
      ST_Distance("theaterLocation", ${origin}) / 1000 AS "distanceKm"
    FROM "Listing"
    WHERE ${Prisma.join(conditions, " AND ")}
    ${orderClause}
    LIMIT ${RESULT_LIMIT}
  `;

  const results: ListingSearchResult[] = rows.map((row) => ({
    id: row.id,
    movieName: row.movieName,
    theaterName: row.theaterName,
    showtime: row.showtime.toISOString(),
    availableSeats: row.availableSeats,
    pricePerSeat: row.pricePerSeat,
    distanceKm: row.distanceKm,
  }));

  const body: ApiResponse<{ listings: ListingSearchResult[] }> = {
    success: true,
    data: { listings: results },
  };
  res.json(body);
});

// Mounted before GET "/:id" so "mine" isn't swallowed by the :id param.
listingsRouter.get("/mine", requireAuth, async (req, res) => {
  const listings = await prisma.listing.findMany({
    where: { sellerId: req.user!.id },
    include: { transactions: true },
    orderBy: { createdAt: "desc" },
  });

  const body: ApiResponse<{ listings: MyListing[] }> = {
    success: true,
    data: { listings: listings.map(toMyListing) },
  };
  res.json(body);
});

// Public detail view for a single listing - same public-safe fields as
// /search, plus totalSeats/status. lat/lng are optional: pass them (e.g.
// forwarded from the search page's resolved location) to get distanceKm
// back too; omit them for a direct link, where distanceKm comes back null.
listingsRouter.get("/:id", async (req, res) => {
  const listingId = req.params.id as string;
  const lat = requireFiniteNumber(req.query.lat);
  const lng = requireFiniteNumber(req.query.lng);

  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    include: { seller: { select: { suspendedAt: true } } },
  });
  // A suspended seller's listing is treated as if it doesn't exist at all
  // (not a distinct error) - same "hide/exclude them anywhere" reasoning
  // as the search filter above, applied here to close the direct-link/
  // bookmark gap that filter alone can't cover, and deliberately not
  // revealing anything about *why* to a buyer who happens to have the URL.
  if (!listing || listing.seller.suspendedAt) {
    const body: ApiResponse<never> = { success: false, error: "Listing not found" };
    res.status(404).json(body);
    return;
  }

  const distanceKm =
    lat !== null && lng !== null
      ? haversineDistanceMeters(lat, lng, listing.theaterLat, listing.theaterLng) / 1000
      : null;

  const sellerRatingSummary = await getRatingSummary(listing.sellerId);

  const body: ApiResponse<{ listing: ListingDetail }> = {
    success: true,
    data: { listing: toListingDetail(listing, distanceKm, sellerRatingSummary) },
  };
  res.json(body);
});

const RESERVATION_HOLD_MINUTES = 3;

class ListingNotFoundError extends Error {}
class InsufficientSeatsError extends Error {}
class CannotReserveOwnListingError extends Error {}
class DeliveryMethodNotOfferedError extends Error {}

interface ReservationLockRow {
  id: string;
  pricePerSeat: number;
  sellerId: string;
  availableDeliveryMethods: DeliveryMethod[];
}

listingsRouter.post("/:id/reserve", requireAuth, async (req, res) => {
  const listingId = req.params.id as string;
  const seats = requireFiniteNumber(req.body?.seats);
  const requestedDeliveryMethod =
    typeof req.body?.deliveryMethod === "string" &&
    ALL_DELIVERY_METHODS.includes(req.body.deliveryMethod as DeliveryMethod)
      ? (req.body.deliveryMethod as DeliveryMethod)
      : null;

  const errors: string[] = [];
  if (seats === null || seats <= 0 || !Number.isInteger(seats)) {
    errors.push("seats must be a positive integer");
  }
  // Delivery method only matters in escrow mode - it drives which
  // check-in/email-forward machinery confirm-receipt gates on, none of
  // which exists in contact_only mode, so it's not collected from the
  // buyer there at all (see the PAYMENT_MODE branch below).
  if (PAYMENT_MODE === "escrow" && !requestedDeliveryMethod) {
    errors.push(`deliveryMethod must be one of ${ALL_DELIVERY_METHODS.join(", ")}`);
  }
  if (errors.length > 0) {
    const body: ApiResponse<never> = { success: false, error: errors.join("; ") };
    res.status(400).json(body);
    return;
  }

  try {
    const { transaction, sellerId } = await prisma.$transaction(async (tx) => {
      let pricePerSeat: number;
      let sellerId: string;
      let availableDeliveryMethods: DeliveryMethod[];

      if (PAYMENT_MODE === "escrow") {
        // Atomic: the WHERE clause is re-checked as part of the row write,
        // so two concurrent reservations on the same listing serialize
        // correctly instead of both reading a stale seat count and
        // overbooking.
        //
        // availableSeats is decremented here too (not just reservedSeats)
        // so it reflects "not currently reservable" the moment a hold is
        // taken - this is what GET /api/listings/search filters on, and a
        // listing mid-checkout by someone else shouldn't show up as
        // available to a second buyer even before payment lands.
        // reservedSeats keeps its existing meaning (seats under an active
        // unpaid hold) and is what the expiry job below uses to give
        // availableSeats back. status uses the same PARTIALLY_SOLD/SOLD
        // labels the seller dashboard shows even though payment hasn't
        // been confirmed yet - see the status CASE in
        // jobs/expireReservations.ts for the reverse transition.
        //
        // contact_only mode does NOT do any of this (see the branch
        // below) - "reserving" there is really just requesting contact
        // info, and nothing about it should ever make the listing look
        // less available. Only POST /:id/mark-sold, which the seller
        // triggers deliberately once a sale has actually happened, is
        // allowed to touch availableSeats/status in that mode.
        const locked = await tx.$queryRaw<ReservationLockRow[]>`
          UPDATE "Listing"
          SET
            "reservedSeats" = "reservedSeats" + ${seats},
            "availableSeats" = "availableSeats" - ${seats},
            status = (CASE
              WHEN "availableSeats" - ${seats} <= 0 THEN 'SOLD'
              ELSE 'PARTIALLY_SOLD'
            END)::"ListingStatus"
          WHERE id = ${listingId}
            AND status IN ${ACTIVE_STATUSES}
            AND "availableSeats" >= ${seats}
          RETURNING id, "pricePerSeat", "sellerId", "availableDeliveryMethods"
        `;

        if (locked.length === 0) {
          const listing = await tx.listing.findUnique({
            where: { id: listingId },
            select: { id: true },
          });
          if (!listing) throw new ListingNotFoundError();
          throw new InsufficientSeatsError();
        }

        ({ pricePerSeat, sellerId, availableDeliveryMethods } = locked[0]);
      } else {
        // contact_only: a plain read-only check, same ACTIVE_STATUSES/
        // enough-seats conditions as the escrow lock above (a listing the
        // seller already marked fully sold, or otherwise took down,
        // still shouldn't hand out contact info) - but no UPDATE at all.
        // Any number of buyers can request contact for the same listing
        // without "locking" anything, since nothing is actually being
        // held; this is exactly the bug this branch fixes (contacting a
        // seller used to permanently hide the listing from search even
        // when no sale happened).
        const listing = await tx.listing.findFirst({
          where: {
            id: listingId,
            status: { in: LIVE_LISTING_STATUSES },
            availableSeats: { gte: seats! },
          },
          select: { pricePerSeat: true, sellerId: true, availableDeliveryMethods: true },
        });

        if (!listing) {
          const exists = await tx.listing.findUnique({
            where: { id: listingId },
            select: { id: true },
          });
          if (!exists) throw new ListingNotFoundError();
          throw new InsufficientSeatsError();
        }

        ({ pricePerSeat, sellerId, availableDeliveryMethods } = listing);
      }

      if (sellerId === req.user!.id) throw new CannotReserveOwnListingError();

      // Same "hide/exclude them anywhere" reasoning as the search filter
      // and GET /:id above - closes the gap where a buyer got this far
      // (e.g. a link opened just before the seller was suspended) before
      // any money/contact info changes hands. In escrow mode, throwing
      // here also rolls back the seat-lock UPDATE above via the enclosing
      // $transaction, so a failed reserve never leaves seats stuck as
      // held (contact_only mode has no such lock to roll back).
      const seller = await tx.user.findUniqueOrThrow({
        where: { id: sellerId },
        select: { suspendedAt: true },
      });
      if (seller.suspendedAt) throw new ListingNotFoundError();

      // contact_only mode never asked the buyer for a delivery method (see
      // above), so it isn't validated against the listing's offered
      // methods either - deliveryMethod is stored as IN_PERSON purely
      // because the column is non-nullable, not because it's meaningful in
      // this mode.
      const deliveryMethod: DeliveryMethod =
        PAYMENT_MODE === "escrow" ? requestedDeliveryMethod! : "IN_PERSON";
      if (PAYMENT_MODE === "escrow" && !availableDeliveryMethods.includes(deliveryMethod)) {
        // Never trust the client's choice of method beyond it being a
        // valid enum value (checked above) - it must also be one this
        // listing actually offers. Re-checked against the row just locked,
        // not a pre-transaction read, so this can't be bypassed by a stale
        // value.
        throw new DeliveryMethodNotOfferedError();
      }

      const transaction = await tx.transaction.create({
        data: {
          listingId,
          buyerId: req.user!.id,
          seatsCount: seats!,
          amountPaid: pricePerSeat * seats!,
          status: "RESERVED",
          deliveryMethod,
          // No hold-expiry in contact_only mode - there's no payment step
          // to time out, so nothing about this reservation is meant to
          // resolve on its own. It stays RESERVED until the seller
          // finalizes it (or not) via POST /:id/mark-sold once they've
          // actually been paid outside the app. jobs/expireReservations.ts's
          // query (`WHERE ... "reservationExpiresAt" <= now()`) naturally
          // never selects a null value here.
          reservationExpiresAt:
            PAYMENT_MODE === "escrow"
              ? new Date(Date.now() + RESERVATION_HOLD_MINUTES * 60 * 1000)
              : null,
        },
      });

      return { transaction, sellerId };
    });

    // contact_only mode hands the seller's contact info straight back here
    // instead of gating it behind escrow + a showtime window (see GET
    // /api/transactions/:id/contact for the escrow-mode equivalent, whose
    // window check is itself skipped in this mode).
    let contact: TransactionContact | null = null;
    if (PAYMENT_MODE === "contact_only") {
      const seller = await prisma.user.findUniqueOrThrow({
        where: { id: sellerId },
        select: { name: true, phone: true, hasWhatsapp: true },
      });
      contact = {
        name: seller.name,
        phone: seller.phone,
        hasWhatsapp: seller.hasWhatsapp,
        ratingSummary: await getRatingSummary(sellerId),
      };
    }

    const body: ApiResponse<ReserveResult> = {
      success: true,
      data: { transaction: toSharedTransaction(transaction), contact, paymentMode: PAYMENT_MODE },
    };
    res.status(201).json(body);
  } catch (err) {
    if (err instanceof ListingNotFoundError) {
      const body: ApiResponse<never> = { success: false, error: "Listing not found" };
      res.status(404).json(body);
      return;
    }
    if (err instanceof InsufficientSeatsError) {
      const body: ApiResponse<never> = {
        success: false,
        error: "Not enough seats available",
      };
      res.status(409).json(body);
      return;
    }
    if (err instanceof DeliveryMethodNotOfferedError) {
      const body: ApiResponse<never> = {
        success: false,
        error: "This listing doesn't offer that delivery method",
      };
      res.status(409).json(body);
      return;
    }
    if (err instanceof CannotReserveOwnListingError) {
      const body: ApiResponse<never> = {
        success: false,
        error: "You cannot reserve your own listing",
      };
      res.status(400).json(body);
      return;
    }
    throw err;
  }
});

class NotListingOwnerError extends Error {}

// Lets a seller manually mark seats on their own listing as sold once
// they've arranged payment directly with a buyer outside the app -
// primarily for PAYMENT_MODE=contact_only (see lib/config.ts), where that's
// the normal way a reservation gets finalized, but not gated to that mode:
// a seller can always have sold seats outside the platform regardless of
// mode. Deliberately not tied to any specific Transaction/reservation -
// see consumeListingSeats in lib/listingSeats.ts (the reverse of
// releaseListingSeats) for exactly what it updates.
listingsRouter.post("/:id/mark-sold", requireAuth, async (req, res) => {
  const listingId = req.params.id as string;
  const seats = requireFiniteNumber(req.body?.seats);

  if (seats === null || seats <= 0 || !Number.isInteger(seats)) {
    const body: ApiResponse<never> = {
      success: false,
      error: "seats must be a positive integer",
    };
    res.status(400).json(body);
    return;
  }

  try {
    const listing = await prisma.$transaction(async (tx) => {
      const existing = await tx.listing.findUnique({
        where: { id: listingId },
        select: { id: true, sellerId: true },
      });
      if (!existing) throw new ListingNotFoundError();
      if (existing.sellerId !== req.user!.id) throw new NotListingOwnerError();

      const consumed = await consumeListingSeats(tx, listingId, seats!);
      if (!consumed) throw new InsufficientSeatsError();

      return tx.listing.findUniqueOrThrow({ where: { id: listingId } });
    });

    const body: ApiResponse<{ listing: SharedListing }> = {
      success: true,
      data: { listing: toSharedListing(listing) },
    };
    res.json(body);
  } catch (err) {
    if (err instanceof ListingNotFoundError) {
      const body: ApiResponse<never> = { success: false, error: "Listing not found" };
      res.status(404).json(body);
      return;
    }
    if (err instanceof NotListingOwnerError) {
      const body: ApiResponse<never> = {
        success: false,
        error: "Only the seller of this listing can mark it sold",
      };
      res.status(403).json(body);
      return;
    }
    if (err instanceof InsufficientSeatsError) {
      const body: ApiResponse<never> = {
        success: false,
        error: "Not enough available seats to mark that many sold",
      };
      res.status(409).json(body);
      return;
    }
    throw err;
  }
});

class ListingNotLiveError extends Error {}

// Seller pulls the listing down without claiming a sale happened - e.g.
// they changed their mind, or found a buyer entirely outside the app and
// don't want to log it as sold. Unlike mark-sold, this never touches
// availableSeats/reservedSeats - nothing was sold, seats just stop being
// offered. WITHDRAWN is outside ACTIVE_STATUSES, so the same status filter
// GET /search already applies excludes it with no extra query changes.
listingsRouter.post("/:id/deactivate", requireAuth, async (req, res) => {
  const listingId = req.params.id as string;

  try {
    const listing = await prisma.$transaction(async (tx) => {
      const existing = await tx.listing.findUnique({
        where: { id: listingId },
        select: { id: true, sellerId: true, status: true },
      });
      if (!existing) throw new ListingNotFoundError();
      if (existing.sellerId !== req.user!.id) throw new NotListingOwnerError();
      if (!LIVE_LISTING_STATUSES.includes(existing.status)) throw new ListingNotLiveError();

      // Atomic + re-checked (status re-verified in the WHERE, not just the
      // read above) so two concurrent deactivate calls - or one racing a
      // reserve/mark-sold - can't both "win": updateMany's count tells us
      // whether this call actually applied the change.
      const updated = await tx.listing.updateMany({
        where: { id: listingId, status: { in: LIVE_LISTING_STATUSES } },
        data: { status: "WITHDRAWN" },
      });
      if (updated.count === 0) throw new ListingNotLiveError();

      return tx.listing.findUniqueOrThrow({ where: { id: listingId } });
    });

    const body: ApiResponse<{ listing: SharedListing }> = {
      success: true,
      data: { listing: toSharedListing(listing) },
    };
    res.json(body);
  } catch (err) {
    if (err instanceof ListingNotFoundError) {
      const body: ApiResponse<never> = { success: false, error: "Listing not found" };
      res.status(404).json(body);
      return;
    }
    if (err instanceof NotListingOwnerError) {
      const body: ApiResponse<never> = {
        success: false,
        error: "Only the seller of this listing can deactivate it",
      };
      res.status(403).json(body);
      return;
    }
    if (err instanceof ListingNotLiveError) {
      const body: ApiResponse<never> = {
        success: false,
        error: "Listing is already sold, withdrawn, or otherwise no longer live",
      };
      res.status(409).json(body);
      return;
    }
    throw err;
  }
});

class SeatsAlreadyReservedError extends Error {}
class PriceIntegrityUpdateError extends Error {}

// Basic self-service edit for a still-live listing: pricePerSeat, showtime,
// and/or totalSeats. All optional (send only what's changing) but at least
// one is required. totalSeats is rejected unless availableSeats ===
// totalSeats already - editing seat count once any are reserved/sold would
// corrupt that accounting (there's no way to know *which* seats the new
// count should refer to). When totalSeats does change, availableSeats is
// kept in lockstep with it (both become the new value) since nothing is
// reserved at that point by construction.
listingsRouter.patch("/:id", requireAuth, async (req, res) => {
  const listingId = req.params.id as string;

  const pricePerSeatProvided = req.body?.pricePerSeat !== undefined;
  const showtimeProvided = req.body?.showtime !== undefined;
  const totalSeatsProvided = req.body?.totalSeats !== undefined;

  const pricePerSeat = pricePerSeatProvided ? requireFiniteNumber(req.body.pricePerSeat) : undefined;
  const showtimeRaw = showtimeProvided ? requireNonEmptyString(req.body.showtime) : undefined;
  const showtime = showtimeRaw ? new Date(showtimeRaw) : null;
  const totalSeats = totalSeatsProvided ? requireFiniteNumber(req.body.totalSeats) : undefined;

  const errors: string[] = [];
  if (!pricePerSeatProvided && !showtimeProvided && !totalSeatsProvided) {
    errors.push("at least one of pricePerSeat, showtime, or totalSeats is required");
  }
  if (pricePerSeatProvided && (pricePerSeat === null || pricePerSeat === undefined || pricePerSeat <= 0)) {
    errors.push("pricePerSeat must be a positive number");
  }
  if (showtimeProvided) {
    if (!showtime || Number.isNaN(showtime.getTime())) {
      errors.push("showtime must be a valid date");
    } else if (showtime.getTime() <= Date.now()) {
      errors.push("showtime must be in the future");
    }
  }
  if (totalSeatsProvided && (totalSeats === null || totalSeats === undefined || totalSeats <= 0 || !Number.isInteger(totalSeats))) {
    errors.push("totalSeats must be a positive integer");
  }
  if (errors.length > 0) {
    const body: ApiResponse<never> = { success: false, error: errors.join("; ") };
    res.status(400).json(body);
    return;
  }

  try {
    const listing = await prisma.$transaction(async (tx) => {
      const existing = await tx.listing.findUnique({ where: { id: listingId } });
      if (!existing) throw new ListingNotFoundError();
      if (existing.sellerId !== req.user!.id) throw new NotListingOwnerError();
      if (!LIVE_LISTING_STATUSES.includes(existing.status)) throw new ListingNotLiveError();
      if (totalSeatsProvided && existing.availableSeats !== existing.totalSeats) {
        throw new SeatsAlreadyReservedError();
      }

      const nextPricePerSeat = pricePerSeat ?? existing.pricePerSeat;
      const nextTotalSeats = totalSeats ?? existing.totalSeats;

      // Never trust the client-side version of this check - same
      // price-integrity rule as creation (see POST "/" above), re-run
      // against whichever of pricePerSeat/totalSeats is actually changing.
      // totalAmountPaid itself isn't editable here, so this only reads it.
      if (
        existing.totalAmountPaid !== null &&
        nextPricePerSeat * nextTotalSeats > existing.totalAmountPaid + PRICE_INTEGRITY_TOLERANCE
      ) {
        const listedTotal = nextPricePerSeat * nextTotalSeats;
        throw new PriceIntegrityUpdateError(
          `Your listed price (₹${listedTotal.toFixed(2)} total) would be higher than what you paid for this ticket (₹${existing.totalAmountPaid.toFixed(2)}) — sellers can only recover up to what they originally paid.`,
        );
      }

      const data: { pricePerSeat?: number; showtime?: Date; totalSeats?: number; availableSeats?: number } =
        {};
      if (pricePerSeat != null) data.pricePerSeat = pricePerSeat;
      if (showtime) data.showtime = showtime;
      if (totalSeats != null) {
        data.totalSeats = totalSeats;
        // Nothing reserved (checked above), so seats available === seats
        // total, before and after.
        data.availableSeats = totalSeats;
      }

      return tx.listing.update({ where: { id: listingId }, data });
    });

    const body: ApiResponse<{ listing: SharedListing }> = {
      success: true,
      data: { listing: toSharedListing(listing) },
    };
    res.json(body);
  } catch (err) {
    if (err instanceof ListingNotFoundError) {
      const body: ApiResponse<never> = { success: false, error: "Listing not found" };
      res.status(404).json(body);
      return;
    }
    if (err instanceof NotListingOwnerError) {
      const body: ApiResponse<never> = {
        success: false,
        error: "Only the seller of this listing can edit it",
      };
      res.status(403).json(body);
      return;
    }
    if (err instanceof ListingNotLiveError) {
      const body: ApiResponse<never> = {
        success: false,
        error: "Listing is already sold, withdrawn, or otherwise no longer live",
      };
      res.status(409).json(body);
      return;
    }
    if (err instanceof SeatsAlreadyReservedError) {
      const body: ApiResponse<never> = {
        success: false,
        error: "Can't change seat count once any seats have been reserved or sold",
      };
      res.status(409).json(body);
      return;
    }
    if (err instanceof PriceIntegrityUpdateError) {
      const body: ApiResponse<never> = { success: false, error: err.message };
      res.status(400).json(body);
      return;
    }
    throw err;
  }
});
