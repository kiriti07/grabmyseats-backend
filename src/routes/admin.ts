import { Router } from "express";
import type {
  ApiResponse,
  ManualReviewFlag as SharedManualReviewFlag,
  Transaction as SharedTransaction,
  FraudReport as SharedFraudReport,
  FraudReportStatus,
  AdminUserSummary,
  AdminMetrics,
} from "@grabmyseats/shared";
import { LIVE_LISTING_STATUSES } from "@grabmyseats/shared";
import { prisma } from "../lib/prisma";
import {
  toSharedReviewFlag,
  toSharedTransaction,
  toSharedFraudReport,
  toAdminUserSummary,
} from "../lib/serialize";
import { requireAdminAuth, requireRole } from "../middleware/adminAuth";
import { payoutProvider } from "../lib/payments";
import { releaseListingSeats } from "../lib/listingSeats";

export const adminRouter = Router();

const STAFF_ROLES = ["ADMIN", "SUPPORT"] as const;

function requireNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Both ADMIN and SUPPORT can look up a user by phone - the entry point for
// the suspend/unsuspend action on the admin dashboard, since staff only
// ever have a phone number to go on (same reason TransactionContact never
// carries a user id - see shared/src/transaction.ts).
adminRouter.get("/users", requireAdminAuth, requireRole([...STAFF_ROLES]), async (req, res) => {
  const phone = requireNonEmptyString(req.query.phone);
  if (!phone) {
    const body: ApiResponse<never> = { success: false, error: "phone is required" };
    res.status(400).json(body);
    return;
  }

  const user = await prisma.user.findUnique({ where: { phone } });
  const body: ApiResponse<{ user: AdminUserSummary | null }> = {
    success: true,
    data: { user: user ? toAdminUserSummary(user) : null },
  };
  res.json(body);
});

adminRouter.get(
  "/review-flags",
  requireAdminAuth,
  requireRole([...STAFF_ROLES]),
  async (_req, res) => {
    const flags = await prisma.manualReviewFlag.findMany({
      where: { resolvedAt: null },
      orderBy: { createdAt: "asc" },
    });

    const body: ApiResponse<{ flags: SharedManualReviewFlag[] }> = {
      success: true,
      data: { flags: flags.map(toSharedReviewFlag) },
    };
    res.json(body);
  },
);

// Same "still needs attention" shape as GET /review-flags above -
// PENDING/REVIEWED are open, ACTIONED/DISMISSED are resolved.
adminRouter.get(
  "/fraud-reports",
  requireAdminAuth,
  requireRole([...STAFF_ROLES]),
  async (_req, res) => {
    const reports = await prisma.fraudReport.findMany({
      where: { status: { in: ["PENDING", "REVIEWED"] } },
      orderBy: { createdAt: "asc" },
    });

    const body: ApiResponse<{ reports: SharedFraudReport[] }> = {
      success: true,
      data: { reports: reports.map(toSharedFraudReport) },
    };
    res.json(body);
  },
);

class UserNotFoundError extends Error {}
class UserNotSuspendedError extends Error {}

// Suspends a user outright, independent of any specific fraud report (an
// admin might act on something reported outside the app entirely). See
// POST /fraud-reports/:id/resolve below for suspending as part of
// resolving a specific report - same underlying effect, just bundled with
// marking the report ACTIONED.
adminRouter.post(
  "/users/:id/suspend",
  requireAdminAuth,
  requireRole([...STAFF_ROLES]),
  async (req, res) => {
    const userId = req.params.id as string;
    const reason = requireNonEmptyString(req.body?.reason);

    if (!reason) {
      const body: ApiResponse<never> = { success: false, error: "reason is required" };
      res.status(400).json(body);
      return;
    }

    try {
      const existing = await prisma.user.findUnique({ where: { id: userId } });
      if (!existing) throw new UserNotFoundError();

      const updated = await prisma.user.update({
        where: { id: userId },
        data: { suspendedAt: new Date(), suspensionReason: reason },
      });

      const body: ApiResponse<{ user: AdminUserSummary }> = {
        success: true,
        data: { user: toAdminUserSummary(updated) },
      };
      res.json(body);
    } catch (err) {
      if (err instanceof UserNotFoundError) {
        const body: ApiResponse<never> = { success: false, error: "User not found" };
        res.status(404).json(body);
        return;
      }
      throw err;
    }
  },
);

