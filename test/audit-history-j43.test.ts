import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J43 (job_3b8776847895), row U2: the signed-in audit history is Recova's
// /audit/dashboard (app/audit/dashboard/page.tsx at blob 988c190a and
// AuditSettingsForm.tsx at blob 9016a436, both read whole), built from Capsomer
// 0.9.0's parts and teal throughout (Q10, Q11, Q12). Recova is the spec for the
// path, every section and its order: the header with Run new audit, the AI
// summary, Since last run, History, and the Settings card with the lookback
// period and the monthly digest, saving as they change.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const ACCOUNT_A = "acct_alpha";
const ACCOUNT_B = "acct_beta";

let sqlite: ReturnType<typeof createInMemoryDb>["sqlite"];

beforeEach(() => {
  const made = createInMemoryDb();
  sqlite = made.sqlite;
  harness.db = made.db;
  for (const id of [ACCOUNT_A, ACCOUNT_B]) {
    sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, 1000)").run(id, id);
  }
});

function contextFor(accountId: string): unknown {
  return {
    get(key: unknown) {
      if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
      if (key === authContext) {
        return {
          userId: "user_1",
          userName: "user_1",
          email: "owner@alpha.test",
          membership: { memberId: "m", accountId, accountName: accountId, role: "owner" },
          memberships: [],
          activeAccountId: accountId,
          isAdmin: false,
          isDemo: false,
          demoSignedIn: false,
        };
      }
      throw new Error("unexpected context key");
    },
  };
}

describe("J43: the path is Recova's /audit/dashboard", () => {
  const routes = read("app/routes.ts");

  it("mounts the page at /audit/dashboard inside the app shell", () => {
    expect(routes).toContain('route("dashboard", "./routes/app/audit/dashboard.tsx")');
    expect(routes).not.toContain('route("history", "./routes/app/audit/history.tsx")');
  });

  it("answers the old /audit/history with one 301 to /audit/dashboard, keeping the query", async () => {
    expect(routes).toContain('route("audit/history", "./routes/audit/history-redirect.ts")');
    const mod = await import("~/routes/audit/history-redirect");
    const res = (await mod.loader({
      request: new Request("https://foxhoundapp.test/audit/history?x=1"),
      params: {},
      context: {},
    } as never)) as Response;
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("/audit/dashboard?x=1");
  });

  it("no link anywhere in app/ still points at /audit/history", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !p.endsWith("history-redirect.ts") && !p.endsWith("routes.ts")) {
          if (stripComments(readFileSync(p, "utf8")).includes("/audit/history")) hits.push(p.slice(ROOT.length));
        }
      }
    };
    walk(join(ROOT, "app"));
    expect(hits).toEqual([]);
  });

  it("robots, the sitemap exclusions and the no-transform list name the new path", () => {
    expect(read("app/routes/files/robots.ts")).toContain('"/audit/dashboard",');
    expect(read("app/lib/http/cache-policy.ts")).toContain('"/audit/dashboard",');
  });
});

describe("J43: Since last run, Recova's compare()", async () => {
  const { compareRuns } = await import("~/lib/audit/trend");

  it("says no change when both are zero, and under 5% of a non-zero baseline", () => {
    expect(compareRuns(0, 0, false, "usd", "usd")).toEqual({ kind: "unchanged" });
    expect(compareRuns(10_400, 10_000, true, "usd", "usd")).toEqual({ kind: "unchanged" });
  });

  it("rounds the percentage and tones it by whether the move is good for that metric", () => {
    expect(compareRuns(12_000, 10_000, true, "usd", "usd")).toEqual({
      kind: "moved",
      deltaPct: 20,
      direction: "up",
      tone: "good",
    });
    expect(compareRuns(12_000, 10_000, false, "usd", "usd")).toEqual({
      kind: "moved",
      deltaPct: 20,
      direction: "up",
      tone: "bad",
    });
    expect(compareRuns(5_000, 10_000, false, "usd", "usd")).toEqual({
      kind: "moved",
      deltaPct: 50,
      direction: "down",
      tone: "good",
    });
  });

  it("from a zero baseline, reports the move against the current figure, as Recova does", () => {
    expect(compareRuns(3_000, 0, false, "usd", "usd")).toEqual({
      kind: "moved",
      deltaPct: 100,
      direction: "up",
      tone: "bad",
    });
  });

  it("never compares a figure that was not read, and never across currencies", () => {
    expect(compareRuns(null, 10_000, true, "usd", "usd")).toEqual({ kind: "none" });
    expect(compareRuns(10_000, null, true, "usd", "usd")).toEqual({ kind: "none" });
    expect(compareRuns(10_000, 20_000, true, "usd", "eur")).toEqual({ kind: "none" });
  });
});

