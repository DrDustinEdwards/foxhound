import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CSP_REPORT_MAX_BYTES, summariseCspReport } from "~/lib/http/csp-report";
import { CSP_REPORT_PATH } from "~/lib/http/content-security-policy";
import { action } from "~/routes/api/csp-report";

// The CSP report sink (J22, F16). site-runtime's builder refuses a policy with
// no sink, because a blocked script that nobody hears about is how the
// hydration outage in TASK-foxhound-csp-nonce-hydration.md stayed live. The
// endpoint takes a report, logs ONE structured line naming the directive and
// the blocked resource (origin and path only: a query string can carry a token,
// and the page URL is not logged at all), and answers 204.

function post(body: string, contentType = "application/csp-report"): Request {
  return new Request(`https://foxhoundapp.com${CSP_REPORT_PATH}`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  });
}

const call = (request: Request) => action({ request, context: {}, params: {} } as never) as Promise<Response>;

const LEGACY_REPORT = JSON.stringify({
  "csp-report": {
    "document-uri": "https://foxhoundapp.com/u/secret-token?x=1",
    "violated-directive": "script-src-elem",
    "effective-directive": "script-src-elem",
    "blocked-uri": "https://evil.example.com/x.js?session=abc",
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
  it("reads the legacy report-uri shape, keeping only origin and path of the blocked URI", () => {
    expect(summariseCspReport(JSON.parse(LEGACY_REPORT))).toEqual([
      { directive: "script-src-elem", blocked: "https://evil.example.com/x.js", disposition: "enforce" },
    ]);
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
  it("answers 204 and logs one line per violation, with no page URL, query or token in it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await call(post(LEGACY_REPORT));
    expect(response.status).toBe(204);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual({
      event: "csp_violation",
      directive: "script-src-elem",
      blocked: "https://evil.example.com/x.js",
      disposition: "enforce",
    });
    expect(line).not.toContain("secret-token");
    expect(line).not.toContain("session=abc");
  });

  it("accepts the Reporting API content type", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await call(post(REPORTING_API_BATCH, "application/reports+json"));
    expect(response.status).toBe(204);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).not.toContain("a@example.com");
  });

  it("refuses a body over the cap with 413 and logs nothing", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await call(post(`{"csp-report":{"blocked-uri":"${"a".repeat(CSP_REPORT_MAX_BYTES)}"}}`));
    expect(response.status).toBe(413);
    expect(log).not.toHaveBeenCalled();
  });

  it("answers 204 to a malformed body and logs nothing, as Recova's route does", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect((await call(post("not json"))).status).toBe(204);
    expect(log).not.toHaveBeenCalled();
  });

  it("refuses a method other than POST with 405", async () => {
    const response = await call(new Request(`https://foxhoundapp.com${CSP_REPORT_PATH}`, { method: "PUT", body: "{}" }));
    expect(response.status).toBe(405);
  });

  it("is mounted at the path the policy names", () => {
    expect(readFileSync("app/routes.ts", "utf8")).toContain(
      `route("${CSP_REPORT_PATH.slice(1)}", "./routes/api/csp-report.ts")`,
    );
  });
});
