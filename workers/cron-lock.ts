// Per-cron fenced lease Durable Object: the shared CronLock from site-runtime
// ./cron-lock/durable-object (moved there from this file), under the class name
// wrangler binds, so no migration is needed. Addressed by idFromName(cronName).
export { CronLock as CronLockDurableObject } from "@dustinedwards/site-runtime/cron-lock/durable-object";
