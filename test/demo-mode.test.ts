import { describe, expect, it } from "vitest";

import { isAdminPath, resolvesToDemo } from "~/lib/auth/guards";
import {
  BOLT_DEMO,
  DEMO_ACTIVE_ACCOUNT_COOKIE,
  DEMO_SESSION_COOKIE,
  TEAMFLOW_DEMO,
} from "~/lib/demo/constants";
import { activeDemoBusiness, demoBlocksMethod, hasDemoCookie } from "~/lib/demo/session";

const withCookie = (cookie: string) => new Request("https://x/dashboard", { headers: { cookie } });

describe("demo cookie", () => {
  it("detects the demo cookie, and only the demo cookie", () => {
    expect(hasDemoCookie(withCookie(`${DEMO_SESSION_COOKIE}=1`))).toBe(true);
    expect(hasDemoCookie(withCookie(`other=1; ${DEMO_SESSION_COOKIE}=1`))).toBe(true);
    expect(hasDemoCookie(withCookie("other=1"))).toBe(false);
    expect(hasDemoCookie(new Request("https://x/dashboard"))).toBe(false);
    // A different value is not the demo marker.
    expect(hasDemoCookie(withCookie(`${DEMO_SESSION_COOKIE}=0`))).toBe(false);
  });
});

// The cookie only picks among demo businesses, so a forged id never names a real account.
describe("active demo business", () => {
  it("honors a demo business id and nothing else", () => {
    expect(
      activeDemoBusiness(withCookie(`${DEMO_ACTIVE_ACCOUNT_COOKIE}=${BOLT_DEMO.accountId}`)),
    ).toBe(BOLT_DEMO);
    expect(activeDemoBusiness(withCookie(`${DEMO_ACTIVE_ACCOUNT_COOKIE}=acct_real_merchant`))).toBe(
      TEAMFLOW_DEMO,
    );
    expect(activeDemoBusiness(new Request("https://x/dashboard"))).toBe(TEAMFLOW_DEMO);
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

describe("isAdminPath", () => {
  it("does not match non-admin paths, including a prefix lookalike", () => {
    expect(isAdminPath("/dashboard")).toBe(false);
    expect(isAdminPath("/administrator")).toBe(false);
    expect(isAdminPath("/")).toBe(false);
  });
});

describe("resolvesToDemo", () => {
  it("cookie + real session on /admin resolves real, not demo", () => {
    expect(resolvesToDemo(true, true, "/admin")).toBe(false);
    expect(resolvesToDemo(true, true, "/admin/merchants")).toBe(false);
    expect(resolvesToDemo(true, true, "/admin.data")).toBe(false);
  });

  it("no session: an anonymous demo visitor resolves demo on every path", () => {
    expect(resolvesToDemo(false, true, "/dashboard")).toBe(true);
    expect(resolvesToDemo(false, true, "/admin")).toBe(true);
  });

  it("no session, no cookie: never demo", () => {
    expect(resolvesToDemo(false, false, "/dashboard")).toBe(false);
  });
});
