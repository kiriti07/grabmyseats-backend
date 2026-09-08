import { schedule } from "node-cron";
import { expireReservations } from "./expireReservations";
import { autoConfirmStaleEscrows } from "./autoConfirmStaleEscrows";
import { releasePayouts } from "./releasePayouts";
import { matchAlerts } from "./matchAlerts";
import { PAYMENT_MODE } from "../lib/config";

export function startJobs(): void {
  schedule(
    "* * * * *",
    async () => {
      try {
        const count = await expireReservations();
        if (count > 0) console.log(`[jobs] expired ${count} reservation(s)`);
      } catch (err) {
        console.error("[jobs] expireReservations failed", err);
      }
    },
    { name: "expire-reservations", noOverlap: true },
  );

  schedule(
    "*/5 * * * *",
    async () => {
      try {
        const count = await autoConfirmStaleEscrows();
        if (count > 0) console.log(`[jobs] auto-confirmed ${count} stale escrow(s)`);
      } catch (err) {
        console.error("[jobs] autoConfirmStaleEscrows failed", err);
      }
    },
    { name: "auto-confirm-stale-escrows", noOverlap: true },
  );

  // Not scheduled at all in contact_only mode - there's no escrow for this
  // job to release a payout from (see PAYMENT_MODE in lib/config.ts). The
  // job itself stays intact so escrow mode can be re-enabled with no
  // rebuild, just this one line switching it back on.
  if (PAYMENT_MODE === "escrow") {
    schedule(
      "*/5 * * * *",
      async () => {
        try {
          const count = await releasePayouts();
          if (count > 0) console.log(`[jobs] released ${count} payout(s)`);
        } catch (err) {
          console.error("[jobs] releasePayouts failed", err);
        }
      },
      { name: "release-payouts", noOverlap: true },
    );
  }

  schedule(
    "*/5 * * * *",
    async () => {
      try {
        const count = await matchAlerts();
        if (count > 0) console.log(`[jobs] notified ${count} ticket alert(s)`);
      } catch (err) {
        console.error("[jobs] matchAlerts failed", err);
      }
    },
    { name: "match-alerts", noOverlap: true },
  );
}
