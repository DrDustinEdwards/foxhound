import { CronTicker } from "@dustinedwards/site-runtime/cron-lock/durable-object";

import { runTickerJobs } from "~/lib/cron/ticker";

// The five-minute ticker Durable Object: one instance, addressed by
// CRON_TICKER_INSTANCE_NAME. The shared CronTicker owns the alarm (re-arm first,
// arm only when idle); run() is Foxhound's jobs, in ~/lib/cron/ticker.ts.
export class CronTickerDurableObject extends CronTicker<Env> {
  run() {
    return runTickerJobs(this.env);
  }
}
