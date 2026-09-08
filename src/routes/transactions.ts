import { randomUUID } from "node:crypto";
import { Router } from "express";
import type {
  ApiResponse,
  MyPurchase,
  RazorpayCheckoutOrder,
  Rating as SharedRating,
  Transaction as SharedTransaction,
  TransactionContact,
  TransactionDetail,
  TransactionEmailForward,
} from "@grabmyseats/shared";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { requireEscrowMode } from "../middleware/paymentMode";
import { payoutProvider } from "../lib/payments";
import { storageProvider } from "../lib/storage";
import { PAYMENT_MODE } from "../lib/config";
import { toSharedTransaction, toSharedRating } from "../lib/serialize";
import { getRatingSummary } from "../lib/ratingSummary";
import { haversineDistanceMeters } from "../lib/geo/haversine";
import { uploadEmailForward } from "../middleware/upload";

export const transactionsRouter = Router();

class TransactionNotFoundError extends Error {}
class NotBuyerError extends Error {}
class ReservationNotPayableError extends Error {}
class SellerNotPayoutReadyError extends Error {}
class TransactionNotEscrowedError extends Error {}
class NotPartyError extends Error {}
class TooEarlyForCheckInError extends Error {}
class TooLateForCheckInError extends Error {}
class TooFarFromVenueError extends Error {}
class CheckInRequiredError extends Error {}
class ContactWindowClosedError extends Error {}
class OtherPartySuspendedError extends Error {}
class SellerCheckedInError extends Error {}
class TooEarlyToDisputeError extends Error {}
class EmailForwardRequiredError extends Error {}
class NotSellerError extends Error {}
class NotEscrowedError extends Error {}
class WrongDeliveryMethodError extends Error {}
class EmailForwardEmptyError extends Error {}
class RatingAlreadyExistsError extends Error {}

const CURRENCY = "INR";
const CHECK_IN_EARLY_WINDOW_MS = 30 * 60 * 1000; // 30 minutes before showtime
const CHECK_IN_LATE_WINDOW_MS = 20 * 60 * 1000; // 20 minutes after showtime
const CHECK_IN_MAX_DISTANCE_METERS = 500;
const CONTACT_WINDOW_MS = 30 * 60 * 1000; // both sides of showtime

function requireFiniteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function requireNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

type TransactionParty = "buyer" | "seller";

function partyForUser(
  transaction: { buyerId: string; listing: { sellerId: string } },
  userId: string,
): TransactionParty | null {
  if (transaction.buyerId === userId) return "buyer";
  if (transaction.listing.sellerId === userId) return "seller";
  return null;
}

// Mounted before GET "/:id" so "mine" isn't swallowed by the :id param -
// same reasoning as GET /api/listings/mine. The buyer's own past
// reservations/purchases, newest first - powers /account/purchases (see
// MyPurchase in shared/src/transaction.ts), including whether each has
// already been rated so the client can show "Rate this seller" without a
// separate per-transaction lookup.
transactionsRouter.get("/mine", requireAuth, async (req, res) => {
  const transactions = await prisma.transaction.findMany({
    where: { buyerId: req.user!.id },
    include: { listing: true },
    orderBy: { createdAt: "desc" },
  });

  const ratedTransactionIds = new Set(
    (
      await prisma.rating.findMany({
        where: { transactionId: { in: transactions.map((txn) => txn.id) } },
        select: { transactionId: true },
      })
    ).map((r) => r.transactionId),
  );

  const body: ApiResponse<{ purchases: MyPurchase[] }> = {
    success: true,
    data: {
      purchases: transactions.map((txn) => ({
        id: txn.id,
        status: txn.status,
        seatsCount: txn.seatsCount,
        amountPaid: txn.amountPaid,
        createdAt: txn.createdAt.toISOString(),
        listing: {
          id: txn.listing.id,
          movieName: txn.listing.movieName,
          theaterName: txn.listing.theaterName,
          showtime: txn.listing.showtime.toISOString(),
        },
        isRated: ratedTransactionIds.has(txn.id),
      })),
    },
  };
  res.json(body);
});

