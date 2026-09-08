import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import multer from "multer";
import type { ApiResponse } from "@grabmyseats/shared";
import { attachUser } from "./middleware/auth";
import { attachAdminUser } from "./middleware/adminAuth";
import { InvalidUploadError } from "./middleware/upload";
import { authRouter } from "./routes/auth";
import { listingsRouter } from "./routes/listings";
import { transactionsRouter } from "./routes/transactions";
import { webhooksRouter } from "./routes/webhooks";
import { adminRouter } from "./routes/admin";
import { adminAuthRouter } from "./routes/adminAuth";
import { adminStaffRouter } from "./routes/adminStaff";
import { usersRouter } from "./routes/users";
import { alertsRouter } from "./routes/alerts";
import { fraudReportsRouter } from "./routes/fraudReports";
import { devRouter } from "./routes/dev";

export const app = express();

// Comma-separated so both the apex domain and "www" (or any other
// alternate origin, e.g. a staging site) can be allowed at once - cors
// accepts an array here just as well as a single string. Trimmed so
// "https://a.com, https://b.com" (a space after the comma) works too.
const allowedOrigins = (process.env.FRONTEND_ORIGIN ?? "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
);

// Mounted before express.json(): this route needs the raw request body to
// verify Razorpay's signature, and express.json() would otherwise consume
// and parse the body stream before this router ever sees it.
app.use("/api/webhooks", webhooksRouter);

app.use(express.json());
app.use(attachUser);
app.use(attachAdminUser);

app.get("/health", (_req, res) => {
  const body: ApiResponse<{ status: string }> = {
    success: true,
    data: { status: "ok" },
  };
  res.json(body);
});

app.use("/api/auth", authRouter);
app.use("/api/listings", listingsRouter);
app.use("/api/transactions", transactionsRouter);
app.use("/api/admin/auth", adminAuthRouter);
app.use("/api/admin", adminStaffRouter);
app.use("/api/admin", adminRouter);
app.use("/api/users", usersRouter);
app.use("/api/alerts", alertsRouter);
app.use("/api/fraud-reports", fraudReportsRouter);

// DEV-ONLY. Must NEVER be mounted in production - see routes/dev.ts for
// why. If you're reading this while debugging a prod incident: this
// condition is the only thing standing between that route and the
// internet, so if it's ever wrong, that's the bug to fix.
if (process.env.NODE_ENV !== "production") {
  app.use("/api/dev", devRouter);
}

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  // Logged unconditionally, before any status-code branching below, so
  // every error that reaches this handler - not just the generic 500s -
  // prints its full stack trace server-side. The client-facing response
  // stays generic/safe regardless; this never leaks to the client.
  console.error(err);

  if (err instanceof multer.MulterError || err instanceof InvalidUploadError) {
    const body: ApiResponse<never> = { success: false, error: err.message };
    res.status(400).json(body);
    return;
  }

  const body: ApiResponse<never> = { success: false, error: "Internal server error" };
  res.status(500).json(body);
};
app.use(errorHandler);
