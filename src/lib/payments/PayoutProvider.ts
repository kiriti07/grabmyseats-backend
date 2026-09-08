export interface LinkedAccountDetails {
  name: string;
  email: string;
  phone: string;
  bankAccountNumber: string;
  ifsc: string;
  pan: string;
}

export interface PayoutProvider {
  createLinkedAccount(details: LinkedAccountDetails): Promise<{ accountId: string }>;
  createEscrowOrder(amount: number, currency: string): Promise<{ orderId: string }>;
  releaseTransfer(transactionId: string): Promise<{ transferId: string }>;
  refund(transactionId: string): Promise<{ refundId: string }>;
}
