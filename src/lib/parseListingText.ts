import type { OcrExtractedFields } from "@grabmyseats/shared";
import type { OcrLine } from "./ocr";

// A hard-edged mask boundary (see cropPosterRegion.ts) sitting against
// busy poster-photo content can itself read as faint stray glyphs (e.g.
// "NE", "of pind") at confidence up to the high 40s - well below every
// real title line seen across the fixtures in
// backend/src/lib/__fixtures__/tickets (lowest observed: 79). Raised from
// 40 to comfortably clear that noise band without touching real titles.
const MIN_LINE_CONFIDENCE = 55;
const MOVIE_NAME_EXCLUDE_RE = /booking\s*id|ticket|₹|\b(am|pm)\b/i;

// Known non-title UI chrome that real ticket screenshots surface as tall,
// bold, or high-confidence lines - exactly the kind of line the old
// "tallest line wins" heuristic mistook for the movie title. The first
// group is the literal strings the format is known to use; the rest were
// found by running real BookMyShow screenshots (app share-sheet and
// static ticket-card formats) through this pipeline.
const TITLE_BLOCKLIST_RE =
  /your\s*ticket|m-?ticket|watch\s*trailer|tap\s*for\s*support|details\s*&\s*more\s*actions|enable\s*live\s*updates|cancellation\s*not\s*available|find\s*venue|add\s*to\s*google\s*wallet|you'?ve\s*won|tap\s*to\s*open|tap\s*to\s*refresh|something\s*went\s*wrong|screen\s*\d+/i;

// A phone status bar line (clock + battery/signal icons, e.g.
// "22:20 ... 83%") that happens to score above the confidence floor.
const STATUS_BAR_RE = /^\d{1,2}:\d{2}\b.*%/;

// Booking IDs/reference codes render as a single all-caps alphanumeric
// token with no spaces (e.g. "TLANJAC", "T2AXBB3") - unlike movie titles,
// which always contain a space, lowercase letter, or punctuation.
const CODE_LIKE_RE = /^[A-Z0-9]{5,14}$/;

// Screenshot-viewer chrome (filename, file size) that isn't part of the
// ticket itself but can appear in a gallery-app screenshot of a ticket.
// Tolerant of stray whitespace around the extension/unit since a filename
// that straddles the poster-region crop boundary (see cropPosterRegion.ts)
// can come back from OCR with an inserted space, e.g. "T2A2HDN.jpg" ->
// "pa2hdn. jpg ." once its leading edge is masked out.
// The size unit's digits are optional because the poster-region crop
// boundary can clip a leading digit off (e.g. "43 KB" -> "KB" once the
// "4" and "3" fall inside the masked region).
const FILE_CHROME_RE = /\.\s*(jpe?g|png)\b|\b\d*\s*[KM]B\b/i;

// Trailing certification/rating tag, e.g. "(U)", "(UA)", "(UA16+)", "(A)".
// Tolerant of a missing closing paren because these tickets sometimes wrap
// the tag onto the next OCR line, cutting it off mid-token.
const CERT_TAG_RE = /\s*\(\s*(?:U\/A|UA\d{1,2}\+?|UA|U|A)\)?\s*$/i;

// When two candidate lines sit in roughly the same visual row (e.g. a
// title split across two OCR lines by wrapping), prefer whichever is
// taller/bolder as a proxy for which one is the actual title vs. a
// smaller subtitle/format line next to it.
const SAME_ROW_BAND_PX = 20;

const THEATER_KEYWORDS = [
  "pvr",
  "inox",
  "cinepolis",
  "carnival",
  "miraj",
  "cinemas",
  "multiplex",
  "imax",
];

const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

function linesOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

// "BOOKING ID" followed by an alphanumeric code, either on the same line
// (with or without a colon - "BOOKING ID: XXXXX" or "Booking ID XXXXX")
// or (common in real ticket screenshots) the line right after the label.
function extractBookingIdFromLabel(text: string): string | null {
  const lines = linesOf(text);
  for (let i = 0; i < lines.length; i++) {
    const labelMatch = lines[i].match(/booking\s*id\s*[:\-]?\s*(.*)$/i);
    if (!labelMatch) continue;

    const inline = labelMatch[1].replace(/[^A-Za-z0-9]/g, "");
    if (inline.length >= 4 && inline.length <= 20) return inline.toUpperCase();

    const next = lines[i + 1]?.replace(/[^A-Za-z0-9]/g, "");
    if (next && next.length >= 4 && next.length <= 20) return next.toUpperCase();
  }
  return null;
}

