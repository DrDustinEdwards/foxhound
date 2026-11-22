// Per-cron fenced lease Durable Object: the shared CronLock from site-runtime ./cron-lock/durable-object under the class name wrangler binds, so no migration is needed. Addressed by idFromName(cronName).
export { CronLock as CronLockDurableObject } from "@dustinedwards/site-runtime/cron-lock/durable-object";
