import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J33 (job_947a0b8bbe06), row S28, under Dustin's Q10 and Q11 rulings of
// 2026-10-14: /settings/alerts is Recova's page
// (app/(app)/settings/alerts/page.tsx at blob 3c1d6bb0 and AlertsClient.tsx at
// blob ee8dac99, both read whole) built from Capsomer 0.9.0's components, teal
// throughout. Recova stays the spec for every section, column, control and
// label and their order, and for the page's width: the settings layout's 800px
// column, with no second wrapper of the page's own.
//
// Two differences from Recova stay, both kept from S28 under RULES.md 1.2 and
// 2.7 because Foxhound delivers no alert yet: no channel picker and no Channel
// columns, and no "Get notified" promise. The metric list is Foxhound's own
// evaluator's (test/settings-alerts-s28.test.ts holds those).
//
// Every assertion here was seen failing against the page before the rebuild
// (red output kept in the J33 pull request).

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const route = await import("~/routes/app/settings/alerts");
const { ALERT_THRESHOLD_ERROR } = await import("~/lib/settings/apply.server");
const { alertConditionLabel } = await import("~/lib/settings/alert-metrics");
const Page = route.default as unknown as (props: {
  loaderData: Record<string, unknown>;
  actionData?: Record<string, unknown>;
}) => ReactElement;

const SOURCE = readFileSync(
  fileURLToPath(new URL("../app/routes/app/settings/alerts.tsx", import.meta.url)),
  "utf8",
);

interface AlertRow {
  id: string;
  metric: string;
  thresholdValue: number;
  direction: string;
  channel: string;
  label: string | null;
  enabled: boolean;
  lastTriggeredAt: Date | null;
}

interface HistoryRow {
  id: string;
  metric: string;
  actualValue: number;
  thresholdValue: number;
  direction: string;
  firedAt: Date;
  notificationSent: boolean;
}

function alertRow(over: Partial<AlertRow> & { id: string }): AlertRow {
  return {
    metric: "mrr_at_risk_cents",
    thresholdValue: 500_000,
    direction: "above",
    channel: "email",
    label: null,
    enabled: true,
    lastTriggeredAt: null,
    ...over,
  };
}

function historyRow(over: Partial<HistoryRow> & { id: string }): HistoryRow {
  return {
    metric: "mrr_at_risk_cents",
    actualValue: 650_000,
    thresholdValue: 500_000,
    direction: "above",
    firedAt: new Date(Date.UTC(2026, 9, 1, 15, 30)),
    notificationSent: false,
    ...over,
  };
}

function render(
  opts: {
    alerts?: AlertRow[];
    history?: HistoryRow[];
    url?: string;
    actionData?: Record<string, unknown>;
  } = {},
): string {
  const loaderData = {
    alerts: opts.alerts ?? [alertRow({ id: "a1" })],
    history: opts.history ?? [],
  };
  const Stub = createRoutesStub([
    {
      path: "/settings/alerts",
      Component: () => createElement(Page, { loaderData, actionData: opts.actionData }),
    },
  ]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: [opts.url ?? "/settings/alerts"] }));
}

function headings(html: string): { level: number; text: string }[] {
  return [...html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => ({
    level: Number(m[1]),
    text: m[2].replace(/<[^>]+>/g, ""),
  }));
}

/** The column heads of the nth table on the page. */
function columnHeads(html: string, n: number): string[] {
  const table = [...html.matchAll(/<table[\s\S]*?<\/table>/g)][n]?.[0] ?? "";
  const thead = table.match(/<thead>([\s\S]*?)<\/thead>/)?.[1] ?? "";
  return [...thead.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => m[1].replace(/<[^>]+>/g, ""));
}

