import type { PaymentMode } from "@grabmyseats/shared";

// Read once, at module load (i.e. process startup) - this is a top-level
// const, not a function re-reading process.env per call, so switching modes
// requires a restart/redeploy rather than editing the env var on a running
// process. Defaults to "escrow" (today's fully-built-out flow) for
// anything other than the literal "contact_only", so an unset or typo'd env
// var fails toward the flow that's actually been running in production, not
// toward silently disabling payment collection.
//
// What this actually gates, end to end:
//   - POST /api/listings/:id/reserve (routes/listings.ts): contact_only
//     skips the payment-pending Transaction shape and hands back the
//     seller's contact immediately instead.
//   - POST /:id/pay, /:id/check-in, /:id/confirm-receipt (routes/
//     transactions.ts, via middleware/paymentMode.ts's requireEscrowMode):
//     404 in contact_only mode - the code stays intact, just unreachable.
//   - GET /:id/contact (routes/transactions.ts): the usual 30-minute
//     showtime window is skipped in contact_only mode.
//   - the payout-release cron (jobs/index.ts): not scheduled at all in
//     contact_only mode.
export const PAYMENT_MODE: PaymentMode =
  process.env.PAYMENT_MODE === "contact_only" ? "contact_only" : "escrow";