// Fallback for ticket layouts where "Booking ID" never survives OCR as
// legible text at all, label or no colon - verified against real static-
// ticket-card fixtures: the label renders as small low-contrast text
// (sitting on a dark gradient in one, hidden under a photo-viewer's own
// filename/size overlay in the other) that Tesseract just doesn't read,
// while the code itself - a short, unpunctuated alphanumeric token,
// printed again beneath the QR code - OCRs cleanly. Requires the WHOLE
// line to be just the code (not a substring match), which is what
// naturally rules out false positives: a filename fragment always has a
// stray "." or ".jpg", and a seat-code list always has "-" or ",". Used
// only when the label-based match above finds nothing, since it's a much
// weaker signal (no explicit label to anchor to) - and takes the first
// match top-to-bottom, since a garbled second occurrence near the QR
// caption (e.g. "TLANJAC" misread as "TLANAC" further down the card)
// should never win over a clean first one.
const BOOKING_ID_CODE_RE = /^[A-Z0-9]{5,14}$/;

function extractBookingIdFallback(text: string, claimed: (string | null)[]): string | null {
  const claimedText = claimed.filter((c): c is string => !!c);
  for (const line of linesOf(text)) {
    const candidate = line.toUpperCase();
    if (!BOOKING_ID_CODE_RE.test(candidate)) continue;
    if (claimedText.includes(candidate)) continue;
    return candidate;
  }
  return null;
}

function extractBookingId(text: string, claimed: (string | null)[] = []): string | null {
  return extractBookingIdFromLabel(text) ?? extractBookingIdFallback(text, claimed);
}

// "N Ticket(s)"
function extractSeatCountFromLabel(text: string): number | null {
  const match = text.match(/(\d{1,2})\s*tickets?\b/i);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n > 0 && n <= 20 ? n : null;
}

// Fallback for ticket layouts that never print an explicit "N Ticket(s)"
// count - the static ticket-card export instead shows a "Seats" column of
// comma-separated seat codes (e.g. "YR-E3, E4, E5") next to a "Venue(s)"
// column. Per real fixtures, neither column header survives OCR as
// legible text at all (Tesseract's column-merging read order drops both
// "Seats" and "Venue(s)", leaving only "<venue text>: YR-E3, E4, E5" as
// one merged line) - so this anchors on a hyphenated row-seat code (e.g.
// "YR-E3", "CC-K4") instead of the label, since that's what's actually
// legible, then counts every comma-separated token from that anchor
// onward (covering trailing bare seat numbers like the "E4, E5" that
// share the first token's row prefix implicitly).
const SEAT_LIST_RE = /\b[A-Z]{1,3}-[A-Z0-9]{1,4}(?:\s*,\s*[A-Z0-9]{1,4})*/;

function extractSeatCountFromList(text: string): number | null {
  const match = text.match(SEAT_LIST_RE);
  if (!match) return null;
  const count = match[0].split(",").length;
  return count > 0 && count <= 20 ? count : null;
}

function extractSeatCount(text: string): number | null {
  return extractSeatCountFromLabel(text) ?? extractSeatCountFromList(text);
}

