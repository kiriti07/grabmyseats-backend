// Deliberately loose (no full RFC 5322 parsing) - just enough to catch
// obvious typos on the profile form (PATCH /api/users/me/profile) without
// rejecting real addresses a stricter regex might choke on.
export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
