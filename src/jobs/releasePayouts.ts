import { prisma } from "../lib/prisma";
import { payoutProvider } from "../lib/payments";

// How long after buyer confirmation (real or auto - see
// autoConfirmStaleEscrows.ts) a payout is released to the seller.
const RELEASE_DELAY_MS = 12 * 60 * 60 * 1000; // 12 hours

// Releases payouts for transactions the buyer has confirmed (BUYER_CONFIRMED)
// at least 12 hours ago and that haven't been released yet. `transferId IS
// NULL` is both the selection filter and, re-checked in the final atomic
// UPDATE, the guard against releasing the same transaction twice - so even
// if this job somehow ran concurrently with itself, only one run's UPDATE
// can win for a given transaction. NOTE: PayoutProvider.releaseTransfer
// itself still needs to be safe to call more than once for the same
// transaction (e.g. a crash between the transfer call and the UPDATE below
// would leave transferId unset and the transaction selected again next
// tick) - that idempotency is the provider's responsibility, keyed by
// transactionId.
export async function releasePayouts(): Promise<number> {
  const due = await prisma.transaction.findMany({
    where: {
      status: "BUYER_CONFIRMED",
      confirmedAt: { lte: new Date(Date.now() - RELEASE_DELAY_MS) },
      transferId: null,
    },
    select: { id: true },
  });

  let releasedCount = 0;

  for (const { id } of due) {
    let transferId: string;
    try {
      ({ transferId } = await payoutProvider.releaseTransfer(id));
    } catch (err) {
      console.error(`[jobs] releaseTransfer failed for transaction ${id}`, err);
      continue;
    }

    const releasedRows = await prisma.$executeRaw`
      UPDATE "Transaction"
      SET status = 'PAYOUT_RELEASED', "payoutAt" = now(), "transferId" = ${transferId}
      WHERE id = ${id} AND status = 'BUYER_CONFIRMED' AND "transferId" IS NULL
    `;
    if (releasedRows > 0) releasedCount += 1;
  }

  return releasedCount;
}