// Transaction detail for either party - the buyer's screenshot poll, and
// the check-in/contact-reveal/confirm-receipt UI on the transaction detail
// page, all start here. `party` lets the client render buyer-only pieces
// (confirm-receipt) or seller-only pieces without re-deriving "am I the
// buyer or the seller" from raw ids itself.
transactionsRouter.get("/:id", requireAuth, async (req, res) => {
  const transactionId = req.params.id as string;

  const transaction = await prisma.transaction.findUnique({
    where: { id: transactionId },
    include: { listing: true },
  });
  if (!transaction) {
    const body: ApiResponse<never> = { success: false, error: "Transaction not found" };
    res.status(404).json(body);
    return;
  }

  const party = partyForUser(transaction, req.user!.id);
  if (!party) {
    const body: ApiResponse<never> = {
      success: false,
      error: "You are not a party to this transaction",
    };
    res.status(403).json(body);
    return;
  }

  const body: ApiResponse<TransactionDetail> = {
    success: true,
    data: {
      transaction: toSharedTransaction(transaction),
      listing: {
        id: transaction.listing.id,
        movieName: transaction.listing.movieName,
        theaterName: transaction.listing.theaterName,
        showtime: transaction.listing.showtime.toISOString(),
      },
      party,
      paymentMode: PAYMENT_MODE,
    },
  };
  res.json(body);
});

// This endpoint only *initiates* payment: it creates an escrow order via
// PayoutProvider and returns checkout params for the client's Razorpay
// Checkout SDK. It deliberately does NOT touch the transaction's status -
// no money has moved yet at this point, so marking anything ESCROWED here
// would be premature. The transaction only becomes ESCROWED once POST
// /api/webhooks/razorpay receives and verifies a `payment.captured` event
// for this order (or, for local testing, POST
// /api/dev/simulate-payment-captured/:transactionId).
transactionsRouter.post("/:id/pay", requireEscrowMode, requireAuth, async (req, res) => {
  const transactionId = req.params.id as string;

  try {
    const { transaction } = await prisma.$transaction(async (tx) => {
      const transaction = await tx.transaction.findUnique({
        where: { id: transactionId },
        include: { listing: { include: { seller: true } } },
      });

      if (!transaction) throw new TransactionNotFoundError();
      if (transaction.buyerId !== req.user!.id) throw new NotBuyerError();
      if (
        transaction.status !== "RESERVED" ||
        !transaction.reservationExpiresAt ||
        transaction.reservationExpiresAt <= new Date()
      ) {
        throw new ReservationNotPayableError();
      }

      // Not strictly needed to create the order (PayoutProvider doesn't
      // take a destination account), but there's no point collecting
      // escrow for a seller we can never pay out.
      if (!transaction.listing.seller.razorpayAccountId) {
        throw new SellerNotPayoutReadyError();
      }

      return { transaction };
    });

    const order = await payoutProvider.createEscrowOrder(transaction.amountPaid, CURRENCY);

    // Record the order id so the webhook (or the dev simulate endpoint) can
    // find this transaction later, regardless of what happens next
    // (including the reservation expiring before payment comes in - that
    // handler is what decides what to do about it).
    await prisma.transaction.update({
      where: { id: transactionId },
      data: { razorpayOrderId: order.orderId },
    });

    const stillPayable = await prisma.transaction.findUnique({
      where: { id: transactionId },
    });
    if (
      !stillPayable ||
      stillPayable.status !== "RESERVED" ||
      !stillPayable.reservationExpiresAt ||
      stillPayable.reservationExpiresAt <= new Date()
    ) {
      const body: ApiResponse<never> = {
        success: false,
        error:
          "Reservation expired while the payment order was being created. Do not complete checkout - reserve again.",
      };
      res.status(409).json(body);
      return;
    }

    const body: ApiResponse<{ order: RazorpayCheckoutOrder }> = {
      success: true,
      data: {
        order: {
          orderId: order.orderId,
          amount: Math.round(transaction.amountPaid * 100),
          currency: CURRENCY,
          key: process.env.RAZORPAY_KEY_ID ?? "",
        },
      },
    };
    res.json(body);
  } catch (err) {
    if (err instanceof TransactionNotFoundError) {
      const body: ApiResponse<never> = { success: false, error: "Transaction not found" };
      res.status(404).json(body);
      return;
    }
    if (err instanceof NotBuyerError) {
      const body: ApiResponse<never> = {
        success: false,
        error: "Only the buyer on this transaction can pay for it",
      };
      res.status(403).json(body);
      return;
    }
    if (err instanceof ReservationNotPayableError) {
      const body: ApiResponse<never> = {
        success: false,
        error: "This reservation is no longer active or has expired",
      };
      res.status(409).json(body);
      return;
    }
    if (err instanceof SellerNotPayoutReadyError) {
      const body: ApiResponse<never> = {
        success: false,
        error: "Seller has not completed payout onboarding",
      };
      res.status(422).json(body);
      return;
    }
    throw err;
  }
});

