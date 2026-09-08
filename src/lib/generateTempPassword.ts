import { randomInt } from "node:crypto";

// Charset avoids visually ambiguous characters (0/O, 1/I/l) - this is
// read off a screen and typed/relayed by hand during hand-off, not
// copy-pasted programmatically.
const CHARSET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
const TEMP_PASSWORD_LENGTH = 16;

// Generates the one-time password for a newly created AdminUser (see POST
// /api/admin/staff) - returned once in that response, in plaintext, for
// the creating ADMIN to hand off securely (Slack DM, in person, etc.).
// Never logged or stored anywhere except as its bcrypt hash.
export function generateTempPassword(): string {
  let password = "";
  for (let i = 0; i < TEMP_PASSWORD_LENGTH; i++) {
    password += CHARSET[randomInt(CHARSET.length)];
  }
  return password;
}
