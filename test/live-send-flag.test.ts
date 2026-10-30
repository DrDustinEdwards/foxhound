import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { accounts } from "~/db/schema";
import { liveSendsEnabled } from "~/lib/email/dispatch";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// THE LIVE-SEND FLAG, ratified 2026-08-09 in commit 9766ff5 and landed by ruling
// 268 as Session D's own deliverable.
//
// What it replaces is the reason it matters: nothing in this codebase ever CHOSE
// to be a send kill switch. What actually stopped mail leaving was an unset
// PHYSICAL_ADDRESS secret throwing a CAN-SPAM error inside buildEmailMessage, a
// compliance guard doing duty as a switch nobody selected and one populated env
// var away from every eligible account mailing at once.
//
// The column is asserted against the REAL committed migrations, so what proves
// "defaults OFF" is the actual DEFAULT false NOT NULL in 0013, not a TypeScript
// default that would never reach D1.

function seedAccount(over: { liveSendsEnabled?: boolean } = {}) {
  const { sqlite, db } = createInMemoryDb();
  runStatement(
    sqlite,
    db.insert(accounts).values({ id: "acc_1", name: "Acme", ...over }),
  );
  return { sqlite, db };
}

describe("live-send flag: the column defaults OFF against the real schema", () => {
  it("a freshly created account cannot send live mail", async () => {
    // The insert names no flag at all, exactly as every existing account row does,
    // so this is the migration's own DEFAULT false NOT NULL answering.
    const { db } = seedAccount();
    expect(await liveSendsEnabled(db, "acc_1")).toBe(false);
  });

  it("an account switched ON can send", async () => {
    const { sqlite, db } = seedAccount();
    runStatement(
      sqlite,
      db.update(accounts).set({ liveSendsEnabled: true }).where(eq(accounts.id, "acc_1")),
    );
    expect(await liveSendsEnabled(db, "acc_1")).toBe(true);
  });

  it("FAILS CLOSED for an unknown account", async () => {
    const { db } = seedAccount();
    expect(await liveSendsEnabled(db, "acc_does_not_exist")).toBe(false);
  });

  it("FAILS CLOSED for a job carrying no account at all", async () => {
    // EmailJob.accountId is nullable in the type. No live caller passes null
    // (measured 2026-08-12: processEmailJob has exactly two callers, the engine's
    // defaultSend with a non-null context and the queue consumer that nothing
    // enqueues to), so this branch exists so it can never become a bypass.
    const { db } = seedAccount();
    expect(await liveSendsEnabled(db, null)).toBe(false);
  });
});