// "₹950.00" / "₹ 1,200"
function extractPrice(text: string): number | null {
  const match = text.match(/₹\s*([\d,]+(?:\.\d{1,2})?)/);
  if (!match) return null;
  const n = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// "Total Amount ₹100.00 saved 810.48" (a "saved"/discount figure, when
// present, always comes first) or plain "Total Amount 780.24" - the
// actual amount paid is the LAST (rightmost) money-shaped number on the
// line. Anchored on the "Total Amount" label rather than a literal ₹
// symbol, unlike extractPrice above: verified against real fixtures that
// Tesseract doesn't reliably preserve ₹ on this line at all - sometimes
// dropping it entirely (as it did for the real total on the one fixture
// this is confirmed correct against), sometimes misreading it as a
// leading digit (the same failure noted for extractPrice, e.g. "₹780.24"
// -> "3780.24" on other real fixtures - not correctable from text alone,
// since a genuine 4-digit total looks identical). That failure direction
// is the safer one for what this field feeds - a "don't list above what
// you paid" check - since overstating the paid amount only makes the
// check more permissive, never wrongly blocks a legitimate seller.
const AMOUNT_TOKEN_RE = /\d[\d,]*(?:\.\d{1,2})?/g;

function extractTotalAmountPaid(text: string): number | null {
  const line = linesOf(text).find((l) => /total\s*amount/i.test(l));
  if (!line) return null;

  const matches = [...line.matchAll(AMOUNT_TOKEN_RE)];
  if (matches.length === 0) return null;

  const last = matches[matches.length - 1][0];
  const n = Number(last.replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// e.g. "Sat, 29 Aug | 10:50 PM" - the weekday prefix is optional since not
// every screenshot format includes one.
function extractShowtime(text: string): string | null {
  const match = text.match(
    /(?:[A-Za-z]{3,9},?\s*)?(\d{1,2})\s+([A-Za-z]{3,9})\D{0,6}?(\d{1,2}):(\d{2})\s*([AaPp][Mm])/,
  );
  if (!match) return null;

  const day = Number(match[1]);
  const monthIndex = MONTHS[match[2].toLowerCase()];
  let hour = Number(match[3]);
  const minute = Number(match[4]);
  const isPm = /pm/i.test(match[5]);

  if (
    monthIndex === undefined ||
    day < 1 ||
    day > 31 ||
    hour < 1 ||
    hour > 12 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  hour = hour % 12;
  if (isPm) hour += 12;

  // Screenshots never include a year, so treat the extracted wall-clock
  // values as the intended showtime for "this year, or next year if that
  // date has already passed" - and store them as literal UTC components
  // (no timezone math) so the value round-trips byte-for-byte through the
  // frontend's datetime-local input regardless of where either machine's
  // clock is set. See frontend/src/lib/datetimeLocal.ts.
  const now = new Date();
  const year = now.getUTCFullYear();
  let candidateMs = Date.UTC(year, monthIndex, day, hour, minute);
  if (candidateMs < now.getTime() - 24 * 60 * 60 * 1000) {
    candidateMs = Date.UTC(year + 1, monthIndex, day, hour, minute);
  }
  return new Date(candidateMs).toISOString();
}

function extractTheaterName(text: string): string | null {
  for (const line of linesOf(text)) {
    const lower = line.toLowerCase();
    if (THEATER_KEYWORDS.some((kw) => lower.includes(kw)) && line.length >= 4 && line.length <= 80) {
      return line;
    }
  }
  return null;
}

// The movie title is the first visually prominent line positioned below
// the screenshot's header/poster chrome - i.e. the topmost line left once
// known UI noise (blocklisted phrases, status bars, booking-code-shaped
// tokens, already-claimed fields) is filtered out, rather than simply the
// tallest line on the whole screenshot. Ticket UIs routinely put taller,
// higher-confidence chrome (banners, reward cards, "SHARE YOUR TICKET"
// headers) above or below the actual title, which made pure height an
// unreliable signal on real screenshots.
function extractMovieName(lines: OcrLine[], claimed: (string | null)[]): string | null {
  const claimedText = claimed.filter((c): c is string => !!c);

  const candidates = lines.filter((line) => {
    if (line.confidence < MIN_LINE_CONFIDENCE) return false;
    if (line.text.length < 2 || line.text.length > 60) return false;
    if (!/[A-Za-z]{2,}/.test(line.text)) return false;
    if (MOVIE_NAME_EXCLUDE_RE.test(line.text)) return false;
    if (TITLE_BLOCKLIST_RE.test(line.text)) return false;
    if (STATUS_BAR_RE.test(line.text)) return false;
    if (CODE_LIKE_RE.test(line.text)) return false;
    if (FILE_CHROME_RE.test(line.text)) return false;
    if (claimedText.some((c) => line.text.includes(c))) return false;
    return true;
  });

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => a.y0 - b.y0);
  const topmost = candidates[0];

  // Among lines in the same visual row as the topmost candidate, prefer
  // the tallest (then rightmost, i.e. away from a poster thumbnail on the
  // left edge) as the more likely title line vs. a subtitle/format tag
  // next to it.
  const sameRow = candidates.filter((c) => Math.abs(c.y0 - topmost.y0) <= SAME_ROW_BAND_PX);
  sameRow.sort((a, b) => b.height - a.height || b.x0 - a.x0);
  const best = sameRow[0] ?? topmost;

  return best.text.replace(CERT_TAG_RE, "").trim() || null;
}

export function parseListingText(text: string, lines: OcrLine[]): OcrExtractedFields {
  const theaterName = extractTheaterName(text);
  const bookingId = extractBookingId(text, [theaterName]);
  const totalSeats = extractSeatCount(text);
  const pricePerSeat = extractPrice(text);
  const totalAmountPaid = extractTotalAmountPaid(text);
  const showtime = extractShowtime(text);
  const movieName = extractMovieName(lines, [bookingId, theaterName]);

  return {
    movieName,
    theaterName,
    showtime,
    totalSeats,
    pricePerSeat,
    bookingId,
    totalAmountPaid,
  };
}
