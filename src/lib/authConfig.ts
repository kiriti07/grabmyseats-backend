// Matches Auth.js's own defaults so tokens issued here are structurally
// identical to what @auth/core would issue via its normal sign-in flow.
// See: @auth/core/lib/actions/callback/index.js (salt = cookie name).
export const SESSION_COOKIE_NAME = "authjs.session-token";
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days

export function getAuthSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("AUTH_SECRET environment variable is not set");
  }
  return secret;
}
