import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { accounts } from "~/db/schema";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { SendGates } = await import("~/lib/email/dispatch");
const env = {} as Env;

async function liveSends(accountId: string | null): Promise<boolean> {
  const job = { to: "buyer@example.com", accountId };
  return (await SendGates.read(env, [job])).liveSends(job);
}

// The flag is asserted against the real migrations, so "defaults OFF" is the actual column default.

function seedAccount(over: { liveSendsEnabled?: boolean } = {}) {
  const { sqlite, db } = createInMemoryDb();
  harness.db = db;
  runStatement(sqlite, db.insert(accounts).values({ id: "acc_1", name: "Acme", ...over }));
  return { sqlite, db };
}

describe("live-send flag: the column defaults OFF against the real schema", () => {
  it("a freshly created account cannot send live mail", async () => {
    seedAccount();
    expect(await liveSends("acc_1")).toBe(false);
  });

  it("an account switched ON can send", async () => {
    const { sqlite, db } = seedAccount();
    runStatement(
      sqlite,
      db.update(accounts).set({ liveSendsEnabled: true }).where(eq(accounts.id, "acc_1")),
    );
    expect(await liveSends("acc_1")).toBe(true);
  });

  it("FAILS CLOSED for an unknown account", async () => {
    seedAccount();
    expect(await liveSends("acc_does_not_exist")).toBe(false);
  });

  it("FAILS CLOSED for a job carrying no account at all", async () => {
    seedAccount();
    expect(await liveSends(null)).toBe(false);
  });

  it("refuses to answer for an account the read did not cover", async () => {
    // A gate read for one batch of sends must never read "not held" for a job
    // outside that batch.
    seedAccount();
    const gates = await SendGates.read(env, [{ to: "buyer@example.com", accountId: "acc_1" }]);
    expect(() => gates.liveSends({ to: "buyer@example.com", accountId: "acc_2" })).toThrow();
    expect(() => gates.suppressed({ to: "other@example.com", accountId: "acc_1" })).toThrow();
  });
});
