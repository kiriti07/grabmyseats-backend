import { randomUUID } from "node:crypto";
import type { LinkedAccountDetails, PayoutProvider } from "./PayoutProvider";

// Dev-only stub: no external calls, always succeeds, returns fake ids.
// Swap the provider wired up in `./index.ts` for a real one
// (RazorpayPayoutProvider, ...) when ready to move real money.
export class MockPayoutProvider implements PayoutProvider {
  async createLinkedAccount(_details: LinkedAccountDetails): Promise<{ accountId: string }> {
    return { accountId: `mock_acc_${randomUUID()}` };
  }

  async createEscrowOrder(_amount: number, _currency: string): Promise<{ orderId: string }> {
    return { orderId: `mock_order_${randomUUID()}` };
  }

  async releaseTransfer(_transactionId: string): Promise<{ transferId: string }> {
    return { transferId: `mock_transfer_${randomUUID()}` };
  }

  async refund(_transactionId: string): Promise<{ refundId: string }> {
    return { refundId: `mock_refund_${randomUUID()}` };
  }
}
