// Fuzzy-title-match threshold shared between GET /api/listings/search
// (routes/listings.ts) and the alert-matching cron (jobs/matchAlerts.ts) -
// "reuse the same pg_trgm approach as search" means this threshold too,
// not just the similarity() call shape.
export const TITLE_SIMILARITY_THRESHOLD = 0.2;
