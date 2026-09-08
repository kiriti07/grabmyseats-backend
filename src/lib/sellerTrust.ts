import type { SellerDeliveryEligibility } from "@grabmyseats/shared";
import { prisma } from "./prisma";

// New sellers default to IN_PERSON only - EMAIL_FORWARD (skipping the
// seller's own venue check-in) is only offered once a seller has this many
// completed sales under their belt, and no unresolved ManualReviewFlag on
// any of them. Enforced at listing creation (see POST /api/listings) and
// mirrored by GET /api/users/me/delivery-eligibility so the sell form can
// explain the gate instead of just hiding the option.
//
// NOTE: "completed" is measured by TxnStatus PAYOUT_RELEASED, a status
// nothing can reach anymore now that GrabMySeats doesn't process payment
// (see PAYMENT_MODE in lib/config.ts and requireEscrowMode) - this gate is
// currently unsatisfiable for every seller, permanently defaulting
// everyone to IN_PERSON-only. Left as-is rather than guessing at a
// replacement "completed sale" signal for a contact-only flow (e.g. seller
// calls to POST /:id/mark-sold) - that's a product decision, not a payout
// cleanup one.
export const SELLER_TRUST_MIN_COMPLETED_SALES = 3;

export async function getSellerDeliveryEligibility(
  sellerId: string,
): Promise<SellerDeliveryEligibility> {
  const [completedSales, unresolvedFlagCount] = await Promise.all([
    prisma.transaction.count({
      where: { status: "PAYOUT_RELEASED", listing: { sellerId } },
    }),
    prisma.manualReviewFlag.count({
      where: { resolvedAt: null, transaction: { listing: { sellerId } } },
    }),
  ]);

  const hasUnresolvedReviewFlags = unresolvedFlagCount > 0;

  return {
    emailForwardEligible:
      completedSales >= SELLER_TRUST_MIN_COMPLETED_SALES && !hasUnresolvedReviewFlags,
    completedSales,
    requiredCompletedSales: SELLER_TRUST_MIN_COMPLETED_SALES,
    hasUnresolvedReviewFlags,
  };
}
