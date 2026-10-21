// The win-back gate, called: on an account with Intelligence, a customer not
// flagged winback_priority gets win-back step 1 at WINBACK_UNFLAGGED_STEP1_HOURS;
// a flagged one, or any customer without Intelligence, keeps the schedule's
// default (undefined). This is the engine fact INTELLIGENCE_WINBACK_SENTENCE
// states.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accounts, customerContext } from "~/db/schema";
import { WINBACK_PRIORITY_ACTION, WINBACK_UNFLAGGED_STEP1_HOURS } from "~/lib/constants";
import { createInMemoryDb } from "./helpers/inmemory-db";

const state = vi.hoisted(() => ({ db: undefined as unknown, entitled: false }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => state.db,
}));
vi.mock("~/lib/intelligence/views.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/intelligence/views.server")>()),
  isIntelligenceEntitled: async () => state.entitled,
}));

const { resolveWinbackStep1Offset } = await import("~/lib/webhooks/lookups");
const env = {} as Env;

beforeEach(async () => {
  const { db } = createInMemoryDb();
  state.db = db;
  const now = new Date("2026-10-01T00:00:00Z");
  await db.insert(accounts).values({ id: "acc_1", name: "Mine", currency: "usd", createdAt: now });
  await db.insert(customerContext).values([
    { id: "cc_1", accountId: "acc_1", stripeCustomerId: "cus_plain", healthFactors: {}, createdAt: now, updatedAt: now },
    {
      id: "cc_2",
      accountId: "acc_1",
      stripeCustomerId: "cus_flagged",
      healthFactors: { recommended_action: WINBACK_PRIORITY_ACTION },
      createdAt: now,
      updatedAt: now,
    },
  ]);
});

describe("resolveWinbackStep1Offset", () => {
  it("with Intelligence, an unflagged customer waits WINBACK_UNFLAGGED_STEP1_HOURS", async () => {
    state.entitled = true;
    expect(await resolveWinbackStep1Offset(env, "acc_1", "cus_plain")).toBe(WINBACK_UNFLAGGED_STEP1_HOURS);
    expect(await resolveWinbackStep1Offset(env, "acc_1", "cus_unknown")).toBe(WINBACK_UNFLAGGED_STEP1_HOURS);
  });

  it("with Intelligence, a winback_priority customer keeps the default", async () => {
    state.entitled = true;
    expect(await resolveWinbackStep1Offset(env, "acc_1", "cus_flagged")).toBeUndefined();
  });

  it("without Intelligence, every customer keeps the default", async () => {
    state.entitled = false;
    expect(await resolveWinbackStep1Offset(env, "acc_1", "cus_plain")).toBeUndefined();
  });
});
