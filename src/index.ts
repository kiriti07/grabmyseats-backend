import "dotenv/config";
import { app } from "./app";
import { startJobs } from "./jobs";
import { PAYMENT_MODE } from "./lib/config";

// Fails loud instead of silently ignoring a leftover dev-only env var that
// would otherwise let anyone sign in as any phone number in production.
if (process.env.NODE_ENV === "production" && process.env.DEV_OTP_BYPASS_CODE) {
  throw new Error("DEV_OTP_BYPASS_CODE must not be set when NODE_ENV=production");
}

// PAYMENT_MODE is read once, at module load (see lib/config.ts), so a
// process needs an actual restart to pick up an env var change - this
// makes the mode that's *actually* active this run immediately visible in
// the terminal on every boot, instead of having to grep .env or infer it
// from which error a request happens to throw.
console.log(`[config] PAYMENT_MODE=${PAYMENT_MODE}`);

const port = process.env.PORT ? Number(process.env.PORT) : 4000;

app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
});

startJobs();
