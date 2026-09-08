import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { ApiResponse, FraudReport as SharedFraudReport } from "@grabmyseats/shared";
import { prisma } from "../lib/prisma";
import { storageProvider } from "../lib/storage";
import { requireAuth } from "../middleware/auth";
import { uploadFraudEvidence } from "../middleware/upload";
import { toSharedFraudReport } from "../lib/serialize";

export const fraudReportsRouter = Router();

function requireNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

class ReportedUserNotFoundError extends Error {}
class CannotReportSelfError extends Error {}
class TransactionNotFoundError extends Error {}
class NotPartyToTransactionError extends Error {}

// Lets a buyer or seller report another user for suspected fraud - see
// GET /api/admin/fraud-reports and POST /api/admin/fraud-reports/:id/resolve
// (routes/admin.ts) for the admin side. reportedUserId or reportedPhone
// identifies who's being reported: phone is what the contact-reveal and
// transaction-detail "Report user" entry points actually have on hand
// (TransactionContact - see shared/src/transaction.ts - never carries a
// user id), so it's accepted as an equally valid alternative to an id.
fraudReportsRouter.post("/", requireAuth, uploadFraudEvidence, async (req, res) => {
  const reportedUserId = requireNonEmptyString(req.body?.reportedUserId);
  const reportedPhone = requireNonEmptyString(req.body?.reportedPhone);
  const relatedTransactionId = requireNonEmptyString(req.body?.relatedTransactionId);
  const description = requireNonEmptyString(req.body?.description);

  const errors: string[] = [];
  if (!description) errors.push("description is required");
  if (!reportedUserId && !reportedPhone) {
    errors.push("reportedUserId or reportedPhone is required");
  }
  if (errors.length > 0) {
    const body: ApiResponse<never> = { success: false, error: errors.join("; ") };
    res.status(400).json(body);
    return;
  }

  try {
    const reportedUser = reportedUserId
      ? await prisma.user.findUnique({ where: { id: reportedUserId } })
      : await prisma.user.findUnique({ where: { phone: reportedPhone! } });
    if (!reportedUser) throw new ReportedUserNotFoundError();
    if (reportedUser.id === req.user!.id) throw new CannotReportSelfError();

    // Optional, but when given it's validated: never let someone attach an
    // arbitrary transaction id they had no part in to a report, and never
    // silently accept a nonexistent one.
    if (relatedTransactionId) {
      const transaction = await prisma.transaction.findUnique({
        where: { id: relatedTransactionId },
        include: { listing: true },
      });
      if (!transaction) throw new TransactionNotFoundError();
      const isParty =
        transaction.buyerId === req.user!.id || transaction.listing.sellerId === req.user!.id;
      if (!isParty) throw new NotPartyToTransactionError();
    }

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const evidenceUrls: string[] = [];
    for (const file of files) {
      const filename = `${req.user!.id}-${randomUUID()}`;
      const uploaded = await storageProvider.upload(file.buffer, filename, {
        resourceType: "raw",
        folder: "fraud-evidence",
      });
      evidenceUrls.push(uploaded.url);
    }

    const report = await prisma.fraudReport.create({
      data: {
        reporterId: req.user!.id,
        reportedUserId: reportedUser.id,
        relatedTransactionId,
        description: description!,
        evidenceUrls,
      },
    });

    const body: ApiResponse<{ report: SharedFraudReport }> = {
      success: true,
      data: { report: toSharedFraudReport(report) },
    };
    res.status(201).json(body);
  } catch (err) {
    if (err instanceof ReportedUserNotFoundError) {
      const body: ApiResponse<never> = {
        success: false,
        error: "Could not find that user to report",
      };
      res.status(404).json(body);
      return;
    }
    if (err instanceof CannotReportSelfError) {
      const body: ApiResponse<never> = { success: false, error: "You can't report yourself" };
      res.status(400).json(body);
      return;
    }
    if (err instanceof TransactionNotFoundError) {
      const body: ApiResponse<never> = { success: false, error: "Transaction not found" };
      res.status(404).json(body);
      return;
    }
    if (err instanceof NotPartyToTransactionError) {
      const body: ApiResponse<never> = {
        success: false,
        error: "You are not a party to that transaction",
      };
      res.status(403).json(body);
      return;
    }
    throw err;
  }
});
