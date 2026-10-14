import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RATE_LIMIT_CSP_REPORT } from "~/lib/constants";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { CSP_REPORT_MAX_BYTES, CSP_REPORT_MAX_LOGGED, summariseCspReport } from "~/lib/http/csp-report";
import { CSP_REPORT_PATH } from "~/lib/http/content-security-policy";
import { action } from "~/routes/api/csp-report";

// The CSP report sink (J22, F16). site-runtime's builder refuses a policy with
// no sink, because a blocked script that nobody hears about is how the
// hydration outage in TASK-foxhound-csp-nonce-hydration.md stayed live. The
// endpoint takes a report, logs one structured line per violation (at most
// CSP_REPORT_MAX_LOGGED per request) naming the directive and the blocked
// resource's ORIGIN only, and answers 204. Never a path: for frame-ancestors
// and navigation violations the blocked URL is a Foxhound page, and /u/, /p/
// and /e/c/ paths carry one person's token (RULES.md 3.5).

function post(body: BodyInit, contentType = "application/csp-report", ip = "203.0.113.7"): Request {
  return new Request(`https://foxhoundapp.com${CSP_REPORT_PATH}`, {
    method: "POST",
    headers: { "Content-Type": contentType, "cf-connecting-ip": ip },
    body,
    duplex: "half",
  } as RequestInit);
}

/** A fake RATE_LIMITER namespace recording the keys it was asked about. */
function limiter(allowed: boolean) {
  const calls: Array<{ name: string; limit: number; periodMs: number }> = [];
  const ns = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      check: async (limit: number, periodMs: number) => {
        calls.push({ name, limit, periodMs });
        return { allowed, retryAfterSec: 60 };
      },
    }),
  };
  return { ns, calls };
}

function call(request: Request, allowed = true) {
  const { ns, calls } = limiter(allowed);
  const context = {
    get: (key: unknown) => (key === cloudflareContext ? { env: { RATE_LIMITER: ns } } : undefined),
  };
  return { response: action({ request, context, params: {} } as never) as Promise<Response>, calls };
}

const LEGACY_REPORT = JSON.stringify({
  "csp-report": {
    "document-uri": "https://foxhoundapp.com/u/secret-token?x=1",
    "violated-directive": "script-src-elem",
    "effective-directive": "script-src-elem",
    "blocked-uri": "https://evil.example.com/x.js?session=abc",
    disposition: "enforce",
  },
});

// frame-ancestors: the blocked URL is the Foxhound page that refused framing.
const FRAMED_TOKEN_PAGE = JSON.stringify({
  "csp-report": {
    "document-uri": "https://foxhoundapp.com/p/tok_live_123",
    "effective-directive": "frame-ancestors",
    "blocked-uri": "https://foxhoundapp.com/p/tok_live_123",
    disposition: "enforce",
  },
});

const REPORTING_API_BATCH = JSON.stringify([
  {
    type: "csp-violation",
    url: "https://foxhoundapp.com/login?email=a@example.com",
    body: {
      documentURL: "https://foxhoundapp.com/login?email=a@example.com",
      effectiveDirective: "style-src-elem",
      blockedURL: "inline",
      disposition: "enforce",
    },
  },
]);

afterEach(() => vi.restoreAllMocks());

describe("summariseCspReport", () => {
  it("reads the legacy report-uri shape, keeping only the blocked URI's origin", () => {
    expect(summariseCspReport(JSON.parse(LEGACY_REPORT))).toEqual([
      { directive: "script-src-elem", blocked: "https://evil.example.com", disposition: "enforce" },
    ]);
  });

  it("never keeps a path: a framed /p/:token page is logged as its origin", () => {
    const [violation] = summariseCspReport(JSON.parse(FRAMED_TOKEN_PAGE));
    expect(violation).toEqual({ directive: "frame-ancestors", blocked: "https://foxhoundapp.com", disposition: "enforce" });
    for (const path of ["/u/tok", "/p/tok", "/e/c/tok"]) {
      const [v] = summariseCspReport({ "csp-report": { "blocked-uri": `https://foxhoundapp.com${path}`, "effective-directive": "frame-ancestors" } });
      expect(JSON.stringify(v)).not.toContain("tok");
    }
  });

  it("reads a Reporting API batch and ignores entries that are not CSP violations", () => {
    const batch = [...JSON.parse(REPORTING_API_BATCH), { type: "deprecation", body: {} }];
    expect(summariseCspReport(batch)).toEqual([{ directive: "style-src-elem", blocked: "inline", disposition: "enforce" }]);
  });

  it("returns nothing for a body that is not a report", () => {
    expect(summariseCspReport({ hello: "world" })).toEqual([]);
    expect(summariseCspReport(null)).toEqual([]);
  });
});

