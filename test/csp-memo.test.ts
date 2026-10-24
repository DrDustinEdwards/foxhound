import { describe, expect, it, vi } from "vitest";

// The policy's fixed parts are built and validated ONCE (site-runtime's builder
// checks every source, hash and the report sink), and only the nonce changes
// per request. This proves both halves: the builder is not re-run per request,
// and the per-request policy is exactly what the builder itself returns for
// that request's nonce, so no check is bypassed by the substitution.

const builderCalls = vi.hoisted(() => [] as unknown[]);

vi.mock("@dustinedwards/site-runtime/csp", async (importOriginal) => {
  const original = await importOriginal<typeof import("@dustinedwards/site-runtime/csp")>();
  return {
    ...original,
    buildContentSecurityPolicy: (site: Parameters<typeof original.buildContentSecurityPolicy>[0]) => {
      builderCalls.push(site);
      return original.buildContentSecurityPolicy(site);
    },
  };
});

describe("the policy is validated once and only the nonce varies per request", async () => {
  const { buildContentSecurityPolicy, generateNonce } =
    await vi.importActual<typeof import("@dustinedwards/site-runtime/csp")>("@dustinedwards/site-runtime/csp");
  const { applySecurityHeaders } = await import("~/lib/http/content-security-policy");

  it("does not re-run the builder for each response", () => {
    const before = builderCalls.length;
    for (let i = 0; i < 3; i++) applySecurityHeaders(new Response(null), generateNonce(), "https://foxhound.example.com");
    expect(builderCalls.length - before).toBe(0);
  });

  it("gives exactly the builder's own output for that request's nonce", () => {
    const site = builderCalls[0] as Parameters<typeof buildContentSecurityPolicy>[0];
    expect(site).toBeDefined();
    for (let i = 0; i < 5; i++) {
      const nonce = generateNonce();
      const expected = buildContentSecurityPolicy({ ...site, nonce });
      expect(applySecurityHeaders(new Response(null), nonce, "https://foxhound.example.com").headers.get(expected.name)).toBe(expected.value);
    }
  });
});
