import { randomUUID } from "node:crypto";
import { Router } from "express";
import type {
  ApiResponse,
  RatingSummary,
  SellerDeliveryEligibility,
  User as SharedUser,
} from "@grabmyseats/shared";
import { prisma } from "../lib/prisma";
import { storageProvider } from "../lib/storage";
import { requireAuth } from "../middleware/auth";
import { uploadProfileImage } from "../middleware/upload";
import { getSellerDeliveryEligibility } from "../lib/sellerTrust";
import { getRatingSummary } from "../lib/ratingSummary";
import { toSharedUser } from "../lib/serialize";
import { isValidEmail } from "../lib/validators";

export const usersRouter = Router();

// Whether this user currently qualifies to offer EMAIL_FORWARD delivery as
// a seller - the sell form calls this to explain the trust gate (rather
// than just hiding the option) before the seller picks delivery methods.
// See lib/sellerTrust.ts, which POST /api/listings also enforces
// server-side.
usersRouter.get("/me/delivery-eligibility", requireAuth, async (req, res) => {
  const eligibility = await getSellerDeliveryEligibility(req.user!.id);
  const body: ApiResponse<SellerDeliveryEligibility> = { success: true, data: eligibility };
  res.json(body);
});

usersRouter.get("/me/profile", requireAuth, async (req, res) => {
  const body: ApiResponse<{ user: SharedUser }> = {
    success: true,
    data: { user: toSharedUser(req.user!) },
  };
  res.json(body);
});

// Public, unauthenticated - the aggregate consumed by the listing detail
// page and the contact-reveal screen (which embed it themselves without
// exposing a user id - see sellerRatingSummary/TransactionContact.ratingSummary),
// and also directly callable with an id, e.g. from a future seller
// profile page. No existence check on :id: a bogus/nonexistent id and a
// real seller with zero ratings both just come back as "no ratings" -
// deliberately indistinguishable, rather than a 404 that would let this
// endpoint be used to probe which user ids exist.
usersRouter.get("/:id/rating-summary", async (req, res) => {
  const userId = req.params.id as string;
  const summary = await getRatingSummary(userId);
  const body: ApiResponse<RatingSummary> = { success: true, data: summary };
  res.json(body);
});

function requireNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Edits the profile fields below - phone is deliberately absent from this
// endpoint entirely: it's the OTP-verified login identity, and changing it
// is a separate, more careful flow to design later, not part of this one.
// Every text field here is a full replace, not a partial merge - the edit
// form always submits the whole profile, so an omitted/blank optional
// field means "clear it". profileImageUrl is the one exception: it only
// changes when a profileImage file is actually attached to this request,
// same "send only what's changing" shape as PATCH /api/listings/:id.
usersRouter.patch("/me/profile", requireAuth, uploadProfileImage, async (req, res) => {
  const fullName = requireNonEmptyString(req.body?.fullName);
  const email = requireNonEmptyString(req.body?.email);
  const dateOfBirthRaw = requireNonEmptyString(req.body?.dateOfBirth);
  const gender = requireNonEmptyString(req.body?.gender);
  const address = requireNonEmptyString(req.body?.address);
  // A checkbox, not free text - multipart fields are always strings, so
  // this is "true" or absent/anything else, not a real boolean on the
  // wire. Always sent by the edit form (no "omitted means unchanged" case
  // the text fields above have).
  const hasWhatsapp = req.body?.hasWhatsapp === "true";

  const errors: string[] = [];
  if (!fullName) errors.push("fullName is required");
  if (email && !isValidEmail(email)) errors.push("email must be a valid email address");

  let dateOfBirth: Date | null = null;
  if (dateOfBirthRaw) {
    const parsed = new Date(dateOfBirthRaw);
    if (Number.isNaN(parsed.getTime())) {
      errors.push("dateOfBirth must be a valid date");
    } else if (parsed.getTime() > Date.now()) {
      errors.push("dateOfBirth cannot be in the future");
    } else {
      dateOfBirth = parsed;
    }
  }

  if (errors.length > 0) {
    const body: ApiResponse<never> = { success: false, error: errors.join("; ") };
    res.status(400).json(body);
    return;
  }

  let profileImageUrl: string | undefined;
  if (req.file) {
    const filename = `${req.user!.id}-${randomUUID()}`;
    const uploaded = await storageProvider.upload(req.file.buffer, filename, {
      folder: "profiles",
    });
    profileImageUrl = uploaded.url;
  }

  try {
    const updated = await prisma.user.update({
      where: { id: req.user!.id },
      data: {
        fullName,
        email,
        dateOfBirth,
        gender,
        address,
        hasWhatsapp,
        ...(profileImageUrl ? { profileImageUrl } : {}),
      },
    });

    const body: ApiResponse<{ user: SharedUser }> = {
      success: true,
      data: { user: toSharedUser(updated) },
    };
    res.json(body);
  } catch (err) {
    // Unique constraint violation on email (Prisma error code P2002) -
    // checked structurally rather than importing PrismaClientKnownRequestError,
    // matching the loose Prisma-error handling already used elsewhere in
    // this codebase (see the theaterLocation catch in POST /api/listings).
    if (err && typeof err === "object" && "code" in err && err.code === "P2002") {
      const body: ApiResponse<never> = {
        success: false,
        error: "That email is already in use by another account",
      };
      res.status(409).json(body);
      return;
    }
    throw err;
  }
});