// Screen-tier statuses meaning money has actually moved into escrow or
// beyond (as opposed to PENDING/RESERVED/EXPIRED, where it hasn't) - see
// the TxnStatus lifecycle comments in shared/src/transaction.ts.
const ESCROWED_OR_LATER: SharedTransaction["status"][] = [
  "ESCROWED",
  "BUYER_CONFIRMED",
  "PAYOUT_RELEASED",
  "DISPUTED",
  "REFUNDED",
];

// The buyer's proof-of-purchase: the listing's screenshot (which exposes
// the QR code and booking ID) is never shown pre-purchase - see
// GET /api/listings/search and GET /api/listings/:id, which both omit it -
// only revealed here, once the buyer has actually paid into escrow.
transactionsRouter.get("/:id/screenshot", requireAuth, async (req, res) => {
  const transactionId = req.params.id as string;

  const transaction = await prisma.transaction.findUnique({
    where: { id: transactionId },
    include: { listing: true },
  });
  if (!transaction) {
    const body: ApiResponse<never> = { success: false, error: "Transaction not found" };
    res.status(404).json(body);
    return;
  }
  if (transaction.buyerId !== req.user!.id) {
    const body: ApiResponse<never> = {
      success: false,
      error: "Only the buyer on this transaction can view its screenshot",
    };
    res.status(403).json(body);
    return;
  }
  if (!ESCROWED_OR_LATER.includes(transaction.status)) {
    const body: ApiResponse<never> = {
      success: false,
      error: "Screenshot is only available once payment is confirmed",
    };
    res.status(409).json(body);
    return;
  }

  const body: ApiResponse<{ screenshotUrl: string | null }> = {
    success: true,
    data: { screenshotUrl: transaction.listing.screenshotUrl },
  };
  res.json(body);
});

