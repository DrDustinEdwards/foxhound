import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { accounts } from "~/db";
import { CRON_JOBS } from "~/lib/cron/registry";
import { DEMO_ACCOUNT_ID, DEMO_RESET_CRON_NAME } from "~/lib/demo/constants";
import { ensureDemoSeededWithLock } from "~/lib/demo/seed";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Regression coverage for MEDIUM-1 (foxhound-demo-review.md): the demo enter
// action used to select-then-seed with no lock, so two concurrent seeders (two
// visitors, or a visitor racing the daily reset) could 500 on a PK/FK conflict.
// ensureDemoSeededWithLock is the lock-injectable core of ensureDemoSeeded(env),
// so it is exercised here against the real in-memory schema without needing a
// Durable Object namespace.

function stubLock(acquireImpl: () => Promise<boolean> = async () => true) {
  return { acquire: vi.fn(acquireImpl), release: vi.fn(async () => undefined) };
}

async function accountExists(db: ReturnType<typeof createInMemoryDb>["db"]): Promise<boolean> {
  const rows = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, DEMO_ACCOUNT_ID));
  return rows.length > 0;
}

describe("demo-reset cron name is a shared constant (LOW-3 guard)", () => {
  it("the CRON_JOBS demo-reset entry resolves from DEMO_RESET_CRON_NAME", () => {
    expect(CRON_JOBS.find((j) => j.name === DEMO_RESET_CRON_NAME)).toBeTruthy();
  });
});

describe("ensureDemoSeededWithLock", () => {
  it("fast path: seeded account present, returns without touching the lock", async () => {
    const { db } = createInMemoryDb();
    await db.insert(accounts).values({ id: DEMO_ACCOUNT_ID, name: "Teamflow" });
    const lock = stubLock();

    await ensureDemoSeededWithLock(db, lock);

    expect(lock.acquire).not.toHaveBeenCalled();
    expect(lock.release).not.toHaveBeenCalled();
  });

  it("cold miss: account absent, lock grants, seeds, then releases", async () => {
    const { db } = createInMemoryDb();
    const lock = stubLock();

    await ensureDemoSeededWithLock(db, lock);

    expect(lock.acquire).toHaveBeenCalledTimes(1);
    expect(lock.release).toHaveBeenCalledTimes(1);
    expect(await accountExists(db)).toBe(true);
  });

  it("releases the lock even when seeding throws", async () => {
    const { db } = createInMemoryDb();
    const lock = stubLock();
    const originalInsert = db.insert.bind(db);
    (db as unknown as { insert: typeof db.insert }).insert = (() => {
      throw new Error("boom");
    }) as typeof db.insert;

    await expect(ensureDemoSeededWithLock(db, lock)).rejects.toThrow("boom");

    expect(lock.acquire).toHaveBeenCalledTimes(1);
    expect(lock.release).toHaveBeenCalledTimes(1);
    (db as unknown as { insert: typeof db.insert }).insert = originalInsert;
  });

  it("contention: lock denied, polls until the row appears, never seeds itself", async () => {
    const { db } = createInMemoryDb();
    const lock = stubLock(async () => false);

    const ensured = ensureDemoSeededWithLock(db, lock);
    setTimeout(() => {
      void (async () => {
        await db.insert(accounts).values({ id: DEMO_ACCOUNT_ID, name: "Teamflow" });
      })();
    }, 10);
    await ensured;

    expect(lock.release).not.toHaveBeenCalled();
    expect(await accountExists(db)).toBe(true);
  });
});
