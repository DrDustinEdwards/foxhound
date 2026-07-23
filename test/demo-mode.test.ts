import { describe, expect, it } from "vitest";

import { isAdminPath, resolvesToDemo } from "~/lib/auth/guards";
import { DEMO_ACCOUNT_ID, DEMO_SESSION_COOKIE } from "~/lib/demo/constants";
import { seedDemoAccount } from "~/lib/demo/seed";
import {
  clearDemoCookieHeader,
  DEMO_READ_ONLY_MESSAGE,
  demoBlocksMethod,
  demoFallbackPath,
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

  // TASK-foxhound-demo-system-completion.md Phase 1: one shared copy, reused
  // by appShellMiddleware's 405 and read back by the root ErrorBoundary
  // (app/lib/errors/boundary-message.ts), rather than two routes independently
  // wording "you can't do that here" and drifting.
  it("has one non-empty, human-readable read-only message that names the demo", () => {
    expect(DEMO_READ_ONLY_MESSAGE.length).toBeGreaterThan(0);
    expect(DEMO_READ_ONLY_MESSAGE).toMatch(/demo/i);
    expect(DEMO_READ_ONLY_MESSAGE).not.toMatch(/[–—]/); // no en/em dashes
  });
});

// TASK-foxhound-demo-access-parity.md: demo-over-session precedence. These
// test the pure decision functions directly (same rationale as
// demoBlocksMethod above: no Request/session mocking needed), covering
// exactly the cases the task calls out by name.
describe("isAdminPath", () => {
  it("matches /admin and every nested admin route, including the .data suffix", () => {
    expect(isAdminPath("/admin")).toBe(true);
    expect(isAdminPath("/admin/merchants")).toBe(true);
    expect(isAdminPath("/admin/merchants/123")).toBe(true);
    expect(isAdminPath("/admin.data")).toBe(true);
    expect(isAdminPath("/admin/merchants.data")).toBe(true);
  });

  it("does not match non-admin paths, including a prefix lookalike", () => {
    expect(isAdminPath("/dashboard")).toBe(false);
    expect(isAdminPath("/administrator")).toBe(false);
    expect(isAdminPath("/")).toBe(false);
  });
});

describe("resolvesToDemo (demo-over-session precedence)", () => {
  it("cookie + real session resolves demo membership on app surfaces", () => {
    expect(resolvesToDemo(true, true, "/dashboard")).toBe(true);
    expect(resolvesToDemo(true, true, "/recovery")).toBe(true);
    expect(resolvesToDemo(true, true, "/intelligence/customers/1")).toBe(true);
  });

  it("cookie + real session on /admin resolves real, not demo", () => {
    expect(resolvesToDemo(true, true, "/admin")).toBe(false);
    expect(resolvesToDemo(true, true, "/admin/merchants")).toBe(false);
    expect(resolvesToDemo(true, true, "/admin.data")).toBe(false);
  });

  it("real session with no demo cookie is unaffected (today's behavior)", () => {
    expect(resolvesToDemo(true, false, "/dashboard")).toBe(false);
    expect(resolvesToDemo(true, false, "/admin")).toBe(false);
  });

  it("no session: an anonymous demo visitor resolves demo on every path, including /admin (untouched by this change)", () => {
    expect(resolvesToDemo(false, true, "/dashboard")).toBe(true);
    expect(resolvesToDemo(false, true, "/admin")).toBe(true);
  });

  it("no session, no cookie: never demo", () => {
    expect(resolvesToDemo(false, false, "/dashboard")).toBe(false);
  });
});

describe("demoFallbackPath (shared by the not-yet-seeded fallback and /demo/exit)", () => {
  it("sends a signed-in caller to their own dashboard, an anonymous one to /demos", () => {
    expect(demoFallbackPath(true)).toBe("/dashboard");
    expect(demoFallbackPath(false)).toBe("/demos");
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