// Seller's EMAIL_FORWARD delivery step, required once ESCROWED: forwards
// the original booking confirmation email as an uploaded file
// (image/PDF/.eml/etc - unlike the listing screenshot there's no expected
// mimetype) and/or pasted text. At least one of the two is required.
// Resubmitting (e.g. to fix a mistake) just overwrites the previous
// submission - emailForwardSubmittedAt is what confirm-receipt actually
// gates on, not "first submission wins". This is what unblocks confirm-
// receipt for EMAIL_FORWARD transactions in place of the seller check-in
// IN_PERSON requires - see the CheckInRequiredError/EmailForwardRequiredError
// checks above.
transactionsRouter.post(
  "/:id/email-forward",
  requireAuth,
  uploadEmailForward,
  async (req, res) => {
    const transactionId = req.params.id as string;
    const emailText = requireNonEmptyString(req.body?.emailText);

    try {
      const transaction = await prisma.transaction.findUnique({
        where: { id: transactionId },
        include: { listing: true },
      });
      if (!transaction) throw new TransactionNotFoundError();
      if (transaction.listing.sellerId !== req.user!.id) throw new NotSellerError();
      if (transaction.deliveryMethod !== "EMAIL_FORWARD") throw new WrongDeliveryMethodError();
      if (transaction.status !== "ESCROWED") throw new NotEscrowedError();
      if (!req.file && !emailText) throw new EmailForwardEmptyError();

      let emailForwardFileUrl = transaction.emailForwardFileUrl;
      if (req.file) {
        const filename = `${transactionId}-${randomUUID()}`;
        const uploaded = await storageProvider.upload(req.file.buffer, filename, {
          resourceType: "raw",
          folder: "email-forwards",
        });
        emailForwardFileUrl = uploaded.url;
      }

      const updated = await prisma.transaction.update({
        where: { id: transactionId },
        data: {
          emailForwardFileUrl,
          emailForwardText: emailText ?? transaction.emailForwardText,
          emailForwardSubmittedAt: new Date(),
        },
      });

      const body: ApiResponse<{ transaction: SharedTransaction }> = {
        success: true,
        data: { transaction: toSharedTransaction(updated) },
      };
      res.json(body);
    } catch (err) {
      if (err instanceof TransactionNotFoundError) {
        const body: ApiResponse<never> = { success: false, error: "Transaction not found" };
        res.status(404).json(body);
        return;
      }
      if (err instanceof NotSellerError) {
        const body: ApiResponse<never> = {
          success: false,
          error: "Only the seller on this transaction can submit the forwarded email",
        };
        res.status(403).json(body);
        return;
      }
      if (err instanceof WrongDeliveryMethodError) {
        const body: ApiResponse<never> = {
          success: false,
          error: "This transaction doesn't use email-forward delivery",
        };
        res.status(409).json(body);
        return;
      }
      if (err instanceof NotEscrowedError) {
        const body: ApiResponse<never> = {
          success: false,
          error: "Transaction must be ESCROWED to submit the forwarded email",
        };
        res.status(409).json(body);
        return;
      }
      if (err instanceof EmailForwardEmptyError) {
        const body: ApiResponse<never> = {
          success: false,
          error: "Upload a file or paste the email text - at least one is required",
        };
        res.status(400).json(body);
        return;
      }
      throw err;
    }
  },
);

// Buyer's view of the seller-forwarded booking email (EMAIL_FORWARD only) -
// same access-control pattern as GET /:id/screenshot: buyer-only, only once
// escrowed. Unlike the screenshot endpoint, "not submitted yet" is a normal
// (200) response with null fields rather than a 409, since the buyer's page
// polls this waiting for the seller to act, the same way it polls check-in
// state.
transactionsRouter.get("/:id/email-forward", requireAuth, async (req, res) => {
  const transactionId = req.params.id as string;

  const transaction = await prisma.transaction.findUnique({
    where: { id: transactionId },
  });
  if (!transaction) {
    const body: ApiResponse<never> = { success: false, error: "Transaction not found" };
    res.status(404).json(body);
    return;
  }
  if (transaction.buyerId !== req.user!.id) {
    const body: ApiResponse<never> = {
      success: false,
      error: "Only the buyer on this transaction can view the forwarded email",
    };
    res.status(403).json(body);
    return;
  }
  if (transaction.deliveryMethod !== "EMAIL_FORWARD") {
    const body: ApiResponse<never> = {
      success: false,
      error: "This transaction doesn't use email-forward delivery",
    };
    res.status(409).json(body);
    return;
  }
  if (!ESCROWED_OR_LATER.includes(transaction.status)) {
    const body: ApiResponse<never> = {
      success: false,
      error: "Only available once payment is confirmed",
    };
    res.status(409).json(body);
    return;
  }

  const body: ApiResponse<TransactionEmailForward> = {
    success: true,
    data: {
      text: transaction.emailForwardText,
      fileUrl: transaction.emailForwardFileUrl,
      submittedAt: transaction.emailForwardSubmittedAt?.toISOString() ?? null,
    },
  };
  res.json(body);
});

