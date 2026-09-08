import multer from "multer";

const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024; // 8MB

export class InvalidUploadError extends Error {}

export const uploadScreenshot = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      cb(new InvalidUploadError("screenshot must be an image file"));
      return;
    }
    cb(null, true);
  },
}).single("screenshot");

// Profile picture upload for PATCH /api/users/me/profile - same
// constraints as uploadScreenshot (image mimetype, 8MB cap), different
// field name. The field is optional at the multer layer: submitting the
// rest of the profile form without picking a new photo is valid and just
// leaves the existing profileImageUrl untouched.
export const uploadProfileImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      cb(new InvalidUploadError("profile image must be an image file"));
      return;
    }
    cb(null, true);
  },
}).single("profileImage");

// The forwarded booking confirmation email can be an image, PDF, .eml, or
// plain text export - unlike uploadScreenshot there's no single expected
// mimetype, so this deliberately has no fileFilter. Still capped at the
// same size limit. The field is optional at the multer layer (a
// text-only submission is also valid) - see POST
// /api/transactions/:id/email-forward for the "at least one of file/text"
// check.
export const uploadEmailForward = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
}).single("emailFile");

// Evidence attached to POST /api/fraud-reports - screenshots, PDFs,
// whatever the reporter has, so no fileFilter (same reasoning as
// uploadEmailForward). Unlike every other upload in this app, more than
// one file is allowed; each is still capped at the same per-file size
// limit. Optional at the multer layer - a report needs a description, but
// not necessarily evidence files.
const MAX_EVIDENCE_FILES = 5;
export const uploadFraudEvidence = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
}).array("evidence", MAX_EVIDENCE_FILES);
