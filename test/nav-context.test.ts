import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { accounts } from "~/db";
import { resolveNavContext } from "~/lib/nav/context.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

// nav assessment F-1 (foxhound-nav-assessment.md), TASK-foxhound-nav-loader-write.md:
// resolveNavContext used to blind-write last_visited_product on every
// product-page GET (read-skipped on product pages, written unconditionally),
// which violated the demo read-only invariant - a demo visitor's browsing
// bled last_visited_product across concurrent demo visitors - and was
// unbounded write amplification for a value that rarely changes. Now: always
// read, write only when the current product differs from the stored value
// AND the account is not demo, deferred via waitUntil.
//
// "No write issued" is asserted with a spy on the real Drizzle db.update
// method (not inference from end state), per the TASK's explicit ask: an
// unchanged-value write that happened to write back the same value would
// look identical to no write at all if only the end state were checked.

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
    await db.insert(accounts).values({ id: "acc_1", name: "Acme", lastVisitedProduct: "dashboard" });
    const updateSpy = vi.spyOn(db, "update");
    const { waitUntil, flush } = collectWaitUntil();

    const nav = await resolveNavContext(db, "acc_1", "/recovery", false, waitUntil);

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

    const nav = await resolveNavContext(db, "acc_1", "/recovery", false, waitUntil);
    await flush();

    expect(nav.activeProductKey).toBe("recovery");
    expect(updateSpy).not.toHaveBeenCalled();
    expect(await storedValue(db, "acc_1")).toBe("recovery");
  });

  it("product page, demo account: never writes, even when the value differs", async () => {
    const { db } = createInMemoryDb();
    await db.insert(accounts).values({ id: "demo_teamflow", name: "Teamflow", lastVisitedProduct: "dashboard" });
    const updateSpy = vi.spyOn(db, "update");
    const { waitUntil, flush } = collectWaitUntil();

    const nav = await resolveNavContext(db, "demo_teamflow", "/recovery", true, waitUntil);
    await flush();

    // The URL still drives the active key for this render...
    expect(nav.activeProductKey).toBe("recovery");
    // ...but nothing was ever written to the shared demo row.
    expect(updateSpy).not.toHaveBeenCalled();
    expect(await storedValue(db, "demo_teamflow")).toBe("dashboard");
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

  it("platform page with no stored value falls back to dashboard, never writes", async () => {
    const { db } = createInMemoryDb();
    await db.insert(accounts).values({ id: "acc_1", name: "Acme" });
    const updateSpy = vi.spyOn(db, "update");
    const { waitUntil, flush } = collectWaitUntil();

    const nav = await resolveNavContext(db, "acc_1", "/settings", false, waitUntil);
    await flush();

    expect(nav.activeProductKey).toBe("dashboard");
    expect(nav.isPlatformPage).toBe(true);
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