// Buyer confirms they received/used the ticket. This is what starts the
// payout-release clock: jobs/releasePayouts.ts only picks up transactions
// that are BUYER_CONFIRMED (manually here, or automatically - see
// jobs/autoConfirmStaleEscrows.ts - if the buyer never taps this).
transactionsRouter.post("/:id/confirm-receipt", requireEscrowMode, requireAuth, async (req, res) => {
  const transactionId = req.params.id as string;

  try {
    const transaction = await prisma.transaction.findUnique({
      where: { id: transactionId },
    });
    if (!transaction) throw new TransactionNotFoundError();
    if (transaction.buyerId !== req.user!.id) throw new NotBuyerError();
    // The buyer's own venue check-in is mandatory for both delivery
    // methods. IN_PERSON also needs the seller's venue check-in;
    // EMAIL_FORWARD skips that and instead needs the seller's forwarded
    // booking email to have actually been submitted - see POST
    // /:id/email-forward. Without this, a buyer could confirm receipt of
    // an email-forward ticket the seller never sent.
    if (!transaction.buyerCheckInAt) throw new CheckInRequiredError();
    if (transaction.deliveryMethod === "IN_PERSON" && !transaction.sellerCheckInAt) {
      throw new CheckInRequiredError();
    }
    if (transaction.deliveryMethod === "EMAIL_FORWARD" && !transaction.emailForwardSubmittedAt) {
      throw new EmailForwardRequiredError();
    }

    // Atomic + re-checked so this can't double-confirm under a race.
    const confirmed = await prisma.$queryRaw<{ id: string }[]>`
      UPDATE "Transaction"
      SET status = 'BUYER_CONFIRMED', "confirmedAt" = now()
      WHERE id = ${transactionId} AND status = 'ESCROWED'
      RETURNING id
    `;

    if (confirmed.length === 0) throw new TransactionNotEscrowedError();

    const updated = await prisma.transaction.findUniqueOrThrow({
      where: { id: transactionId },
    });
    const body: ApiResponse<{ transaction: SharedTransaction }> = {
      success: true,
      data: { transaction: toSharedTransaction(updated) },
    };
    res.json(body);
  } catch (err) {
    if (err instanceof TransactionNotFoundError) {
      const body: ApiResponse<never> = { success: false, error: "Transaction not found" };
      res.status(404).json(body);
      return;
    }
    if (err instanceof NotBuyerError) {
      const body: ApiResponse<never> = {
        success: false,
        error: "Only the buyer on this transaction can confirm receipt",
      };
      res.status(403).json(body);
      return;
    }
    if (err instanceof CheckInRequiredError) {
      const body: ApiResponse<never> = {
        success: false,
        error: "both parties must check in near the venue first",
      };
      res.status(409).json(body);
      return;
    }
    if (err instanceof EmailForwardRequiredError) {
      const body: ApiResponse<never> = {
        success: false,
        error: "the seller hasn't forwarded the booking confirmation email yet",
      };
      res.status(409).json(body);
      return;
    }
    if (err instanceof TransactionNotEscrowedError) {
      const body: ApiResponse<never> = {
        success: false,
        error: "Transaction is not in ESCROWED status",
      };
      res.status(409).json(body);
      return;
    }
    throw err;
  }
});

