// Deliberately distinct from lib/authConfig.ts's customer-facing
// SESSION_COOKIE_NAME/AUTH_SECRET - a completely separate cookie and
// secret means an admin session and a customer session can never be
// confused for one another (decoding a customer token with the admin
// secret/salt, or vice versa, just fails), and revoking/rotating one
// system's secret can never affect the other's.
export const ADMIN_SESSION_COOKIE_NAME = "admin_session";
// Shorter-lived than the customer session (30 days) - an internal tool
// with the ability to suspend users and issue refunds warrants a tighter
// re-auth window than a ticket marketplace login.
export const ADMIN_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60; // 12 hours

export function getAdminAuthSecret(): string {
  const secret = process.env.ADMIN_AUTH_SECRET;
  if (!secret) {
    throw new Error("ADMIN_AUTH_SECRET environment variable is not set");
  }
  return secret;
}