/** The text of every cell in the first body row of the nth table. */
function firstRowCells(html: string, n: number): string[] {
  const table = [...html.matchAll(/<table[\s\S]*?<\/table>/g)][n]?.[0] ?? "";
  const tbody = table.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
  const tr = tbody.match(/<tr[^>]*>([\s\S]*?)<\/tr>/)?.[1] ?? "";
  return [...tr.matchAll(/<(td|th)[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => m[2]);
}

const text = (s: string) => s.replace(/<[^>]+>/g, "").trim();

describe("J33 alerts: the page head and width", () => {
  it("is Capsomer's PageHead titled Alerts, with the truthful lead", () => {
    const html = render();
    expect(html).toMatch(/<header class="cap-page-head">[\s\S]*<h1 class="cap-page-head-title">Alerts<\/h1>/);
    expect(html).toContain('<p class="cap-page-head-lead">');
  });

  it("adds no width or padding of its own inside the settings layout's 800px column", () => {
    const html = render();
    expect(html).not.toContain("max-w-3xl");
    expect(html).not.toMatch(/class="mx-auto/);
    expect(SOURCE).not.toContain("text-h2");
  });

  it("carries Recova's phone-only back link to Settings, before the head", () => {
    const html = render();
    const link = html.match(/<a[^>]*href="\/settings"[^>]*>[\s\S]*?<\/a>/)?.[0] ?? "";
    expect(link).toContain("md:hidden");
    expect(text(link)).toBe("Settings");
    expect(html.indexOf('href="/settings"')).toBeLessThan(html.indexOf("cap-page-head"));
  });
});

describe("J33 review: copy that promises nothing Foxhound does not do", () => {
  // Nothing delivers an alert (notificationSent is written false), and the
  // evaluator records a firing when a threshold is first crossed, not every
  // night it stays crossed (the edge trigger J94 replaced with Recova's cooldown).
  it("says the alerts are checked nightly and each crossing is recorded", () => {
    const html = render();
    expect(html).toContain(
      '<p class="cap-page-head-lead">Foxhound checks these every night and records each time one crosses its threshold.</p>',
    );
  });

  it("offers the empty state without a delivery verb", () => {
    const html = render({ alerts: [] });
    expect(html).toContain("No alerts yet. Create one to see when metrics need attention.");
    expect(html).not.toMatch(/get told|get notified|notify/i);
  });

  it("names an unknown stored direction plainly rather than dropping it", () => {
    expect(alertConditionLabel("mrr_at_risk_cents", "sideways", 500_000)).toBe("MRR at risk crosses $5,000");
    expect(alertConditionLabel("mrr_at_risk_cents", "below", 500_000)).toBe("MRR at risk below $5,000");
  });
});

describe("J33 alerts: the configured alerts card", () => {
  it("leads with Recova's count line and a Capsomer primary Create alert button", () => {
    const html = render({ alerts: [alertRow({ id: "a1" }), alertRow({ id: "a2" })] });
    expect(html).toContain("2 alerts configured");
    expect(html).toMatch(/<button[^>]*class="cap-btn"[^>]*data-variant="primary"[^>]*>Create alert<\/button>/);
  });

  it("keeps Create alert on screen, disabled, while the form is open, as Recova does", () => {
    const html = render({ url: "/settings/alerts?new=1" });
    const createButtons = [...html.matchAll(/<button[^>]*>(?:<[^>]+>)*Create alert(?:<[^>]+>)*<\/button>/g)].map(
      (m) => m[0],
    );
    // The head's button, disabled, and the form's own submit.
    expect(createButtons).toHaveLength(2);
    expect(createButtons[0]).toContain('aria-disabled="true"');
  });

  it("is Capsomer's table in a named, focusable region with Recova's columns in order, less Channel", () => {
    const html = render();
    expect(html).toMatch(/<div class="cap-table-wrap"[^>]*role="region"[^>]*aria-label="Alerts"[^>]*tabindex="0"/);
    expect(html).toContain('<table class="cap-table">');
    expect(columnHeads(html, 0)).toEqual(["Label", "Metric", "Condition", "Last triggered", "Status", "Actions"]);
  });

  it("fills a row Recova's way: dash for no label, metric, Recova's condition words, Never", () => {
    const html = render();
    const cells = firstRowCells(html, 0).map(text);
    expect(cells[0]).toBe("-");
    expect(cells[1]).toBe("MRR at risk");
    expect(cells[2]).toBe("MRR at risk above $5,000");
    expect(cells[3]).toBe("Never");
  });

  it("is a Capsomer switch for On and Off, named for its alert", () => {
    const on = render({ alerts: [alertRow({ id: "a1", label: "Churn watch", enabled: true })] });
    expect(on).toMatch(/<label class="cap-switch"><input[^>]*role="switch"[^>]*checked=""/);
    expect(on).toContain('<span class="cap-switch-state" aria-hidden="true">On</span>');
    expect(on).toMatch(/class="sr-only">Churn watch alert<\/span>/);

    const off = render({ alerts: [alertRow({ id: "a1", enabled: false })] });
    expect(off).not.toMatch(/role="switch"[^>]*checked=""/);
    expect(off).toContain('<span class="cap-switch-state" aria-hidden="true">Off</span>');
  });

  it("deletes with a Capsomer button carrying Recova's words", () => {
    const html = render();
    expect(html).toMatch(/<button type="submit" class="cap-btn" data-size="sm"[^>]*>Delete alert<\/button>/);
  });

  it("shows a refused toggle or delete as a Capsomer alert", () => {
    const html = render({ actionData: { action: "toggle", ok: false, error: "That alert was not found." } });
    expect(html).toMatch(/class="cap-alert"[\s\S]*That alert was not found\./);
  });
});

describe("J33 alerts: the card stays inside the 800px column", () => {
  // Capsomer's panel body is a grid, so a block of the page's own inside it
  // needs min-width 0 or a wide table pushes the card out of the column
  // instead of scrolling inside its region (seen in the J33 screenshots).
  it("gives every block of the page's own in the first card's body min-w-0", () => {
    const html = render({
      url: "/settings/alerts?new=1",
      actionData: { action: "toggle", ok: false, error: "No." },
    });
    for (const cls of ["mb-4", "mt-5", "mt-6"]) {
      expect(html).toMatch(new RegExp(`class="${cls} min-w-0"`));
    }
    expect(html).toMatch(/class="flex min-w-0 flex-wrap items-center justify-between/);
  });

  it("keeps the disabled button and its reason together, apart from the count line", () => {
    const html = render({ url: "/settings/alerts?new=1" });
    expect(html).toMatch(/<div class="flex flex-wrap items-center gap-2"><button[^>]*aria-disabled="true"[\s\S]*?cap-btn-reason/);
  });
});

describe("J33 alerts: the create form", () => {
  it("is a nested Capsomer panel with its heading", () => {
    const html = render({ url: "/settings/alerts?new=1" });
    expect(headings(html)).toContainEqual({ level: 3, text: "Create a new alert" });
  });

  it("keeps Recova's fields in Recova's order on Capsomer's parts", () => {
    const html = render({ url: "/settings/alerts?new=1" });
    const order = ["Metric", "Direction", "Threshold", "Label"].map((l) =>
      html.search(new RegExp(`<(label|legend)[^>]*>${l}`)),
    );
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toMatch(/<select[^>]*class="cap-select"[^>]*name="metric"|<select[^>]*name="metric"[^>]*class="cap-select"/);
  });

  it("chooses the direction on Capsomer's segmented control with Recova's two words", () => {
    const html = render({ url: "/settings/alerts?new=1" });
    expect(html).toMatch(/<fieldset class="cap-seg"><legend>Direction<\/legend>/);
    // Recova's order and default: Drops below first, and chosen.
    const below = html.match(/<input type="radio" name="direction"[^>]*value="below"[^>]*\/> Drops below/)?.[0] ?? "";
    const above = html.match(/<input type="radio" name="direction"[^>]*value="above"[^>]*\/> Rises above/)?.[0] ?? "";
    expect(below).toContain('checked=""');
    expect(above).not.toContain("checked");
    expect(html.indexOf("Drops below")).toBeLessThan(html.indexOf("Rises above"));
  });

  it("puts Recova's $ before the threshold for a money metric, and nothing for the score", () => {
    const money = render({ url: "/settings/alerts?new=1&metric=mrr_at_risk_cents" });
    expect(money).toMatch(/<div class="cap-input-addon" data-align="inline-start">\$<\/div>/);
    expect(money).toContain('placeholder="5000"');

    const score = render({ url: "/settings/alerts?new=1&metric=health_score_avg" });
    expect(score).not.toContain("cap-input-addon");
    expect(score).toContain('placeholder="10"');
  });

  it("marks Label optional in Recova's words", () => {
    const html = render({ url: "/settings/alerts?new=1" });
    expect(html).toMatch(/<label class="cap-field-label"[^>]*>Label <span[^>]*>\(optional\)<\/span>/);
  });

  it("shows a refused create inside the form, below the fields, as Recova does", () => {
    const html = render({
      url: "/settings/alerts?new=1",
      actionData: { action: "create", ok: false, error: ALERT_THRESHOLD_ERROR },
    });
    const form = html.match(/<form[^>]*method="post"[\s\S]*?<\/form>/g)?.find((f) => f.includes('value="create"')) ?? "";
    expect(form).toContain(ALERT_THRESHOLD_ERROR);
    expect(form.indexOf(ALERT_THRESHOLD_ERROR)).toBeGreaterThan(form.indexOf('name="label"'));
  });

  it("submits on Capsomer's primary button and cancels on Capsomer's quiet one", () => {
    const html = render({ url: "/settings/alerts?new=1" });
    expect(html).toMatch(/<button type="submit" class="cap-btn" data-variant="primary"[^>]*>Create alert<\/button>/);
    expect(html).toMatch(/<a class="cap-btn" data-variant="quiet" href="\/settings\/alerts"[^>]*>Cancel<\/a>/);
  });
});

describe("J33 alerts: recent triggers", () => {
  it("is a Capsomer panel titled Recent triggers, with Recova's empty sentence", () => {
    const html = render({ history: [] });
    expect(headings(html)).toContainEqual({ level: 2, text: "Recent triggers" });
    expect(html).toContain(
      "No alerts have fired yet. Triggers will appear here when a threshold crosses.",
    );
  });

  it("has Recova's columns in order, less Channel, and Recova's short condition", () => {
    const html = render({ alerts: [], history: [historyRow({ id: "h1" })] });
    expect(columnHeads(html, 0)).toEqual(["Metric", "Condition", "Actual value", "Fired at"]);
    const cells = firstRowCells(html, 0).map(text);
    expect(cells[0]).toBe("MRR at risk");
    expect(cells[1]).toBe("above $5,000");
    expect(cells[2]).toBe("$6,500");
  });
});

describe("J33 alerts: source", () => {
  it("takes its parts from Capsomer and carries no amber and no arbitrary text size", () => {
    for (const part of ["page-head", "panel", "button", "field", "segmented", "switch", "banner"]) {
      expect(SOURCE).toContain(`from "capsomer/react/${part}"`);
    }
    expect(SOURCE).not.toMatch(/amber/i);
    expect(SOURCE).not.toMatch(/text-\[/);
    expect(SOURCE).not.toContain("rounded-full");
  });
});

// The loader, against the in-memory database.

const ACCOUNT = "acct_1";

let sqlite: Database.Database;

const ctx = {
  get(key: unknown) {
    if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
    if (key === authContext) {
      return {
        userId: "user_1",
        membership: { memberId: "m1", accountId: ACCOUNT, accountName: "Acme", role: "owner" },
        memberships: [{ memberId: "m1", accountId: ACCOUNT, accountName: "Acme", role: "owner" }],
        activeAccountId: ACCOUNT,
      };
    }
    throw new Error("unexpected context key");
  },
};

beforeEach(() => {
  const made = createInMemoryDb();
  sqlite = made.sqlite;
  harness.db = made.db;
  sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, 1000)").run(ACCOUNT, "Acme");
});

async function load(): Promise<{ alerts: { id: string }[]; history: { id: string }[] }> {
  return (await route.loader({
    context: ctx,
    request: new Request("https://x/settings/alerts"),
    params: {},
  } as never)) as never;
}

describe("J33 alerts: the loader reads as Recova's page does", () => {
  it("lists alerts newest first", async () => {
    for (const [id, createdAt] of [
      ["a_old", 1000],
      ["a_new", 3000],
      ["a_mid", 2000],
    ] as const) {
      sqlite
        .prepare(
          "INSERT INTO alerts (id, account_id, metric, threshold_value, direction, channel, enabled, created_at) VALUES (?, ?, 'mrr_at_risk_cents', 100, 'above', 'email', 1, ?)",
        )
        .run(id, ACCOUNT, createdAt);
    }
    expect((await load()).alerts.map((a) => a.id)).toEqual(["a_new", "a_mid", "a_old"]);
  });

  it("breaks a tie on the same creation time by id, newest id first", async () => {
    for (const id of ["a_b", "a_c", "a_a"]) {
      sqlite
        .prepare(
          "INSERT INTO alerts (id, account_id, metric, threshold_value, direction, channel, enabled, created_at) VALUES (?, ?, 'mrr_at_risk_cents', 100, 'above', 'email', 1, 5000)",
        )
        .run(id, ACCOUNT);
    }
    expect((await load()).alerts.map((a) => a.id)).toEqual(["a_c", "a_b", "a_a"]);
  });

  it("shows Recova's twenty most recent triggers", async () => {
    sqlite
      .prepare(
        "INSERT INTO alerts (id, account_id, metric, threshold_value, direction, channel, enabled, created_at) VALUES ('a1', ?, 'mrr_at_risk_cents', 100, 'above', 'email', 1, 1000)",
      )
      .run(ACCOUNT);
    for (let i = 0; i < 25; i++) {
      sqlite
        .prepare(
          "INSERT INTO alert_history (id, alert_id, account_id, metric, threshold_value, direction, actual_value, channel, fired_at, notification_sent) VALUES (?, 'a1', ?, 'mrr_at_risk_cents', 100, 'above', 200, 'email', ?, 0)",
        )
        .run(`h${String(i).padStart(2, "0")}`, ACCOUNT, 1000 + i);
    }
    const { history } = await load();
    expect(history).toHaveLength(20);
    expect(history[0].id).toBe("h24");
  });
});

describe("J33 review: a successful create closes the form, as Recova's dismissPanel does", () => {
  async function post(fields: Record<string, string>, url = "https://x/settings/alerts?new=1"): Promise<unknown> {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return route.action({
      context: ctx,
      request: new Request(url, { method: "POST", body: form }),
      params: {},
    } as never);
  }

  it("redirects to the page without ?new=1, and the new alert is listed", async () => {
    const res = await post({ _action: "create", metric: "mrr_at_risk_cents", direction: "below", threshold: "50", label: "Watch" });
    expect(res).toBeInstanceOf(Response);
    const response = res as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/settings/alerts");
    const { alerts } = await load();
    expect(alerts).toHaveLength(1);
  });

  it("keeps the form open with the refusal when the create is refused", async () => {
    const res = (await post({ _action: "create", metric: "mrr_at_risk_cents", direction: "below", threshold: "-1" })) as {
      data: { ok: boolean; error: string };
      init?: { status?: number };
    };
    expect(res).not.toBeInstanceOf(Response);
    expect(res.init?.status).toBe(400);
    expect(res.data.error).toBe(ALERT_THRESHOLD_ERROR);
    expect((await load()).alerts).toHaveLength(0);
  });
});
