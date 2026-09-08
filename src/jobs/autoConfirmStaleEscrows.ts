import { prisma } from "../lib/prisma";

// If a buyer never taps "confirm receipt", an ESCROWED transaction would
// otherwise sit forever and its payout would never release. Once a
// listing's showtime is more than 3 hours in the past, auto-confirm on
// the buyer's behalf so the payout-release pipeline can proceed.
//
// Logged with a distinct reason per case so these are distinguishable from
// real buyer confirmations (and from each other) if this ever needs an
// audit:
//   - auto_confirmed_buyer_noshow: the seller checked in but the buyer
//     never did - the buyer is the one who didn't show, so the seller
//     shouldn't be penalized by having their payout withheld.
//   - auto_confirmed_timeout: anything else (neither checked in, or some
//     other reason the buyer never confirmed despite checking in).
const AUTO_CONFIRM_BUFFER_MS = 3 * 60 * 60 * 1000; // 3 hours

export async function autoConfirmStaleEscrows(): Promise<number> {
  const due = await prisma.transaction.findMany({
    where: {
      status: "ESCROWED",
      listing: { showtime: { lte: new Date(Date.now() - AUTO_CONFIRM_BUFFER_MS) } },
    },
    select: { id: true, buyerCheckInAt: true, sellerCheckInAt: true },
  });

  let confirmedCount = 0;

  for (const txn of due) {
    // Atomic + re-checked: guards against racing a real buyer confirmation
    // (POST /api/transactions/:id/confirm-receipt) or another run of this
    // same job.
    const confirmedRows = await prisma.$executeRaw`
      UPDATE "Transaction"
      SET status = 'BUYER_CONFIRMED', "confirmedAt" = now()
      WHERE id = ${txn.id} AND status = 'ESCROWED'
    `;
    if (confirmedRows > 0) {
      confirmedCount += 1;
      const reason =
        !txn.buyerCheckInAt && txn.sellerCheckInAt
          ? "auto_confirmed_buyer_noshow"
          : "auto_confirmed_timeout";
      console.log(`[jobs] auto-confirmed transaction ${txn.id} (reason: ${reason})`);
    }
  }

  return confirmedCount;
}
