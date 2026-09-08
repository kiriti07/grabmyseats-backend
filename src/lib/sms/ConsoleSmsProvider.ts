import type { SmsProvider } from "./SmsProvider";

// Dev-only stub: logs instead of sending. Swap the provider wired up in
// `./index.ts` for a real one (Twilio, MSG91, ...) when ready to go live.
export class ConsoleSmsProvider implements SmsProvider {
  async send(phone: string, message: string): Promise<void> {
    console.log(`[sms] to ${phone}: ${message}`);
  }
}
