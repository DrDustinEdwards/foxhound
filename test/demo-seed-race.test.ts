import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { accounts } from "~/db";
import { CRON_JOBS } from "~/lib/cron/registry";
import { DEMO_ACCOUNT_ID, DEMO_BUSINESSES, DEMO_RESET_CRON_NAME } from "~/lib/demo/constants";
import { ensureDemoSeededWithLock } from "~/lib/demo/seed";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Regression coverage for MEDIUM-1 (foxhound-demo-review.md): the demo enter
// action used to select-then-seed with no lock, so two concurrent seeders (two
// visitors, or a visitor racing the daily reset) could 500 on a PK/FK conflict.
// ensureDemoSeededWithLock is the lock-injectable core of ensureDemoSeeded(env),
// so it is exercised here against the real in-memory schema without needing a
// Durable Object namespace.

/** FENCED SINCE 376 ITEM 14: a granted acquire hands back a token and release
 *  takes one, so this stub returns a token rather than `true` and null rather
 *  than `false`. The seed path holds the same contract as the cron runner. */
function stubLock(acquireImpl: () => Promise<string | null> = async () => "tok_demo") {
  // `release` takes a token in the contract and this fake ignores it, so it
  // declares no parameter at all rather than an unused one: a narrower function
  // is assignable, and lint refuses a parameter nothing reads.
  return { acquire: vi.fn(acquireImpl), release: vi.fn(async () => undefined) };
}

async function accountExists(db: ReturnType<typeof createInMemoryDb>["db"]): Promise<boolean> {
  const rows = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, DEMO_ACCOUNT_ID));
  return rows.length > 0;
}

/** The reset's finished state: every demo business's account row. */
const demoAccountRows = DEMO_BUSINESSES.map((b) => ({ id: b.accountId, name: b.name }));

describe("demo-reset cron name is a shared constant (LOW-3 guard)", () => {
  it("the CRON_JOBS demo-reset entry resolves from DEMO_RESET_CRON_NAME", () => {
    expect(CRON_JOBS.find((j) => j.name === DEMO_RESET_CRON_NAME)).toBeTruthy();
  });
});

describe("ensureDemoSeededWithLock", () => {
  it("fast path: every demo account present, returns without touching the lock", async () => {
    const { db } = createInMemoryDb();
    await db.insert(accounts).values(demoAccountRows);
    const lock = stubLock();

    await ensureDemoSeededWithLock(db, lock);

    expect(lock.acquire).not.toHaveBeenCalled();
    expect(lock.release).not.toHaveBeenCalled();
  });

  it("contention: lock denied, polls until the row appears, never seeds itself", async () => {
    const { db } = createInMemoryDb();
    const lock = stubLock(async () => null);

    const ensured = ensureDemoSeededWithLock(db, lock);
    setTimeout(() => {
      void (async () => {
        await db.insert(accounts).values(demoAccountRows);
      })();
    }, 10);
    await ensured;

    expect(lock.release).not.toHaveBeenCalled();
    expect(await accountExists(db)).toBe(true);
  });
});
