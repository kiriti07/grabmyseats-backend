export interface SmsProvider {
  send(phone: string, message: string): Promise<void>;
}
