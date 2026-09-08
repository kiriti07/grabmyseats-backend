// Screen/format qualifiers that hurt geocoding accuracy far more than they
// help - Nominatim searches for the venue itself, not its screen tier.
const SCREEN_TIER_PATTERNS: RegExp[] = [
  /\bLUXE\b/gi,
  /\bIMAX\b/gi,
  /\b4DX\b/gi,
  /\bGold\s*Class\b/gi,
  /\bRecliners?\b/gi,
  /\bInsignia\b/gi,
  /\bScreen\s*\d+\b/gi,
];

// Cleans a raw (often OCR'd or user-typed) theater name before it's used
// in a geocoding query. Ticket screenshots commonly append a screen/format
// qualifier after a colon (e.g. "PVR Icon: 4DX") or bare in the name
// (e.g. "INOX Insignia") - both make Nominatim's forward search worse, not
// better, so both are stripped here.
export function cleanTheaterName(raw: string): string {
  let name = raw.split(":")[0];

  for (const pattern of SCREEN_TIER_PATTERNS) {
    name = name.replace(pattern, "");
  }

  return name.replace(/\s{2,}/g, " ").trim();
}