// Either party checks in near the venue close to showtime. Required (both
// buyer and seller) before confirm-receipt is allowed - see the
// CheckInRequiredError check above.
transactionsRouter.post("/:id/check-in", requireEscrowMode, requireAuth, async (req, res) => {
  const transactionId = req.params.id as string;
  const lat = requireFiniteNumber(req.body?.lat);
  const lng = requireFiniteNumber(req.body?.lng);

  if (lat === null || lat < -90 || lat > 90 || lng === null || lng < -180 || lng > 180) {
    const body: ApiResponse<never> = {
      success: false,
      error: "lat and lng are required and must be valid coordinates",
    };
    res.status(400).json(body);
    return;
  }

  try {
    const transaction = await prisma.transaction.findUnique({
      where: { id: transactionId },
      include: { listing: true },
    });
    if (!transaction) throw new TransactionNotFoundError();

    const party = partyForUser(transaction, req.user!.id);
    if (!party) throw new NotPartyError();

    const msUntilShowtime = transaction.listing.showtime.getTime() - Date.now();
    if (msUntilShowtime > CHECK_IN_EARLY_WINDOW_MS) throw new TooEarlyForCheckInError();
    if (msUntilShowtime < -CHECK_IN_LATE_WINDOW_MS) throw new TooLateForCheckInError();

    const distanceMeters = haversineDistanceMeters(
      lat,
      lng,
      transaction.listing.theaterLat,
      transaction.listing.theaterLng,
    );
    if (distanceMeters > CHECK_IN_MAX_DISTANCE_METERS) throw new TooFarFromVenueError();

    const now = new Date();
    const data =
      party === "buyer"
        ? { buyerCheckInLat: lat, buyerCheckInLng: lng, buyerCheckInAt: now }
        : { sellerCheckInLat: lat, sellerCheckInLng: lng, sellerCheckInAt: now };

    const updated = await prisma.transaction.update({ where: { id: transactionId }, data });

    const body: ApiResponse<{ transaction: SharedTransaction }> = {
      success: true,
      data: { transaction: toSharedTransaction(updated) },
    };
    res.json(body);
  } catch (err) {
    if (err instanceof TransactionNotFoundError) {
      const body: ApiResponse<never> = { success: false, error: "Transaction not found" };
      res.status(404).json(body);
      return;
    }
    if (err instanceof NotPartyError) {
      const body: ApiResponse<never> = {
        success: false,
        error: "You are not a party to this transaction",
      };
      res.status(403).json(body);
      return;
    }
    if (err instanceof TooEarlyForCheckInError) {
      const body: ApiResponse<never> = {
        success: false,
        error: "too early to check in - check-in opens 30 minutes before showtime",
      };
      res.status(400).json(body);
      return;
    }
    if (err instanceof TooLateForCheckInError) {
      const body: ApiResponse<never> = {
        success: false,
        error: "too late to check in - check-in closes 20 minutes after showtime",
      };
      res.status(400).json(body);
      return;
    }
    if (err instanceof TooFarFromVenueError) {
      const body: ApiResponse<never> = { success: false, error: "too far from venue" };
      res.status(422).json(body);
      return;
    }
    throw err;
  }
});