// Reverses POST /users/:id/suspend - clears both fields together, same
// pairing as the suspend side. 409s a user who isn't currently suspended
// rather than silently no-opting, so a double-click or stale UI state
// doesn't look like it succeeded when nothing changed.
adminRouter.post(
  "/users/:id/unsuspend",
  requireAdminAuth,
  requireRole([...STAFF_ROLES]),
  async (req, res) => {
    const userId = req.params.id as string;

    try {
      const existing = await prisma.user.findUnique({ where: { id: userId } });
      if (!existing) throw new UserNotFoundError();
      if (!existing.suspendedAt) throw new UserNotSuspendedError();

      const updated = await prisma.user.update({
        where: { id: userId },
        data: { suspendedAt: null, suspensionReason: null },
      });

      const body: ApiResponse<{ user: AdminUserSummary }> = {
        success: true,
        data: { user: toAdminUserSummary(updated) },
      };
      res.json(body);
    } catch (err) {
      if (err instanceof UserNotFoundError) {
        const body: ApiResponse<never> = { success: false, error: "User not found" };
        res.status(404).json(body);
        return;
      }
      if (err instanceof UserNotSuspendedError) {
        const body: ApiResponse<never> = { success: false, error: "User is not suspended" };
        res.status(409).json(body);
        return;
      }
      throw err;
    }
  },
);

class FraudReportNotFoundError extends Error {}
class FraudReportAlreadyResolvedError extends Error {}

// Marks a fraud report ACTIONED or DISMISSED. ACTIONED can optionally
// suspend the reported user in the same call (suspend: true +
// suspensionReason) - the equivalent of calling POST /users/:id/suspend
// separately, just atomic with the resolution so a report is never left
// ACTIONED without the suspension actually having happened (or vice
// versa).
adminRouter.post(
  "/fraud-reports/:id/resolve",
  requireAdminAuth,
  requireRole([...STAFF_ROLES]),
  async (req, res) => {
  const reportId = req.params.id as string;
  const action = req.body?.action;
  const suspend = req.body?.suspend === true;
  const suspensionReason = requireNonEmptyString(req.body?.suspensionReason);

  const errors: string[] = [];
  if (action !== "ACTIONED" && action !== "DISMISSED") {
    errors.push('action must be "ACTIONED" or "DISMISSED"');
  }
  if (suspend && action !== "ACTIONED") {
    errors.push("suspend can only be used with action ACTIONED");
  }
  if (suspend && !suspensionReason) {
    errors.push("suspensionReason is required when suspend is true");
  }
  if (errors.length > 0) {
    const body: ApiResponse<never> = { success: false, error: errors.join("; ") };
    res.status(400).json(body);
    return;
  }
  const resolvedStatus = action as FraudReportStatus;

  try {
    const report = await prisma.$transaction(async (tx) => {
      const existing = await tx.fraudReport.findUnique({ where: { id: reportId } });
      if (!existing) throw new FraudReportNotFoundError();
      if (existing.status === "ACTIONED" || existing.status === "DISMISSED") {
        throw new FraudReportAlreadyResolvedError();
      }

      if (suspend) {
        await tx.user.update({
          where: { id: existing.reportedUserId },
          data: { suspendedAt: new Date(), suspensionReason: suspensionReason! },
        });
      }

      return tx.fraudReport.update({
        where: { id: reportId },
        data: { status: resolvedStatus, reviewedAt: new Date() },
      });
    });

    const body: ApiResponse<{ report: SharedFraudReport }> = {
      success: true,
      data: { report: toSharedFraudReport(report) },
    };
    res.json(body);
  } catch (err) {
    if (err instanceof FraudReportNotFoundError) {
      const body: ApiResponse<never> = { success: false, error: "Fraud report not found" };
      res.status(404).json(body);
      return;
    }
    if (err instanceof FraudReportAlreadyResolvedError) {
      const body: ApiResponse<never> = {
        success: false,
        error: "This report has already been resolved",
      };
      res.status(409).json(body);
      return;
    }
    throw err;
  }
  },
);

class TransactionNotFoundError extends Error {}
class TransactionNotRefundableError extends Error {}