describe("POST /api/csp-report", () => {
  it("answers 204 and logs one line per violation, with no page URL, path, query or token in it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await call(post(LEGACY_REPORT)).response;
    expect(response.status).toBe(204);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual({
      event: "csp_violation",
      directive: "script-src-elem",
      blocked: "https://evil.example.com",
      disposition: "enforce",
    });
    expect(line).not.toContain("secret-token");
    expect(line).not.toContain("session=abc");
    expect(line).not.toContain("x.js");
  });

  it("logs a framed token page without its token", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect((await call(post(FRAMED_TOKEN_PAGE)).response).status).toBe(204);
    expect(String(log.mock.calls[0]?.[0])).not.toContain("tok_live_123");
  });

  it("accepts the Reporting API content type", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await call(post(REPORTING_API_BATCH, "application/reports+json")).response;
    expect(response.status).toBe(204);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).not.toContain("a@example.com");
  });

  it(`logs at most CSP_REPORT_MAX_LOGGED (${CSP_REPORT_MAX_LOGGED}) lines however many violations one body holds`, async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const many = JSON.stringify(
      Array.from({ length: 100 }, () => ({ type: "csp-violation", body: { effectiveDirective: "img-src", blockedURL: "data" } })),
    );
    expect(many.length).toBeLessThan(CSP_REPORT_MAX_BYTES);
    expect((await call(post(many, "application/reports+json")).response).status).toBe(204);
    expect(CSP_REPORT_MAX_LOGGED).toBe(5);
    expect(log).toHaveBeenCalledTimes(CSP_REPORT_MAX_LOGGED);
  });

  it("spends the per-IP csp-report bucket, 20 a minute", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { response, calls } = call(post(LEGACY_REPORT, "application/csp-report", "198.51.100.9"));
    expect((await response).status).toBe(204);
    expect(RATE_LIMIT_CSP_REPORT).toEqual({ max: 20, windowMs: 60_000 });
    expect(calls).toEqual([{ name: "csp-report:198.51.100.9", limit: 20, periodMs: 60_000 }]);
  });

  it("over the limit answers 204 (browsers ignore the answer, as on Recova) and logs nothing", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await call(post(LEGACY_REPORT), false).response;
    expect(response.status).toBe(204);
    expect(log).not.toHaveBeenCalled();
  });

  it("refuses a body over the cap with 413 and logs nothing", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await call(post(`{"csp-report":{"blocked-uri":"${"a".repeat(CSP_REPORT_MAX_BYTES)}"}}`)).response;
    expect(response.status).toBe(413);
    expect(log).not.toHaveBeenCalled();
  });

  it("stops reading a chunked body with no Content-Length at the cap instead of buffering all of it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const chunk = new TextEncoder().encode("a".repeat(1024));
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 200) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const request = post(stream);
    expect(request.headers.get("content-length")).toBeNull();
    const response = await call(request).response;
    expect(response.status).toBe(413);
    // 16 chunks of 1 KiB reach the cap; a reader that buffered everything pulls 201.
    expect(pulled).toBeLessThan(CSP_REPORT_MAX_BYTES / 1024 + 4);
    expect(log).not.toHaveBeenCalled();
  });

  it("answers 204 to a malformed body and logs nothing, as Recova's route does", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect((await call(post("not json")).response).status).toBe(204);
    expect(log).not.toHaveBeenCalled();
  });

  it("refuses a method other than POST with 405", async () => {
    const response = await call(new Request(`https://foxhoundapp.com${CSP_REPORT_PATH}`, { method: "PUT", body: "{}" })).response;
    expect(response.status).toBe(405);
  });

  it("is mounted at the path the policy names", () => {
    expect(readFileSync("app/routes.ts", "utf8")).toContain(
      `route("${CSP_REPORT_PATH.slice(1)}", "./routes/api/csp-report.ts")`,
    );
  });
});
