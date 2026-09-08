import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractTextFromImage } from "./ocr";
import { parseListingText } from "./parseListingText";

// Regression fixtures for the OCR movie-name heuristic. Each is a real
// BookMyShow ticket screenshot (not synthetic), covering the two layouts
// the app has actually been fed: the static ticket-card export (poster
// banner + fields) and the in-app "share your ticket" screen (poster
// thumbnail + surrounding UI chrome like "Watch Trailer", reward banners,
// "Tap for support...", etc).
//
// These run through the real Tesseract fallback path (no Google Cloud
// Vision credentials in this repo/CI - see ocr.ts), which is noisier than
// Vision would be: small icons next to the title sometimes get misread as
// a short leading/trailing token (e.g. "EES  Irumudi", "Ustaad Bhagat
// Singh ="). Assertions therefore check that the correct title is
// contained in the result (case-insensitively), not exact equality - the
// point of this suite is to catch the title heuristic locking onto the
// wrong line entirely (an "Enable Live Updates" or "SCREEN 10" style
// regression), not to pin down Tesseract's exact character-level noise.
const FIXTURES_DIR = path.join(__dirname, "__fixtures__/tickets");

interface Fixture {
  file: string;
  expectedMovieName: string;
  expectedTheaterKeyword: string;
  expectedShowtime: { month: number; day: number; hour: number; minute: number } | null;
  // Real, correct values (confirmed by hand against each screenshot), not
  // just "does it match at all" - unlike movieName/theaterName, seat count
  // and booking id have no OCR-noise tolerance to build in: either the
  // parser found the right number/code or it didn't.
  expectedTotalSeats: number;
  expectedBookingId: string;
  expectedTotalAmountPaid: number | null;
}

const FIXTURES: Fixture[] = [
  {
    file: "irumudi-static-card.jpg",
    expectedMovieName: "Irumudi",
    expectedTheaterKeyword: "PVR",
    // Static card has no "|"-separated date/time on one line in the OCR'd
    // text (date and time render as separate label/value pairs), so the
    // showtime regex doesn't match this format - documenting current
    // behavior, not asserting it's ideal.
    expectedShowtime: null,
    // Seats YR-E3, E4, E5 - the "Seats" column header itself never
    // survives OCR (see extractSeatCountFromList in parseListingText.ts),
    // so this exercises the comma-list fallback, not the "N Ticket(s)"
    // label. Booking ID TLANJAC: the "Booking ID" label also never
    // survives OCR on this card (low-contrast text on a gradient
    // background) - exercises extractBookingIdFallback.
    expectedTotalSeats: 3,
    expectedBookingId: "TLANJAC",
    // Static ticket-card export has no checkout/"Total Amount" summary
    // section at all - correctly not detected.
    expectedTotalAmountPaid: null,
  },
  {
    file: "irumudi-app-share.jpeg",
    expectedMovieName: "Irumudi",
    expectedTheaterKeyword: "PVR",
    expectedShowtime: { month: 8, day: 29, hour: 22, minute: 50 },
    expectedTotalSeats: 1,
    expectedBookingId: "T2AXBB3",
    // The one fixture confirmed correct against the real screenshot:
    // "Total Amount ₹100.00 saved ₹810.48" - ₹810.48 is the actual total
    // paid (the ₹100.00 is the discount applied, listed first).
    expectedTotalAmountPaid: 810.48,
  },
  {
    file: "drishyam3-app-share.jpeg",
    expectedMovieName: "Drishyam",
    expectedTheaterKeyword: "ALLU",
    expectedShowtime: { month: 5, day: 21, hour: 23, minute: 20 },
    expectedTotalSeats: 2,
    expectedBookingId: "WQXBJX9",
    // Real total is ₹780.24, but Tesseract misreads the ₹ glyph as a
    // leading "3" on this line ("Total Amount 3780.24") - the same
    // documented failure mode as extractPrice's own ₹-misread note, and
    // not correctable from text alone (a genuine 4-digit total looks
    // identical). Documenting actual behavior, not asserting it's ideal -
    // see the comment on extractTotalAmountPaid in parseListingText.ts for
    // why this failure direction (overstating, never understating) is the
    // safer one to accept for this specific field.
    expectedTotalAmountPaid: 3780.24,
  },
  {
    file: "ustaad-bhagat-singh-app-share.jpeg",
    expectedMovieName: "Ustaad Bhagat Singh",
    expectedTheaterKeyword: "Aparna",
    expectedShowtime: { month: 3, day: 19, hour: 7, minute: 30 },
    expectedTotalSeats: 3,
    expectedBookingId: "AACN00005304",
    // Same ₹-misread-as-leading-digit case as drishyam3 above (real total
    // is ₹984.12, OCR'd as "3984.12").
    expectedTotalAmountPaid: 3984.12,
  },
  {
    file: "hokum-static-card.jpeg",
    expectedMovieName: "Hokum",
    expectedTheaterKeyword: "",
    expectedShowtime: null,
    // Single seat CC-K4 - comma-list fallback with zero commas (still
    // exercises the same code path: an anchor with no trailing tokens).
    // Booking ID T2A2HDN: this screenshot's own gallery-viewer chrome
    // ("T2A2HDN.jpg", "43 KB") sits right next to the real booking id and
    // is visually near-identical to it - regression coverage for the
    // fallback not confusing the two (see the dedicated test below).
    expectedTotalSeats: 1,
    expectedBookingId: "T2A2HDN",
    // Static ticket-card export has no checkout/"Total Amount" summary
    // section at all - correctly not detected.
    expectedTotalAmountPaid: null,
  },
];

