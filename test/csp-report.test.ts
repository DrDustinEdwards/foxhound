import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { cloudflareContext } from "~/lib/cloudflare-context";
import { CSP_REPORT_PATH } from "~/lib/http/content-security-policy";
import { action } from "~/routes/api/csp-report";

// The CSP report sink. Reading and answering are site-runtime's (tested there);
// what is Foxhound's is what it logs: never a path or a page, because /u/, /p/
// and /e/c/ paths carry one person's token (RULES.md 3.5), and the per-IP bucket.

function post(body: string, ip = "203.0.113.7"): Request {
  return new Request(`https://foxhoundapp.com${CSP_REPORT_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/csp-report", "cf-connecting-ip": ip },
    body,
  });
}

function call(request: Request, allowed = true) {
  const calls: Array<{ name: string; rules: Array<{ limit: number; windowSeconds: number }> }> = [];
  const ns = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      hit: async (rules: Array<{ limit: number; windowSeconds: number }>) => {
        calls.push({ name, rules });
        return { ok: allowed, retryAfterSeconds: 60 };
      },
    }),
  };
  const context = { get: (key: unknown) => (key === cloudflareContext ? { env: { RATE_LIMITER: ns } } : undefined) };
  return { response: action({ request, context, params: {} } as never) as Promise<Response>, calls };
}

const TOKEN_REPORT = JSON.stringify({
  "csp-report": {
    "document-uri": "https://foxhoundapp.com/u/secret-token?x=1",
    "effective-directive": "frame-ancestors",
    "blocked-uri": "https://foxhoundapp.com/p/tok_live_123?session=abc",
    "source-file": "https://foxhoundapp.com/e/c/tok_src",
    disposition: "enforce",
  },
});

afterEach(() => vi.restoreAllMocks());

describe("POST /api/csp-report", () => {
  it("logs the directive and the blocked origin only, never a token path or the page", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const { response, calls } = call(post(TOKEN_REPORT, "198.51.100.9"));
    expect((await response).status).toBe(204);
    expect(calls).toEqual([{ name: "csp-report:198.51.100.9", rules: [{ limit: 20, windowSeconds: 60 }] }]);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual({
      event: "csp_violation",
      directive: "frame-ancestors",
      blocked: "https://foxhoundapp.com",
      disposition: "enforce",
    });
    expect(line).not.toMatch(/tok|secret|session/);
  });

  it("is mounted at the path the policy names", () => {
    expect(readFileSync("app/routes.ts", "utf8")).toContain(
      `route("${CSP_REPORT_PATH.slice(1)}", "./routes/api/csp-report.ts")`,
    );
  });
});