type Run = {
  id: string;
  runAt: Date;
  currency: string;
  failedInvoicesCents: number | null;
  openDisputesCents: number | null;
  mrrCents: number | null;
  summary: string | null;
};

const page = await import("~/routes/app/audit/dashboard");

const Page = page.default as unknown as (props: {
  loaderData: { runs: Run[]; settings: { lookbackDays: number; autoRun: boolean } };
  actionData?: Record<string, unknown>;
}) => ReactElement;

const run = (over: Partial<Run> = {}): Run => ({
  id: "run_1",
  runAt: new Date("2026-10-01T12:00:00Z"),
  currency: "usd",
  failedInvoicesCents: 12_000,
  openDisputesCents: 0,
  mrrCents: 500_000,
  summary: "Two invoices failed this month.",
  ...over,
});

function render(runs: Run[], settings = { lookbackDays: 90, autoRun: false }, actionData?: Record<string, unknown>) {
  const Stub = createRoutesStub([
    {
      path: "/audit/dashboard",
      Component: () => createElement(Page, { loaderData: { runs, settings }, actionData }),
    },
  ]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/audit/dashboard"] }));
}

const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

describe("J43: the populated page, in Recova's order", () => {
  const two = [
    run({ id: "run_new" }),
    run({
      id: "run_old",
      runAt: new Date("2026-09-01T12:00:00Z"),
      failedInvoicesCents: 10_000,
      mrrCents: 500_000,
      openDisputesCents: 4_000,
      summary: null,
    }),
  ];

  it("heads with Capsomer's PageHead: Audit history, the last run date, and Run new audit", () => {
    const html = render(two);
    expect(html).toMatch(/<h1 class="cap-page-head-title">Audit history<\/h1>/);
    expect(text(html)).toContain("Last run Oct 1, 2026");
    const button = html.match(/<a[^>]*href="\/audit\/connect"[^>]*>Run new audit<\/a>/)?.[0] ?? "";
    expect(button).toContain('class="cap-btn"');
    expect(button).toContain('data-variant="primary"');
  });

  it("carries the sections in Recova's order: summary, Since last run, History, Settings", () => {
    const t = text(render(two));
    const order = ["AI Summary", "Since last run", "History", "Settings", "Lookback period", "Monthly audit digest"];
    const at = order.map((s) => t.indexOf(s));
    expect(at.every((i) => i > -1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("has no control Recova lacks: no Audit settings link and no extra sentence", () => {
    const html = render(two);
    expect(html).not.toContain('href="/settings/audit"');
    expect(text(html)).not.toContain("It reads only.");
  });

  it("Since last run shows Recova's three rows with the move and its direction in words", () => {
    const html = render(two);
    const section = html.slice(html.indexOf("Since last run"), html.indexOf(">History<"));
    const t = text(section);
    expect(t.indexOf("Failed invoices")).toBeLessThan(t.indexOf("MRR"));
    expect(t.indexOf("MRR")).toBeLessThan(t.indexOf("Open disputes"));
    expect(t).toContain("$120 vs $100");
    expect(t).toMatch(/up 20%/);
    expect(t).toContain("no change");
    expect(t).toMatch(/down 100%/);
  });

  it("Since last run is absent with one run, as Recova's is", () => {
    expect(text(render([run()]))).not.toContain("Since last run");
  });

  it("History is a Capsomer table in a panel, with Recova's columns and a View link per run", () => {
    const html = render(two);
    expect(html).toContain('class="cap-panel"');
    expect(html).toMatch(/<div class="cap-table-wrap"[^>]*role="region"[^>]*tabindex="0"/);
    const head = html.match(/<thead>[\s\S]*?<\/thead>/)?.[0] ?? "";
    expect(text(head)).toBe("Date Failed Disputes MRR View");
    expect(html).toContain('href="/audit/results/run_new"');
    expect(html).toContain('href="/audit/results/run_old"');
  });

  it("a figure that was not read says so, never a zero", () => {
    const html = render([run({ mrrCents: null })]);
    const body = html.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0] ?? "";
    expect(text(body)).toContain("Not read");
  });

  it("Settings: Recova's four lookback choices on Capsomer's segmented control, and the digest switch", () => {
    const html = render(two, { lookbackDays: 180, autoRun: true });
    expect(html).toMatch(/<fieldset class="cap-seg"/);
    const radios = [...html.matchAll(/<input[^>]*name="audit_lookback_days"[^>]*>/g)].map((m) => m[0]);
    expect(radios.map((r) => r.match(/value="(\d+)"/)?.[1])).toEqual(["30", "60", "90", "180"]);
    expect(radios.filter((r) => /\schecked/.test(r)).map((r) => r.match(/value="(\d+)"/)?.[1])).toEqual(["180"]);
    const sw = html.match(/<input[^>]*role="switch"[^>]*>/)?.[0] ?? "";
    expect(sw).toContain('name="audit_auto_run"');
    expect(sw).toMatch(/\schecked/);
    expect(text(html)).toContain("How far back we look when calculating your audit.");
    expect(text(html)).toContain(
      "On the 1st of each month, we run a fresh audit and email you a comparison versus the prior month. No extra charge.",
    );
  });

  it("Settings has no save button, because Recova saves on each change", () => {
    expect(render(two)).not.toMatch(/<button[^>]*type="submit"/);
  });

  it("says Saved. after a save and Save failed. after a refusal, with no raw error code", () => {
    expect(text(render(two, undefined, { ok: true, lookbackDays: 90, autoRun: false }))).toContain("Saved.");
    const failed = text(render(two, undefined, { ok: false }));
    expect(failed).toContain("Save failed.");
    expect(failed).not.toMatch(/save_failed|network_error/);
  });
});

describe("J43: the empty page", () => {
  it("is Recova's card: the h1, two lines and Run first audit, then the Settings card", () => {
    const html = render([]);
    expect(html).toMatch(/<h1[^>]*>No audit runs yet<\/h1>/);
    const t = text(html);
    expect(t).toContain("Run a full diagnostic of your Stripe account.");
    expect(t).toContain("Free, on demand, takes 30 seconds.");
    expect(t).not.toContain("It reads only.");
    expect(html).toMatch(/<a[^>]*href="\/audit\/connect"[^>]*>Run first audit<\/a>/);
    expect(t.indexOf("Run first audit")).toBeLessThan(t.indexOf("Settings"));
    expect(t).toContain("Lookback period");
    expect(html).toContain('class="cap-empty"');
  });
});

describe("J43: the look", () => {
  const code = stripComments(read("app/routes/app/audit/dashboard.tsx"));
  it("uses no hand-rolled card and no amber", () => {
    expect(code).not.toContain("rounded-[12px]");
    expect(code).not.toContain("rounded-xl border border-border");
    expect(code).not.toMatch(/amber/i);
  });
  it("keeps text on the five sizes", () => {
    expect(code).not.toMatch(/text-\[\d/);
  });
});

describe("J43: the loader and the action, scoped to the caller's account", () => {
  const callAction = (accountId: string, form: Record<string, string>) => {
    const body = new FormData();
    for (const [k, v] of Object.entries(form)) body.set(k, v);
    return page.action({
      request: new Request("https://foxhoundapp.test/audit/dashboard", { method: "POST", body }),
      context: contextFor(accountId),
      params: {},
    } as never) as Promise<{ data: Record<string, unknown>; init: { status?: number } | null }>;
  };
  const loadPage = (accountId: string) =>
    page.loader({
      request: new Request("https://foxhoundapp.test/audit/dashboard"),
      context: contextFor(accountId),
      params: {},
    } as never) as Promise<{ settings: { lookbackDays: number; autoRun: boolean } }>;
  const stored = (id: string) =>
    sqlite.prepare("SELECT audit_lookback_days AS d, audit_auto_run AS a FROM accounts WHERE id = ?").get(id) as {
      d: number | null;
      a: number | null;
    };

  it("the loader reads this account's settings, NULL as 90 days and off", async () => {
    sqlite.prepare("UPDATE accounts SET audit_lookback_days = 30, audit_auto_run = 1 WHERE id = ?").run(ACCOUNT_B);
    expect((await loadPage(ACCOUNT_A)).settings).toEqual({ lookbackDays: 90, autoRun: false });
    expect((await loadPage(ACCOUNT_B)).settings).toEqual({ lookbackDays: 30, autoRun: true });
  });

  it("the action writes the caller's account and no other", async () => {
    const res = await callAction(ACCOUNT_A, { audit_lookback_days: "180", audit_auto_run: "true" });
    expect(res.init?.status ?? 200).toBe(200);
    expect(res.data).toMatchObject({ ok: true, lookbackDays: 180, autoRun: true });
    expect(stored(ACCOUNT_A)).toEqual({ d: 180, a: 1 });
    expect(stored(ACCOUNT_B)).toEqual({ d: null, a: null });
  });

  it("an absent digest field is off, as an unchecked switch posts nothing", async () => {
    await callAction(ACCOUNT_A, { audit_lookback_days: "60" });
    expect(stored(ACCOUNT_A)).toEqual({ d: 60, a: 0 });
  });

  it("a failed write returns 500 with ok false and logs the whole error", async () => {
    const boom = new Error("D1 is down");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const realDb = harness.db;
    harness.db = new Proxy(realDb as object, {
      get(target, prop, receiver) {
        if (prop === "update" || prop === "batch") throw boom;
        return Reflect.get(target, prop, receiver);
      },
    });
    try {
      const res = await callAction(ACCOUNT_A, { audit_lookback_days: "60" });
      expect(res.init?.status).toBe(500);
      expect(res.data).toEqual({ ok: false });
      expect(spy).toHaveBeenCalledWith(expect.any(String), boom);
    } finally {
      harness.db = realDb;
      spy.mockRestore();
    }
  });

  it("writes through applyAuditSettings, the one core /settings/audit and the MCP tool use", () => {
    const code = stripComments(read("app/routes/app/audit/dashboard.tsx"));
    expect(code).toContain("applyAuditSettings(");
    expect(code).not.toContain("db.update");
    expect(code).not.toContain(".update(accounts)");
  });
});

describe("J43 review: the controls keep focus while a save is in flight", () => {
  const SettingsForm = (page as unknown as {
    AuditSettingsForm: (props: {
      defaultLookbackDays: number;
      defaultAutoRun: boolean;
      result: undefined;
      saving: boolean;
    }) => ReactElement;
  }).AuditSettingsForm;

  function renderForm(saving: boolean) {
    const Stub = createRoutesStub([
      {
        path: "/audit/dashboard",
        Component: () =>
          createElement(SettingsForm, { defaultLookbackDays: 90, defaultAutoRun: true, result: undefined, saving }),
      },
    ]);
    return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/audit/dashboard"] }));
  }

  it("never disables a radio or the switch during a save, so the focused control keeps focus", () => {
    const html = renderForm(true);
    const inputs = [...html.matchAll(/<input[^>]*>/g)].map((m) => m[0]);
    expect(inputs.length).toBe(5);
    for (const input of inputs) expect(input).not.toMatch(/\sdisabled/);
  });

  it("says the save is in progress with aria-busy instead", () => {
    const html = renderForm(true);
    expect(html).toMatch(/<input[^>]*role="switch"[^>]*aria-busy="true"/);
    expect(html).toMatch(/aria-busy="true"[^>]*>[\s\S]*<fieldset class="cap-seg"/);
    expect(renderForm(false)).not.toContain('aria-busy="true"');
  });

  it("names the switch from the visible label, with no hidden copy of it", () => {
    const html = renderForm(false);
    const id = html.match(/<div id="([^"]+)"[^>]*>Monthly audit digest<\/div>/)?.[1];
    expect(id).toBeTruthy();
    const sw = html.match(/<input[^>]*role="switch"[^>]*>/)?.[0] ?? "";
    expect(sw).toContain(`aria-labelledby="${id}"`);
    expect(html).not.toMatch(/<span class="sr-only">Monthly audit digest<\/span>/);
  });
});

describe("J43 review: a change made during a save is queued, and the last value wins", async () => {
  const { createSaveQueue } = await import("~/lib/audit/save-queue");

  it("submits at once when nothing is in flight", () => {
    const submit = vi.fn();
    createSaveQueue(submit).change();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("holds every change made mid-save and sends one more save, after the first settles", () => {
    const submit = vi.fn();
    const q = createSaveQueue(submit);
    q.change();
    q.change();
    q.change();
    expect(submit).toHaveBeenCalledTimes(1);
    q.settled();
    expect(submit).toHaveBeenCalledTimes(2);
    q.settled();
    expect(submit).toHaveBeenCalledTimes(2);
  });
});

describe("J43 review: a run with no stored currency is unknown, never USD", () => {
  it("compareRuns refuses a null currency", async () => {
    const { compareRuns } = await import("~/lib/audit/trend");
    expect(compareRuns(12_000, 10_000, true, null, "usd")).toEqual({ kind: "none" });
  });

  it("the loader passes a NULL currency through", () => {
    const code = stripComments(read("app/routes/app/audit/dashboard.tsx"));
    expect(code).not.toContain('run.currency ?? "usd"');
  });

  it("the action has no unreachable 400 branch, and Not read carries no title-only explanation", () => {
    const code = stripComments(read("app/routes/app/audit/dashboard.tsx"));
    expect(code).not.toContain("status: 400");
    expect(code).not.toContain('title="Could not be read on this run"');
  });
});
