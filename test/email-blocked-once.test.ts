import { describe, expect, it, vi } from "vitest";

import { accounts, emailSends } from "~/db/schema";
import type { EmailJob } from "~/lib/email/types";

import { createInMemoryDb } from "./helpers/inmemory-db";

// A held win-back step stays due, so the cron hands it to processEmailJob every tick. The live-send gate
// logs it blocked once per step, not once per tick.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));
vi.mock("~/lib/email/suppression", () => ({ isSuppressed: async () => false }));

const { processEmailJob } = await import("~/lib/email/dispatch");

const NOW = new Date("2026-11-26T00:00:00.000Z");

function job(stepId: string): EmailJob {
  return {
    accountId: "acc_held",
    winBackStepId: stepId,
    to: "customer@example.com",
    subject: "Come back",
    bodyHtml: "<p>Hi</p>",
    template: "winback",
    unsubscribeToken: "tok",
    physicalAddress: "123 Main St",
    idempotencyKey: `winback-step:${stepId}`,
  };
}

describe("a held win-back step", () => {
  it("is logged blocked once however many ticks see it, and each step has its own row", async () => {
    const made = createInMemoryDb();
    harness.db = made.db;
    await made.db.insert(accounts).values({ id: "acc_held", name: "Held", createdAt: NOW });
    made.sqlite.pragma("foreign_keys = OFF");

    for (let tick = 0; tick < 3; tick++) {
      const result = await processEmailJob({} as Env, job("wbs_1"), null);
      expect(result.status).toBe("blocked");
      expect(result.retryable).toBe(true);
    }
    await processEmailJob({} as Env, job("wbs_2"), null);

    const rows = await made.db.select().from(emailSends);
    expect(rows.map((r) => [r.winBackStepId, r.status]).sort()).toEqual([
      ["wbs_1", "blocked"],
      ["wbs_2", "blocked"],
    ]);
  });
});
