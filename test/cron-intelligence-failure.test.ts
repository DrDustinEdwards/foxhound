import { expect, it, vi } from "vitest";

const runs = vi.hoisted(() => ({
  sync: [] as unknown[],
  ai: [] as unknown[],
}));
vi.mock("~/lib/intelligence/sync.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/intelligence/sync.server")>()),
  runIntelligenceSyncForAllAccounts: async () => runs.sync,
}));
vi.mock("~/lib/intelligence/ai-run.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/intelligence/ai-run.server")>()),
  runIntelligenceAiForAllAccounts: async () => runs.ai,
}));

const { CRON_JOBS } = await import("~/lib/cron/registry");

const handler = (name: string) => CRON_JOBS.find((j) => j.name === name)!.handler;

// runScheduledJobs alerts and records a failed run only when the handler throws, so an account
// whose sync failed (a revoked token, a Stripe outage) must not read as a successful run.
it("intelligence-sync throws when an account failed, and succeeds when none did", async () => {
  runs.sync = [
    { accountId: "a", customersProcessed: 3, snapshotWritten: true, truncated: false, error: null },
    { accountId: "b", customersProcessed: 0, snapshotWritten: false, truncated: false, error: "x" },
  ];
  await expect(handler("intelligence-sync")({} as Env)).rejects.toThrow(/1 of 2 accounts failed/);
  runs.sync = [runs.sync[0]];
  await expect(handler("intelligence-sync")({} as Env)).resolves.toMatchObject({
    rowsProcessed: 3,
  });
});

it("intelligence-ai throws when an account failed", async () => {
  runs.ai = [{ accountId: "a", customersScored: 0, error: "boom" }];
  await expect(handler("intelligence-ai")({} as Env)).rejects.toThrow(/1 of 1 accounts failed/);
});
