import { describe, expect, it } from "vitest";

import { DEMO_ACCOUNT_ID, DEMO_SESSION_COOKIE } from "~/lib/demo/constants";
import { seedDemoAccount } from "~/lib/demo/seed";
import {
  clearDemoCookieHeader,
  demoBlocksMethod,
  hasDemoCookie,
  resolveDemoMembership,
  setDemoCookieHeader,
} from "~/lib/demo/session";

import { createInMemoryDb } from "./helpers/inmemory-db";

const withCookie = (cookie: string) =>
  new Request("https://x/dashboard", { headers: { cookie } });

describe("demo cookie", () => {
  it("detects the demo cookie, and only the demo cookie", () => {
    expect(hasDemoCookie(withCookie(`${DEMO_SESSION_COOKIE}=1`))).toBe(true);
    expect(hasDemoCookie(withCookie(`other=1; ${DEMO_SESSION_COOKIE}=1`))).toBe(true);
    expect(hasDemoCookie(withCookie("other=1"))).toBe(false);
    expect(hasDemoCookie(new Request("https://x/dashboard"))).toBe(false);
    // A different value is not the demo marker.
    expect(hasDemoCookie(withCookie(`${DEMO_SESSION_COOKIE}=0`))).toBe(false);
  });

  it("set/clear headers carry the cookie name and the right lifetime", () => {
    expect(setDemoCookieHeader()).toContain(`${DEMO_SESSION_COOKIE}=1`);
    expect(setDemoCookieHeader()).toContain("HttpOnly");
    expect(clearDemoCookieHeader()).toContain("Max-Age=0");
  });
});

describe("demo read-only gate", () => {
  it("allows reads, blocks every mutation method", () => {
    expect(demoBlocksMethod("GET")).toBe(false);
    expect(demoBlocksMethod("get")).toBe(false);
    expect(demoBlocksMethod("HEAD")).toBe(false);
    expect(demoBlocksMethod("POST")).toBe(true);
    expect(demoBlocksMethod("PUT")).toBe(true);
    expect(demoBlocksMethod("PATCH")).toBe(true);
    expect(demoBlocksMethod("DELETE")).toBe(true);
  });
});

describe("resolveDemoMembership", () => {
  it("returns null before the demo is seeded (so the shell sends the visitor back to /demos)", async () => {
    const { db } = createInMemoryDb();
    expect(await resolveDemoMembership(db)).toBeNull();
  });

  it("resolves to the demo account once seeded, never a real account id", async () => {
    const { db } = createInMemoryDb();
    await seedDemoAccount(db, new Date("2026-07-21T00:00:00.000Z"));
    const membership = await resolveDemoMembership(db);
    expect(membership).not.toBeNull();
    expect(membership!.accountId).toBe(DEMO_ACCOUNT_ID);
    expect(membership!.accountId.startsWith("demo_")).toBe(true);
  });
});
