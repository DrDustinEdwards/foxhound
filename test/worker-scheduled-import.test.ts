import { describe, expect, it } from "vitest";

import { CRON_SCHEDULE_DAILY } from "~/lib/constants";
import { jobsForSchedule as staticJobsForSchedule } from "~/lib/cron/registry";

// H-2 (foxhound-audit-perf.md): workers/app.ts's scheduled() handler now
// resolves the cron registry via a dynamic `await import("~/lib/cron/registry")`
// instead of a static top-level import, so fetch()/queue() never pull in the
// billing/Intelligence-AI/recovery-tick graph. wrangler dev --test-scheduled's
// /__scheduled interception does not work in this project's local dev setup
// (falls through to the app router and 404s, independent of this change), so
// this test exercises the exact same dynamic-import expression workers/app.ts
// now runs, proving it resolves correctly under this project's module
// resolution rather than relying only on the build output's chunk split.
describe("workers/app.ts scheduled() dynamic cron-registry import", () => {
  it("resolves the same module a static import would", async () => {
    const dynamic = await import("~/lib/cron/registry");
    expect(dynamic.jobsForSchedule).toBeTypeOf("function");
    expect(dynamic.CRON_JOBS).toEqual(expect.any(Array));
  });

  it("dispatches identically to the static import for a real schedule", async () => {
    const { jobsForSchedule: dynamicJobsForSchedule } = await import("~/lib/cron/registry");
    const dynamicResult = dynamicJobsForSchedule(CRON_SCHEDULE_DAILY).map((j) => j.name);
    const staticResult = staticJobsForSchedule(CRON_SCHEDULE_DAILY).map((j) => j.name);
    expect(dynamicResult).toEqual(staticResult);
    expect(dynamicResult).toContain("demo-reset");
  });
});
