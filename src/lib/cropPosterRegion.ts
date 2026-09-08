import sharp from "sharp";

// Fraction of the image's width/height that the poster thumbnail/banner
// occupies in the upper-left corner. Calibrated against 5 real BookMyShow
// ticket screenshots (both the in-app "share your ticket" layout, where
// the poster is a small square thumbnail, and the static ticket-card
// export, where it's a wider banner) - large enough to fully cover the
// poster thumbnail in the app-share layout with margin to spare, small
// enough that it never reaches the title text, the "Booking ID" line, or
// any other field in any of the 5 fixtures. See
// backend/src/lib/__fixtures__/tickets.
const POSTER_WIDTH_PCT = 0.26;
const POSTER_HEIGHT_PCT = 0.23;

// A phone screenshot's status bar (clock, signal, battery icons) spans
// most of the width at the very top, wider than the poster corner box
// above - masking only the corner used to leave the right half of that
// row exposed, which Tesseract misread as a new garbage line of its own
// ("b28 al ail b83%", which passes every other filter since it no longer
// contains clock digits or a blocklisted phrase). A second, wider masked
// region used to handle that, but empirically (verified against these
// fixtures by isolating every other variable) a second rectangle of
// meaningful height ANYWHERE in the image measurably degrades Tesseract's
// read of *other, untouched* text elsewhere on the page - on the static
// ticket-card layout this was corrupting the "Booking ID <value>" line
// above the poster even though its pixels were never covered by either
// mask, and the height that's safe for a 750px-tall static card (<=20px)
// is smaller than what a 1600px-tall app-share screenshot's status bar
// needs to fully cover (>=55px) - no single mask geometry satisfies both.
// So leftover status-bar icon garbage is filtered at the text level
// instead (see STATUS_BAR_RE in parseListingText.ts), which has none of
// this failure mode, rather than fought for at the image level.
//
// Removes the poster thumbnail/banner (and any icon overlays on it, e.g.
// a "Watch Trailer" play button) from the upper-left corner before OCR
// runs, so stylized poster artwork/logo text is never read as a title
// candidate in the first place (e.g. real poster art misread as "LTEB").
//
// This paints the region a flat white rather than physically cropping
// the image down: a true crop can only remove a full-width or full-
// height strip, not an arbitrary corner rectangle, without leaving a
// non-rectangular hole. Painting over the region keeps every other
// line's bounding box unchanged, which the position-based title
// heuristic in parseListingText.ts depends on.
export async function cropPosterRegion(buffer: Buffer): Promise<Buffer> {
  const image = sharp(buffer);
  const { width, height } = await image.metadata();
  if (!width || !height) return buffer;

  const posterBoxWidth = Math.round(width * POSTER_WIDTH_PCT);
  const posterBoxHeight = Math.round(height * POSTER_HEIGHT_PCT);

  const mask = Buffer.from(
    `<svg width="${width}" height="${height}"><rect x="0" y="0" width="${posterBoxWidth}" height="${posterBoxHeight}" fill="white" /></svg>`,
  );

  return image.composite([{ input: mask, top: 0, left: 0 }]).toBuffer();
}
