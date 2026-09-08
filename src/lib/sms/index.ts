import type { SmsProvider } from "./SmsProvider";
import { ConsoleSmsProvider } from "./ConsoleSmsProvider";

export type { SmsProvider };

// The rest of the app only depends on the SmsProvider interface, so going
// live with a real vendor is a one-file change: add e.g. TwilioSmsProvider
// or Msg91SmsProvider (implementing SmsProvider) next to ConsoleSmsProvider,
// then swap the line below.
export const smsProvider: SmsProvider = new ConsoleSmsProvider();