// Resolves a disputed (or straightforwardly still-escrowed) transaction by
// refunding the buyer and giving the seats back to the listing - the admin
// counterpart to a buyer paying successfully. Only ESCROWED/DISPUTED can be
// refunded: anything earlier hasn't been paid for yet (nothing to refund),
// and anything later (BUYER_CONFIRMED, PAYOUT_RELEASED, REFUNDED itself) is
// already past the point this app can safely claw back automatically.
//
// The external refund call happens before the DB write (mirrors POST
// /api/transactions/:id/pay's shape: check -> external call -> persist),
// not inside prisma.$transaction with it - holding a DB transaction open
// across network I/O to Razorpay is exactly the kind of thing that causes
// connection-pool exhaustion under load. The DB write itself re-checks
// status atomically, so two concurrent refund attempts (or a refund racing
// some other status change) can't both succeed.
adminRouter.post(
  "/transactions/:id/refund",
  requireAdminAuth,
  requireRole([...STAFF_ROLES]),
  async (req, res) => {
    const transactionId = req.params.id as string;

    try {
      const transaction = await prisma.transaction.findUnique({
        where: { id: transactionId },
      });
      if (!transaction) throw new TransactionNotFoundError();
      if (transaction.status !== "ESCROWED" && transaction.status !== "DISPUTED") {
        throw new TransactionNotRefundableError();
      }

      const { refundId } = await payoutProvider.refund(transactionId);

      const updated = await prisma.$transaction(async (tx) => {
        // Atomic + re-checked: guards against a race with another admin
        // action (or a second refund call) between the check above and
        // this write - if status has moved on since, this claims 0 rows
        // and the whole request 409s instead of double-refunding.
        const refunded = await tx.$queryRaw<{ id: string }[]>`
          UPDATE "Transaction"
          SET status = 'REFUNDED', "refundedAt" = now(), "refundId" = ${refundId}
          WHERE id = ${transactionId} AND status IN ('ESCROWED', 'DISPUTED')
          RETURNING id
        `;
        if (refunded.length === 0) throw new TransactionNotRefundableError();

        await releaseListingSeats(tx, transaction.listingId, transaction.seatsCount);

        // Drops this transaction's flag(s) off the unresolved-flags queue
        // automatically - no separate "resolve" action needed for the
        // common case where the refund itself is the resolution.
        await tx.manualReviewFlag.updateMany({
          where: { transactionId, resolvedAt: null },
          data: { resolvedAt: new Date() },
        });

        return tx.transaction.findUniqueOrThrow({ where: { id: transactionId } });
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
      if (err instanceof TransactionNotRefundableError) {
        const body: ApiResponse<never> = {
          success: false,
          error: "Transaction must be ESCROWED or DISPUTED to be refunded",
        };
        res.status(409).json(body);
        return;
      }
      throw err;
    }
  },
);

const ACTIVE_USER_WINDOW_DAYS = 30;
// Not FLAGGED - a flagged listing is still under review, not settled one
// way or the other, so it's neither "active" nor "closed" for this count.
const CLOSED_LISTING_STATUSES = ["SOLD", "EXPIRED", "WITHDRAWN"] as const;

// ADMIN-only (unlike everything else in this file, which SUPPORT can also
// reach) - dashboard-level numbers rather than an individual queue/action.
adminRouter.get("/metrics", requireAdminAuth, requireRole(["ADMIN"]), async (_req, res) => {
  const activeSince = new Date(Date.now() - ACTIVE_USER_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [
    activeUsers30d,
    activeListings,
    closedListings,
    pendingFraudReports,
    pendingReviewFlags,
    supportStaffCount,
  ] = await Promise.all([
    prisma.user.count({ where: { lastLoginAt: { gte: activeSince } } }),
    prisma.listing.count({ where: { status: { in: [...LIVE_LISTING_STATUSES] } } }),
    prisma.listing.count({ where: { status: { in: [...CLOSED_LISTING_STATUSES] } } }),
    prisma.fraudReport.count({ where: { status: { in: ["PENDING", "REVIEWED"] } } }),
    prisma.manualReviewFlag.count({ where: { resolvedAt: null } }),
    prisma.adminUser.count({ where: { role: "SUPPORT", isActive: true } }),
  ]);

  const body: ApiResponse<AdminMetrics> = {
    success: true,
    data: {
      activeUsers30d,
      activeListings,
      closedListings,
      pendingFraudReports,
      pendingReviewFlags,
      supportStaffCount,
    },
  };
  res.json(body);
});