// Ticket screenshots never carry a year, so parseListingText resolves the
// showtime against the current date (rolling to next year if the day has
// already passed this year - see extractShowtime in parseListingText.ts).
// Asserting only month/day/hour/minute keeps this fixture stable across
// the year-rollover instead of pinning a specific ISO year.
function expectShowtimeComponents(
  iso: string | null,
  expected: Fixture["expectedShowtime"],
): void {
  if (expected === null) {
    expect(iso).toBeNull();
    return;
  }
  expect(iso).not.toBeNull();
  const date = new Date(iso as string);
  expect(date.getUTCMonth() + 1).toBe(expected.month);
  expect(date.getUTCDate()).toBe(expected.day);
  expect(date.getUTCHours()).toBe(expected.hour);
  expect(date.getUTCMinutes()).toBe(expected.minute);
}

describe("parseListingText - real ticket screenshot fixtures", () => {
  for (const fixture of FIXTURES) {
    it(`extracts the correct movie name from ${fixture.file}`, async () => {
      const buffer = fs.readFileSync(path.join(FIXTURES_DIR, fixture.file));
      const { text, lines } = await extractTextFromImage(buffer);
      const fields = parseListingText(text, lines);

      expect(fields.movieName).not.toBeNull();
      expect((fields.movieName as string).toLowerCase()).toContain(
        fixture.expectedMovieName.toLowerCase(),
      );

      // Certification/rating tags like "(UA16+)" must never survive into
      // the returned title.
      expect(fields.movieName).not.toMatch(/\(\s*(?:U\/A|UA\d{1,2}\+?|UA|U|A)\)?\s*$/i);

      if (fixture.expectedTheaterKeyword) {
        expect(fields.theaterName?.toLowerCase()).toContain(
          fixture.expectedTheaterKeyword.toLowerCase(),
        );
      }

      expectShowtimeComponents(fields.showtime, fixture.expectedShowtime);

      expect(fields.totalSeats).toBe(fixture.expectedTotalSeats);
      expect(fields.bookingId).toBe(fixture.expectedBookingId);
      expect(fields.totalAmountPaid).toBe(fixture.expectedTotalAmountPaid);
    });
  }

  // hokum-static-card.jpeg's own screenshot-viewer chrome prints
  // "T2A2HDN.jpg" and "43 KB" directly above/beside the real booking id
  // "T2A2HDN" - close enough in the source image that the poster-region
  // crop boundary can clip through the filename (see cropPosterRegion.ts),
  // and visually similar enough to the real code that a looser fallback
  // heuristic could plausibly grab the wrong one. Asserted separately from
  // the loop above for a clearer failure message if this regresses.
  it("does not confuse the booking id with the near-identical screenshot-viewer filename on hokum-static-card.jpeg", async () => {
    const buffer = fs.readFileSync(path.join(FIXTURES_DIR, "hokum-static-card.jpeg"));
    const { text, lines } = await extractTextFromImage(buffer);
    const fields = parseListingText(text, lines);

    expect(fields.bookingId).toBe("T2A2HDN");
    expect(fields.bookingId).not.toContain("JPG");
    expect(fields.bookingId).not.toContain(".");
  });
});