// Returns the other party's contact details. In escrow mode, only within
// 30 minutes either side of showtime - not available at all outside that
// window, since there's a whole escrow/check-in sequence to drive that
// timing off of. contact_only mode has none of that (reserve hands the
// contact straight back - see POST /:id/reserve), so this skips the window
// check there and is available for the life of the reservation.
transactionsRouter.get("/:id/contact", requireAuth, async (req, res) => {
  const transactionId = req.params.id as string;

  try {
    const transaction = await prisma.transaction.findUnique({
      where: { id: transactionId },
      include: { listing: { include: { seller: true } }, buyer: true },
    });
    if (!transaction) throw new TransactionNotFoundError();

    const party = partyForUser(transaction, req.user!.id);
    if (!party) throw new NotPartyError();

    if (PAYMENT_MODE === "escrow") {
      const msFromShowtime = Math.abs(transaction.listing.showtime.getTime() - Date.now());
      if (msFromShowtime > CONTACT_WINDOW_MS) throw new ContactWindowClosedError();
    }

    const otherParty = party === "buyer" ? transaction.listing.seller : transaction.buyer;
    // "If a suspended user is encountered anywhere... their contact is
    // shown, hide/exclude them" - applies symmetrically (whichever party
    // is suspended), not just to sellers, since a transaction can predate
    // either side's suspension.
    if (otherParty.suspendedAt) throw new OtherPartySuspendedError();

    // Only when the caller is the buyer (viewing the seller's contact) -
    // buyers aren't rated in this one-directional system, so a seller
    // viewing the buyer's contact gets null here.
    const ratingSummary = party === "buyer" ? await getRatingSummary(otherParty.id) : null;

    const body: ApiResponse<{ contact: TransactionContact }> = {
      success: true,
      data: {
        contact: {
          name: otherParty.name,
          phone: otherParty.phone,
          hasWhatsapp: otherParty.hasWhatsapp,
          ratingSummary,
        },
      },
    };
    res.json(body);
  } catch (err) {
    if (err instanceof TransactionNotFoundError) {
      const body: ApiResponse<never> = { success: false, error: "Transaction not found" };
      res.status(404).json(body);
      return;
    }
    if (err instanceof NotPartyError) {
      const body: ApiResponse<never> = {
        success: false,
        error: "You are not a party to this transaction",
      };
      res.status(403).json(body);
      return;
    }
    if (err instanceof ContactWindowClosedError) {
      const body: ApiResponse<never> = {
        success: false,
        error: "contact info available closer to showtime",
      };
      res.status(403).json(body);
      return;
    }
    if (err instanceof OtherPartySuspendedError) {
      const body: ApiResponse<never> = {
        success: false,
        error: "This user's account is no longer active",
      };
      res.status(403).json(body);
      return;
    }
    throw err;
  }
});

// Buyer reports the seller as a no-show: the seller never checked in, and
// it's been long enough past showtime (the same 20-minute window check-in
// itself closes after - see CHECK_IN_LATE_WINDOW_MS) that it's fair to call
// it. This does NOT auto-refund - it flags the transaction for an admin to
// review and resolve manually, same pattern as the payment-captured-but-
// expired case in handlePaymentCaptured.ts. A dispute where the seller DID
// check in is a different situation (e.g. buyer no-show, wrong seats) and
// isn't handled by this endpoint.
transactionsRouter.post("/:id/dispute", requireAuth, async (req, res) => {
  const transactionId = req.params.id as string;
  const note = requireNonEmptyString(req.body?.note);

  try {
    const transaction = await prisma.transaction.findUnique({
      where: { id: transactionId },
      include: { listing: true },
    });
    if (!transaction) throw new TransactionNotFoundError();
    if (transaction.buyerId !== req.user!.id) throw new NotBuyerError();
    if (transaction.status !== "ESCROWED") throw new TransactionNotEscrowedError();
    if (transaction.sellerCheckInAt) throw new SellerCheckedInError();

    const msSinceShowtime = Date.now() - transaction.listing.showtime.getTime();
    if (msSinceShowtime < CHECK_IN_LATE_WINDOW_MS) throw new TooEarlyToDisputeError();

    // Atomic + re-checked so this can't double-dispute under a race.
    const disputed = await prisma.$queryRaw<{ id: string }[]>`
      UPDATE "Transaction"
      SET status = 'DISPUTED'
      WHERE id = ${transactionId} AND status = 'ESCROWED'
      RETURNING id
    `;
    if (disputed.length === 0) throw new TransactionNotEscrowedError();

    // Every ESCROWED transaction has a razorpayOrderId by construction -
    // that's the only way status becomes ESCROWED (handlePaymentCaptured).
    await prisma.manualReviewFlag.create({
      data: {
        transactionId: transaction.id,
        reason: note ? `seller_no_show: ${note}` : "seller_no_show",
        razorpayOrderId: transaction.razorpayOrderId!,
        amountPaid: transaction.amountPaid,
      },
    });

    const updated = await prisma.transaction.findUniqueOrThrow({
      where: { id: transactionId },
    });
    const body: ApiResponse<{ transaction: SharedTransaction }> = {
      success: true,
      data: { transaction: toSharedTransaction(updated) },
    };
    res.json(body);
  } catch (err) {
    if (err instanceof TransactionNotFoundError) {
      const body: ApiResponse<never> = { success: false, error: "Transaction not found" };
      res.status(404).json(body);
      return;
    }
    if (err instanceof NotBuyerError) {
      const body: ApiResponse<never> = {
        success: false,
        error: "Only the buyer on this transaction can file this dispute",
      };
      res.status(403).json(body);
      return;
    }
    if (err instanceof TransactionNotEscrowedError) {
      const body: ApiResponse<never> = {
        success: false,
        error: "Transaction is not in ESCROWED status",
      };
      res.status(409).json(body);
      return;
    }
    if (err instanceof SellerCheckedInError) {
      const body: ApiResponse<never> = {
        success: false,
        error: "Seller already checked in - this isn't a no-show dispute",
      };
      res.status(409).json(body);
      return;
    }
    if (err instanceof TooEarlyToDisputeError) {
      const body: ApiResponse<never> = {
        success: false,
        error: "too early to report a no-show - wait until 20 minutes after showtime",
      };
      res.status(409).json(body);
      return;
    }
    throw err;
  }
});

