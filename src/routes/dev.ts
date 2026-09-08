// DEV-ONLY ROUTES. This entire router must never be reachable in
// production - it lets a caller force a transaction into ESCROWED without
// a real, signature-verified Razorpay webhook. It is only mounted in
// app.ts when `process.env.NODE_ENV !== "production"`; do not remove that
// guard, and do not import/mount this router anywhere else.
import { Router } from "express";
import type { ApiResponse } from "@grabmyseats/shared";
import { prisma } from "../lib/prisma";
import { handlePaymentCaptured } from "../lib/payments/handlePaymentCaptured";
import { requireAuth, requireAdmin } from "../middleware/auth";

export const devRouter = Router();

// Manually triggers the exact same logic POST /api/webhooks/razorpay runs
// on a `payment.captured` event, without needing a real webhook delivery
// (signature and all) during local testing. Requires that POST
// /api/transactions/:id/pay has already been called for this transaction
// (so it has a razorpayOrderId) - this endpoint doesn't fabricate one, to
// stay a faithful stand-in for the real flow.
// requireAdmin on top of the NODE_ENV gate: this is still a route that can
// force money-adjacent state, so being non-production isn't enough on its
// own - only admins should be able to call it even in dev/staging.
devRouter.post(
  "/simulate-payment-captured/:transactionId",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const transactionId = req.params.transactionId as string;

    const transaction = await prisma.transaction.findUnique({ where: { id: transactionId } });
    if (!transaction) {
      const body: ApiResponse<never> = { success: false, error: "Transaction not found" };
      res.status(404).json(body);
      return;
    }
    if (!transaction.razorpayOrderId) {
      const body: ApiResponse<never> = {
        success: false,
        error: "Transaction has no razorpayOrderId - call POST /api/transactions/:id/pay first",
      };
      res.status(400).json(body);
      return;
    }

    const result = await handlePaymentCaptured(transaction, transaction.razorpayOrderId);
    const body: ApiResponse<{ message: string }> = { success: true, data: result };
    res.json(body);
  },
);
