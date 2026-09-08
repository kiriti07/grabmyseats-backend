import Razorpay from "razorpay";

declare global {
  // eslint-disable-next-line no-var
  var razorpay: Razorpay | undefined;
}

export const razorpay =
  global.razorpay ??
  new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });

if (process.env.NODE_ENV !== "production") {
  global.razorpay = razorpay;
}