// Buyer rates the seller, once, ever, per transaction. Deliberately no
// restriction on transaction status beyond being the buyer: contact_only
// transactions never leave RESERVED and have no confirm-receipt step at
// all to gate this on the way escrow mode might suggest, and even in
// escrow mode a buyer may reasonably want to rate a no-show/disputed
// experience, not just a successfully confirmed one. One-directional by
// design (see the Rating model comment in schema.prisma) - sellers never
// rate buyers, and this route has no equivalent for the reverse.
transactionsRouter.post("/:id/rate", requireAuth, async (req, res) => {
  const transactionId = req.params.id as string;
  const stars = requireFiniteNumber(req.body?.stars);
  const comment = requireNonEmptyString(req.body?.comment);

  if (stars === null || !Number.isInteger(stars) || stars < 1 || stars > 5) {
    const body: ApiResponse<never> = {
      success: false,
      error: "stars must be an integer from 1 to 5",
    };
    res.status(400).json(body);
    return;
  }

  try {
    const transaction = await prisma.transaction.findUnique({
      where: { id: transactionId },
      include: { listing: true },
    });
    if (!transaction) throw new TransactionNotFoundError();
    if (transaction.buyerId !== req.user!.id) throw new NotBuyerError();

    // Fast-path check for the common case (a clear 409 without ever
    // hitting the DB's unique constraint); the P2002 catch below is the
    // real guard against two concurrent rate attempts on the same
    // transaction racing past this check.
    const existing = await prisma.rating.findUnique({ where: { transactionId } });
    if (existing) throw new RatingAlreadyExistsError();

    const rating = await prisma.rating.create({
      data: {
        raterId: req.user!.id,
        ratedUserId: transaction.listing.sellerId,
        transactionId,
        stars,
        comment,
      },
    });

    const body: ApiResponse<{ rating: SharedRating }> = {
      success: true,
      data: { rating: toSharedRating(rating) },
    };
    res.status(201).json(body);
  } catch (err) {
    if (err instanceof TransactionNotFoundError) {
      const body: ApiResponse<never> = { success: false, error: "Transaction not found" };
      res.status(404).json(body);
      return;
    }
    if (err instanceof NotBuyerError) {
      const body: ApiResponse<never> = {
        success: false,
        error: "Only the buyer on this transaction can rate it",
      };
      res.status(403).json(body);
      return;
    }
    // RatingAlreadyExistsError (the pre-check above) and a P2002 unique-
    // constraint violation on Rating.transactionId (a genuine race between
    // two concurrent rate attempts) both mean the same thing to the
    // caller.
    if (
      err instanceof RatingAlreadyExistsError ||
      (err && typeof err === "object" && "code" in err && err.code === "P2002")
    ) {
      const body: ApiResponse<never> = {
        success: false,
        error: "This transaction has already been rated",
      };
      res.status(409).json(body);
      return;
    }
    throw err;
  }
});
