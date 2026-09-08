import { razorpay } from "../razorpay";
import { prisma } from "../prisma";
import type { LinkedAccountDetails, PayoutProvider } from "./PayoutProvider";

// Real implementation, backed by the Razorpay SDK. Escrow here means: the
// buyer's payment settles into the platform's own Razorpay balance
// (createEscrowOrder creates a plain order, no Route transfer attached),
// and the seller only gets paid out later via a direct transfer
// (releaseTransfer), once the payout-release job decides it's safe to do
// so. This is simpler than Route's "split + on_hold at order creation"
// pattern and matches the three-method shape of PayoutProvider, which has
// no way to pass a destination account into createEscrowOrder.
export class RazorpayPayoutProvider implements PayoutProvider {
  async createLinkedAccount(
    details: LinkedAccountDetails,
  ): Promise<{ accountId: string }> {
    const account = await razorpay.accounts.create({
      email: details.email,
      phone: details.phone.replace(/^\+/, ""),
      type: "standard",
      business_type: "individual",
      legal_business_name: details.name,
      contact_name: details.name,
      // Razorpay requires a business profile for account creation, but the
      // fields it wants (category, registered address, ...) aren't part of
      // LinkedAccountDetails - left minimal. A real integration should
      // collect these for the account to actually get approved.
      profile: {},
      legal_info: { pan: details.pan },
    });

    // Route settlements are enabled via a separate Product Configuration
    // step, not the account-creation call above. Best-effort: the account
    // itself is the durable outcome we need to store, so a failure here
    // (e.g. sandbox limitations) shouldn't block onboarding from proceeding -
    // it just means settlement details need to be attached again later.
    try {
      const product = await razorpay.products.requestProductConfiguration(account.id, {
        product_name: "route",
        tnc_accepted: true,
      });
      await razorpay.products.edit(account.id, product.id, {
        settlements: {
          account_number: details.bankAccountNumber,
          ifsc_code: details.ifsc,
          beneficiary_name: details.name,
        },
      });
    } catch (productErr) {
      console.error(
        `[payments] account ${account.id} created but Route product configuration failed`,
        productErr,
      );
    }

    return { accountId: account.id };
  }

  async createEscrowOrder(
    amount: number,
    currency: string,
  ): Promise<{ orderId: string }> {
    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100),
      currency,
    });
    return { orderId: order.id };
  }

  async releaseTransfer(transactionId: string): Promise<{ transferId: string }> {
    const transaction = await prisma.transaction.findUniqueOrThrow({
      where: { id: transactionId },
      include: { listing: { include: { seller: true } } },
    });

    const sellerAccountId = transaction.listing.seller.razorpayAccountId;
    if (!sellerAccountId) {
      throw new Error(
        `Cannot release transfer for transaction ${transactionId}: seller has no linked payout account`,
      );
    }

    // NOTE: real systems need this to be safe against being called twice
    // for the same transaction (retries, overlapping job runs). Razorpay's
    // Transfers API doesn't take a caller-supplied idempotency key in this
    // SDK version, so a production implementation should check for an
    // existing transfer for this transaction before creating a new one.
    const transfer = await razorpay.transfers.create({
      account: sellerAccountId,
      amount: Math.round(transaction.amountPaid * 100),
      currency: "INR",
    });

    return { transferId: transfer.id };
  }

  // STUBBED - written against the real Refund API but never exercised
  // against a live Razorpay account (this repo has no real credentials -
  // see the RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET comments in .env.example).
  // Same caveat as createLinkedAccount/createEscrowOrder/releaseTransfer
  // above: should work, hasn't been proven to.
  //
  // Razorpay's Refunds API refunds a *payment*, not an order, but this app
  // only ever persists razorpayOrderId (webhooks.ts reads
  // payload.payment.entity.id off the payment.captured event but never
  // stores it). Resolved here via orders.fetchPayments() instead of adding
  // a new column/webhook change - this app creates exactly one order per
  // reservation attempt, so an order has at most one captured payment.
  async refund(transactionId: string): Promise<{ refundId: string }> {
    const transaction = await prisma.transaction.findUniqueOrThrow({
      where: { id: transactionId },
    });

    if (!transaction.razorpayOrderId) {
      throw new Error(
        `Cannot refund transaction ${transactionId}: no razorpayOrderId on record`,
      );
    }

    const { items } = await razorpay.orders.fetchPayments(transaction.razorpayOrderId);
    const captured = items.find((payment) => payment.status === "captured");
    if (!captured) {
      throw new Error(
        `Cannot refund transaction ${transactionId}: no captured payment found for order ${transaction.razorpayOrderId}`,
      );
    }

    // NOTE: same "needs to be safe against being called twice" caveat as
    // releaseTransfer above - a production implementation should check for
    // an existing refund on this payment before creating a new one.
    const refund = await razorpay.payments.refund(captured.id, {
      amount: Math.round(transaction.amountPaid * 100),
    });

    return { refundId: refund.id };
  }
}
