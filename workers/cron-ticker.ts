import { DurableObject } from "cloudflare:workers";

import { armTickerIfIdle, runTickerAlarm } from "~/lib/cron/ticker";

// The five-minute ticker Durable Object: one instance, addressed by
// CRON_TICKER_INSTANCE_NAME. Its alarm runs the "*/5 * * * *" jobs every five
// minutes whether or not Cloudflare fires that trigger. What it does, and why,
// is in ~/lib/cron/ticker.ts; this class is the storage shell.
export class CronTickerDurableObject extends DurableObject<Env> {
  /** Set the alarm if none is set. Idempotent; true when it set one. */
  async ensureArmed(): Promise<boolean> {
    return armTickerIfIdle(this.ctx.storage);
  }

  async alarm(): Promise<void> {
    await runTickerAlarm(this.env, this.ctx.storage);
  }
}
