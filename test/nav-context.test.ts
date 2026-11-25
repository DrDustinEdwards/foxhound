import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { accounts } from "~/db";
import { resolveNavContext } from "~/lib/nav/context.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

// resolveNavContext writes last_visited_product only when it changed and the account is not demo, deferred via waitUntil.
// "No write" is asserted with a spy on db.update.

function collectWaitUntil() {
  const pending: Promise<unknown>[] = [];
  const waitUntil = (p: Promise<unknown>) => {
    pending.push(p);
  };
  return { waitUntil, flush: () => Promise.all(pending) };
}

async function storedValue(db: ReturnType<typeof createInMemoryDb>["db"], accountId: string) {
  const rows = await db
    .select({ lastVisitedProduct: accounts.lastVisitedProduct })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  return rows[0]?.lastVisitedProduct ?? null;
}

describe("resolveNavContext", () => {
  it("product page, real account, value changed: writes the new value, deferred via waitUntil", async () => {
    const { db } = createInMemoryDb();
    await db
      .insert(accounts)
      .values({ id: "acc_1", name: "Acme", lastVisitedProduct: "dashboard" });
    const updateSpy = vi.spyOn(db, "update");
    const { waitUntil, flush } = collectWaitUntil();

    const nav = await resolveNavContext(db, "acc_1", "/recovery/dashboard", false, waitUntil);

    expect(nav.activeProductKey).toBe("recovery");
    expect(nav.isPlatformPage).toBe(false);
    expect(updateSpy).toHaveBeenCalledTimes(1);

    await flush();
    expect(await storedValue(db, "acc_1")).toBe("recovery");
  });

  it("product page, real account, value unchanged: no write is issued", async () => {
    const { db } = createInMemoryDb();
    await db.insert(accounts).values({ id: "acc_1", name: "Acme", lastVisitedProduct: "recovery" });
    const updateSpy = vi.spyOn(db, "update");
    const { waitUntil, flush } = collectWaitUntil();

    const nav = await resolveNavContext(db, "acc_1", "/recovery/dashboard", false, waitUntil);
    await flush();

    expect(nav.activeProductKey).toBe("recovery");
    expect(updateSpy).not.toHaveBeenCalled();
    expect(await storedValue(db, "acc_1")).toBe("recovery");
  });

  it("platform page: uses the stored fallback, never writes", async () => {
    const { db } = createInMemoryDb();
    await db.insert(accounts).values({ id: "acc_1", name: "Acme", lastVisitedProduct: "disputes" });
    const updateSpy = vi.spyOn(db, "update");
    const { waitUntil, flush } = collectWaitUntil();

    const nav = await resolveNavContext(db, "acc_1", "/settings", false, waitUntil);
    await flush();

    expect(nav.activeProductKey).toBe("disputes");
    expect(nav.isPlatformPage).toBe(true);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(await storedValue(db, "acc_1")).toBe("disputes");
  });
});
