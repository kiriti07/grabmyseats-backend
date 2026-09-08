import { Router } from "express";
import type {
  ApiResponse,
  Category,
  TicketAlert as SharedTicketAlert,
} from "@grabmyseats/shared";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { toSharedTicketAlert } from "../lib/serialize";

export const alertsRouter = Router();

const ALL_CATEGORIES: Category[] = ["MOVIE", "EVENT", "SPORT"];
const DEFAULT_RADIUS_KM = 7;
// "extendable" per the product ask isn't implemented in this pass - an
// expired alert just stops matching (see jobs/matchAlerts.ts) and has to
// be recreated.
const ALERT_DURATION_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

function requireNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Accepts a real number (JSON bodies) or a numeric string, matching the
// same helper shape used across the other routes.
function requireFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

class AlertNotFoundError extends Error {}
class NotAlertOwnerError extends Error {}

// Creates a "Notify me" saved search - see jobs/matchAlerts.ts for what
// actually fires it, and GET /:id/search for the identical fuzzy-match +
// radius approach this mirrors. lat/lng are required (the same
// search-origin the buy page already resolved, via geolocation or the
// city picker, before offering this form); cityId is display-only,
// carried through only when that's how the origin was resolved.
alertsRouter.post("/", requireAuth, async (req, res) => {
  const titleQuery = requireNonEmptyString(req.body?.titleQuery);
  const cityId = requireNonEmptyString(req.body?.cityId);
  const lat = requireFiniteNumber(req.body?.lat);
  const lng = requireFiniteNumber(req.body?.lng);

  const errors: string[] = [];
  if (!titleQuery) errors.push("titleQuery is required");
  if (lat === null || lat < -90 || lat > 90) {
    errors.push("lat is required and must be a number between -90 and 90");
  }
  if (lng === null || lng < -180 || lng > 180) {
    errors.push("lng is required and must be a number between -180 and 180");
  }

  let radiusKm = DEFAULT_RADIUS_KM;
  if (req.body?.radiusKm !== undefined) {
    const parsed = requireFiniteNumber(req.body.radiusKm);
    if (parsed === null || parsed <= 0) {
      errors.push("radiusKm must be a positive number");
    } else {
      radiusKm = parsed;
    }
  }

  let category: Category = "MOVIE";
  if (req.body?.category !== undefined) {
    if (
      typeof req.body.category !== "string" ||
      !ALL_CATEGORIES.includes(req.body.category as Category)
    ) {
      errors.push(`category must be one of ${ALL_CATEGORIES.join(", ")}`);
    } else {
      category = req.body.category as Category;
    }
  }

  if (errors.length > 0) {
    const body: ApiResponse<never> = { success: false, error: errors.join("; ") };
    res.status(400).json(body);
    return;
  }

  const alert = await prisma.ticketAlert.create({
    data: {
      userId: req.user!.id,
      titleQuery: titleQuery!,
      cityId,
      lat: lat!,
      lng: lng!,
      radiusKm,
      category,
      expiresAt: new Date(Date.now() + ALERT_DURATION_MS),
    },
  });

  const body: ApiResponse<{ alert: SharedTicketAlert }> = {
    success: true,
    data: { alert: toSharedTicketAlert(alert) },
  };
  res.status(201).json(body);
});

// The caller's own saved searches, newest first - every one regardless of
// isActive/expiresAt (not just currently-live ones), so /account/alerts
// can show cancelled/expired history too rather than just disappearing.
alertsRouter.get("/mine", requireAuth, async (req, res) => {
  const alerts = await prisma.ticketAlert.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: "desc" },
  });
  const body: ApiResponse<{ alerts: SharedTicketAlert[] }> = {
    success: true,
    data: { alerts: alerts.map(toSharedTicketAlert) },
  };
  res.json(body);
});

// Soft-cancel (isActive = false), not a hard delete - preserves the
// alert's AlertNotification history (and the FK it lives behind) and lets
// /account/alerts keep showing it as cancelled rather than it just
// vanishing.
alertsRouter.delete("/:id", requireAuth, async (req, res) => {
  const alertId = req.params.id as string;

  try {
    const existing = await prisma.ticketAlert.findUnique({
      where: { id: alertId },
      select: { id: true, userId: true },
    });
    if (!existing) throw new AlertNotFoundError();
    if (existing.userId !== req.user!.id) throw new NotAlertOwnerError();

    const updated = await prisma.ticketAlert.update({
      where: { id: alertId },
      data: { isActive: false },
    });

    const body: ApiResponse<{ alert: SharedTicketAlert }> = {
      success: true,
      data: { alert: toSharedTicketAlert(updated) },
    };
    res.json(body);
  } catch (err) {
    if (err instanceof AlertNotFoundError) {
      const body: ApiResponse<never> = { success: false, error: "Alert not found" };
      res.status(404).json(body);
      return;
    }
    if (err instanceof NotAlertOwnerError) {
      const body: ApiResponse<never> = {
        success: false,
        error: "Only the owner of this alert can cancel it",
      };
      res.status(403).json(body);
      return;
    }
    throw err;
  }
});
