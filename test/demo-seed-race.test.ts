import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { accounts } from "~/db";
import { DEMO_ACCOUNT_ID, DEMO_BUSINESSES } from "~/lib/demo/constants";
import { ensureDemoSeededWithLock } from "~/lib/demo/seed";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Two concurrent seeders must not conflict: the lock-injectable core against the real in-memory schema.

/** A granted acquire returns a fencing token; a denied one returns null. */
function stubLock(acquireImpl: () => Promise<string | null> = async () => "tok_demo") {
  return { acquire: vi.fn(acquireImpl), release: vi.fn(async () => undefined) };
}

async function accountExists(db: ReturnType<typeof createInMemoryDb>["db"]): Promise<boolean> {
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.id, DEMO_ACCOUNT_ID));
  return rows.length > 0;
}

/** The reset's finished state: every demo business's account row. */
const demoAccountRows = DEMO_BUSINESSES.map((b) => ({ id: b.accountId, name: b.name }));

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
