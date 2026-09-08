import { prisma } from "../prisma";
import type { Transaction } from "../../generated/prisma/client";

export interface PaymentCapturedResult {
  message: string;
}

// Core logic for reacting to a captured payment for a given transaction:
// atomically escrow it if still payable, otherwise flag it for manual
// review. Shared by the real Razorpay webhook handler
// (POST /api/webhooks/razorpay) and the dev-only simulate endpoint
// (POST /api/dev/simulate-payment-captured/:id) so the two can never drift.
export async function handlePaymentCaptured(
  transaction: Transaction,
  orderId: string,
): Promise<PaymentCapturedResult> {
  if (transaction.status === "ESCROWED") {
    return { message: "Already processed" };
  }

  // Atomic + re-checked: guards against this racing the expiry cron job,
  // and against the same event being processed concurrently more than once.
  const escrowed = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "Transaction"
    SET status = 'ESCROWED', "confirmedAt" = now()
    WHERE id = ${transaction.id} AND status = 'RESERVED' AND "reservationExpiresAt" > now()
    RETURNING id
  `;

  if (escrowed.length > 0) {
    return { message: "Transaction escrowed" };
  }

  const latest = await prisma.transaction.findUnique({ where: { id: transaction.id } });
  if (latest?.status === "ESCROWED") {
    // Escrowed by a concurrent delivery of the same event in the window
    // between our read and the atomic update above - still idempotent.
    return { message: "Already processed" };
  }

  // Payment was captured, but the reservation is no longer payable
  // (expired, or otherwise not RESERVED). This is money that moved on
  // Razorpay's side but our system can no longer allocate automatically -
  // queue it for manual review rather than silently drop it. See GET
  // /api/admin/review-flags.
  await prisma.manualReviewFlag.create({
    data: {
      transactionId: transaction.id,
      reason: `payment.captured received for order ${orderId} but reservation is no longer payable (status=${latest?.status ?? transaction.status}, expiresAt=${(latest?.reservationExpiresAt ?? transaction.reservationExpiresAt)?.toISOString() ?? "null"})`,
      razorpayOrderId: orderId,
      amountPaid: transaction.amountPaid,
    },
  });
  console.error(
    `[payments] flagged transaction ${transaction.id} (order ${orderId}) for manual review`,
  );

  return { message: "Payment captured but reservation expired - flagged for manual review" };
}
