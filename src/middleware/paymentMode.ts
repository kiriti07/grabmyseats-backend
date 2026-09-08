import type { NextFunction, Request, Response } from "express";
import type { ApiResponse } from "@grabmyseats/shared";
import { PAYMENT_MODE } from "../lib/config";

// Gates a route to escrow mode only. Mounted on POST /:id/pay, /:id/check-in,
// and /:id/confirm-receipt (see routes/transactions.ts) so those paths are
// unreachable under PAYMENT_MODE=contact_only without deleting any of the
// code behind them - escrow mode can be re-enabled later with no rebuild.
// 404, not 403: in contact_only mode these routes are meant to look like
// they don't exist, not like a permission was denied.
export function requireEscrowMode(_req: Request, res: Response, next: NextFunction): void {
  if (PAYMENT_MODE !== "escrow") {
    const body: ApiResponse<never> = { success: false, error: "Not found" };
    res.status(404).json(body);
    return;
  }
  next();
}
