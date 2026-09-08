import { redis } from "./redis";

const OTP_TTL_SECONDS = 5 * 60;
const OTP_LENGTH = 6;

function otpKey(phone: string): string {
  return `otp:${phone}`;
}

function generateCode(): string {
  const max = 10 ** OTP_LENGTH;
  return Math.floor(Math.random() * max)
    .toString()
    .padStart(OTP_LENGTH, "0");
}

export async function issueOtp(phone: string): Promise<string> {
  const code = generateCode();
  await redis.set(otpKey(phone), code, "EX", OTP_TTL_SECONDS);
  return code;
}

export async function verifyOtp(phone: string, code: string): Promise<boolean> {
  const key = otpKey(phone);
  const stored = await redis.get(key);
  if (stored === null) return false;

  // Always consume the attempt so a code can't be reused or brute-forced.
  await redis.del(key);

  return stored === code;
}
