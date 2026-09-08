import express, { Router } from "express";
import Razorpay from "razorpay";
import type { ApiResponse } from "@grabmyseats/shared";
import { prisma } from "../lib/prisma";
import { handlePaymentCaptured } from "../lib/payments/handlePaymentCaptured";

export const webhooksRouter = Router();

interface RazorpayPaymentCapturedWebhook {
  event: string;
  payload?: {
    payment?: {
      entity?: {
        id?: string;
        order_id?: string;
      };
    };
  };
}

// Mounted with express.raw() (not express.json()) so req.body is the exact
// byte stream Razorpay signed - signature verification would fail against
// a body that's been parsed and re-serialized, since that can change
// whitespace/key order and produce different bytes.
webhooksRouter.post(
  "/razorpay",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["x-razorpay-signature"];
    const rawBody = req.body;

    if (typeof signature !== "string" || !Buffer.isBuffer(rawBody)) {
      const body: ApiResponse<never> = {
        success: false,
        error: "Missing signature or body",
      };
      res.status(400).json(body);
      return;
    }

    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) {
      console.error("[webhooks] RAZORPAY_WEBHOOK_SECRET is not configured");
      const body: ApiResponse<never> = {
        success: false,
        error: "Webhook not configured",
      };
      res.status(500).json(body);
      return;
    }

    const rawBodyString = rawBody.toString("utf8");
    let isValid: boolean;
    try {
      isValid = Razorpay.validateWebhookSignature(rawBodyString, signature, secret);
    } catch {
      isValid = false;
    }

    if (!isValid) {
      const body: ApiResponse<never> = {
        success: false,
        error: "Invalid webhook signature",
      };
      res.status(400).json(body);
      return;
    }

    let event: RazorpayPaymentCapturedWebhook;
    try {
      event = JSON.parse(rawBodyString);
    } catch {
      const body: ApiResponse<never> = { success: false, error: "Invalid JSON body" };
      res.status(400).json(body);
      return;
    }

    if (event.event !== "payment.captured") {
      // Acknowledge and ignore - we only act on this one event type.
      const body: ApiResponse<{ message: string }> = {
        success: true,
        data: { message: "Event ignored" },
      };
      res.status(200).json(body);
      return;
    }

    const orderId = event.payload?.payment?.entity?.order_id;
    if (!orderId) {
      const body: ApiResponse<never> = {
        success: false,
        error: "payment.captured event missing order_id",
      };
      res.status(400).json(body);
      return;
    }

    const transaction = await prisma.transaction.findUnique({
      where: { razorpayOrderId: orderId },
    });

    if (!transaction) {
      console.error(
        `[webhooks] payment.captured for order ${orderId} has no matching transaction`,
      );
      // 200 so Razorpay doesn't keep retrying a delivery we can never
      // resolve; the error above is what should page someone.
      const body: ApiResponse<{ message: string }> = {
        success: true,
        data: { message: "No matching transaction" },
      };
      res.status(200).json(body);
      return;
    }

    const result = await handlePaymentCaptured(transaction, orderId);
    const body: ApiResponse<{ message: string }> = { success: true, data: result };
    res.status(200).json(body);
  },
);
