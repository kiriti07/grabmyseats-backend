import type { PayoutProvider } from "./PayoutProvider";
import { MockPayoutProvider } from "./MockPayoutProvider";

export type { PayoutProvider, LinkedAccountDetails } from "./PayoutProvider";

// The rest of the app only depends on the PayoutProvider interface, so
// going live with real money is a one-file change: swap the line below for
// `new RazorpayPayoutProvider()` (implemented in ./RazorpayPayoutProvider,
// backed by the real Razorpay SDK) once that's been tested against a real
// account.
export const payoutProvider: PayoutProvider = new MockPayoutProvider();
