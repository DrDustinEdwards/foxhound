import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { accountSubscriptions, accounts } from "~/db";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { ALERT_METRICS, INTELLIGENCE_PRODUCT, SUBSCRIPTION_STATUS_ACTIVE } from "~/lib/constants";
import { ALERT_METRIC_LABELS } from "~/lib/settings/alert-metrics";
import { SETTINGS_NAV_GROUPS } from "~/components/settings-sidebar";
import { SETTINGS_HUB_ENTRIES } from "~/routes/app/settings/hub";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J69 (job_c7d73b4f3c1c), row S35: /settings/intelligence. Recova's spec, read
// whole at HEAD:
//   app/(app)/settings/intelligence/page.tsx               blob d9800b0f  2,122 bytes
//   app/(app)/settings/components/IntelligenceSection.tsx  blob ec9ed981  5,000 bytes
//   app/api/settings/intelligence-preferences/route.ts     blob 7527dd4d  2,884 bytes
//
// RECOVA'S FIVE CONTROLS HAVE NO READER IN FOXHOUND, so none is built (RULES.md
// 3.18, 2.7). The page says which deliveries are not built and where the
// nearest built thing lives. The reader guard below fails the day a reader
// appears, which is when the page gains that control.
//
// Every assertion here was seen failing before the page existed.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const ROUTE_FILE = fileURLToPath(new URL("../app/routes/app/settings/intelligence.tsx", import.meta.url));
const ROUTES_TS = readFileSync(new URL("../app/routes.ts", import.meta.url), "utf8");

async function loadRoute() {
  return import("~/routes/app/settings/intelligence");
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function render(loaderData: { intelligenceActive: boolean }): Promise<string> {
  const route = await loadRoute();
  const Page = route.default as unknown as (props: { loaderData: Record<string, unknown> }) => ReactElement;
  const Stub = createRoutesStub([
    {
      path: "/settings/intelligence",
      Component: () => createElement(Page, { loaderData }),
    },
  ]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/settings/intelligence"] }));
}

function ctx(accountId = "acct_1") {
  return {
    get(key: unknown) {
      if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
      if (key === authContext) return { email: "owner@example.com", membership: { accountId } };
      throw new Error("unexpected context key");
    },
  } as never;
}

describe("J69: the route exists where Recova's does", () => {
  it("is registered under the settings layout", () => {
    expect(ROUTES_TS).toContain('route("intelligence", "./routes/app/settings/intelligence.tsx")');
  });

  it("has its own browser title", async () => {
    const route = await loadRoute();
    expect(route.meta()).toEqual([{ title: "Intelligence settings - Foxhound" }]);
  });

  it("is on the hub in Recova's place, after Disputes and before Audit", () => {
    const tos = SETTINGS_HUB_ENTRIES.map((e) => e.to);
    const i = tos.indexOf("/settings/intelligence");
    expect(i).toBeGreaterThan(-1);
    // Recova's order is Features, Disputes, Intelligence; Disputes (S32) came with J06.
    expect(tos[i - 1]).toBe("/settings/disputes");
    expect(tos[i + 1]).toBe("/settings/audit");
    expect(SETTINGS_HUB_ENTRIES[i]!.label).toBe("Intelligence");
  });

  it("is in the sub-menu's Products group before Audit, as in Recova's SettingsSidebar", () => {
    const products = SETTINGS_NAV_GROUPS.find((g) => g.label === "Products");
    expect(products?.items.map((item) => [item.to, item.label])).toEqual([
      ["/settings/disputes", "Disputes"],
      ["/settings/intelligence", "Intelligence"],
      ["/settings/audit", "Audit"],
    ]);
  });
});

describe("J69: the loader reads the one thing the page shows, the entitlement", () => {
  beforeEach(() => {
    harness.db = null;
  });

  async function seed(opts: { entitled: boolean; otherAccountEntitled?: boolean }) {
    const { db } = createInMemoryDb();
    const now = new Date(1_000_000);
    await db.insert(accounts).values([
      { id: "acct_1", name: "One", createdAt: now },
      { id: "acct_2", name: "Two", createdAt: now },
    ]);
    if (opts.entitled) {
      await db.insert(accountSubscriptions).values({
        id: "sub_1",
        accountId: "acct_1",
        product: INTELLIGENCE_PRODUCT,
        status: SUBSCRIPTION_STATUS_ACTIVE,
        createdAt: now,
      });
    }
    if (opts.otherAccountEntitled) {
      await db.insert(accountSubscriptions).values({
        id: "sub_2",
        accountId: "acct_2",
        product: INTELLIGENCE_PRODUCT,
        status: SUBSCRIPTION_STATUS_ACTIVE,
        createdAt: now,
      });
    }
    harness.db = db;
  }

  it("is active for an account with an active Intelligence subscription", async () => {
    await seed({ entitled: true });
    const route = await loadRoute();
    const out = await route.loader({ context: ctx(), request: new Request("https://x/"), params: {} } as never);
    expect(out).toEqual({ intelligenceActive: true });
  });

  it("is not active for an account without one, even when another account has it", async () => {
    await seed({ entitled: false, otherAccountEntitled: true });
    const route = await loadRoute();
    const out = await route.loader({ context: ctx(), request: new Request("https://x/"), params: {} } as never);
    expect(out).toEqual({ intelligenceActive: false });
  });
});

describe("J69: the page head", () => {
  it("is Capsomer's PageHead titled Intelligence, with Recova's line made true", async () => {
    const html = await render({ intelligenceActive: true });
    expect(html).toMatch(/<h1 class="cap-page-head-title">Intelligence<\/h1>/);
    expect(html).toMatch(
      /<p class="cap-page-head-lead">Which Intelligence outputs are delivered to you, and where they go\.<\/p>/,
    );
  });

  it("opens with the shared phone-only back link to the hub", async () => {
    const html = await render({ intelligenceActive: true });
    const link = html.match(/<a[^>]*href="\/settings"[^>]*>[\s\S]*?<\/a>/)?.[0] ?? "";
    expect(link).toContain("md:hidden");
    expect(text(link)).toBe("Settings");
    expect(html.indexOf('href="/settings"')).toBeLessThan(html.indexOf("cap-page-head-title"));
  });
});

describe("J69: an account without Intelligence gets Recova's notice, made true", () => {
  it("says Intelligence is not active and links to billing without promising self-serve", async () => {
    const t = text(await render({ intelligenceActive: false }));
    expect(t).toContain("Intelligence is not active on this account.");
    // Recova says "Enable from billing"; Foxhound's billing page says
    // subscribing is not built (components/billing-sections.tsx), so the link
    // promises only what the billing page shows.
    expect(t).not.toContain("Enable from billing");
    expect(t).toContain("See Intelligence on billing");
  });

  it("links to /billing, which is a registered route", async () => {
    const html = await render({ intelligenceActive: false });
    expect(html).toMatch(/<a[^>]*href="\/billing"/);
    expect(ROUTES_TS).toContain('index("./routes/app/billing/index.tsx")');
  });

  it("shows none of the delivery rows", async () => {
    const t = text(await render({ intelligenceActive: false }));
    expect(t).not.toContain("Weekly MRR and health summary");
  });
});

describe("J69: an account with Intelligence sees Recova's deliveries, each marked not built", () => {
  it("is one Capsomer panel naming Recova's two deliveries in Recova's order", async () => {
    const html = await render({ intelligenceActive: true });
    expect(html).toMatch(/<section class="cap-panel"/);
    const t = text(html);
    const summary = t.indexOf("Weekly MRR and health summary");
    const health = t.indexOf("Alert when a customer's health score drops below a threshold");
    expect(summary).toBeGreaterThan(-1);
    expect(health).toBeGreaterThan(summary);
  });

  it("marks each one Not built with Capsomer's status, where Recova had its checkbox", async () => {
    const html = await render({ intelligenceActive: true });
    const statuses = [...html.matchAll(/<span class="cap-status"[^>]*data-tone="nodata"[^>]*>[\s\S]*?<\/span>/g)];
    expect(statuses.map((m) => text(m[0]))).toEqual(["Not built", "Not built"]);
  });

  it("builds no control: no form, input, select or button, because nothing reads them", async () => {
    const html = await render({ intelligenceActive: true });
    expect(html).not.toMatch(/<form\b/);
    expect(html).not.toMatch(/<input\b/);
    expect(html).not.toMatch(/<select\b/);
    expect(html).not.toMatch(/<button\b/);
    expect(text(html)).not.toContain("Save");
  });

  it("points at what is built: the narrative on the dashboard and Reports, and Settings and Alerts", async () => {
    const html = await render({ intelligenceActive: true });
    for (const to of ["/intelligence/dashboard", "/intelligence/reports", "/settings/alerts"]) {
      expect(html, `links to ${to}`).toMatch(new RegExp(`<a[^>]*href="${to}"`));
    }
    expect(ROUTES_TS).toContain('route("dashboard", "./routes/app/intelligence/index.tsx")');
    expect(ROUTES_TS).toContain('route("reports", "./routes/app/intelligence/reports.tsx")');
    expect(ROUTES_TS).toContain('route("alerts", "./routes/app/settings/alerts.tsx")');
  });

  it("names the average health score metric by the engine's own label, which the evaluator computes", async () => {
    expect(ALERT_METRICS).toContain("health_score_avg");
    const t = text(await render({ intelligenceActive: true }));
    expect(t).toContain(ALERT_METRIC_LABELS.health_score_avg);
  });

  it("says alert breaches are recorded and emailed, which is what the nightly run does (J94, E21)", async () => {
    const t = text(await render({ intelligenceActive: true }));
    expect(t).toContain(
      "records each breach on that page and emails it to your notification address; it does not post alerts to Slack",
    );
    expect(t).not.toMatch(/does not email/);
    // The nightly run's code, comments removed, notifies each firing before it
    // records it; every alert is created with the email channel (J33).
    const run = code(readFileSync(new URL("../app/lib/intelligence/ai-run.server.ts", import.meta.url), "utf8"));
    expect(run).toContain("const outcome = await notifyThresholdAlert(env, target, f, now);");
    expect(run).toContain("buildAlertHistoryInsert(db, f, now, outcome.sent)");
  });
});

// ---------------------------------------------------------------------------
// The reader guard. Recova's five settings live in
// intelligence_notification_preferences. Foxhound's schema has the table and
// account deletion clears it; nothing else touches it. The day something reads
// it, the matching control belongs on this page, and this test says so.
// ---------------------------------------------------------------------------

const APP_DIR = fileURLToPath(new URL("../app", import.meta.url));
// workers/ holds the Worker entry and its Durable Objects, where a cron
// handler could read the table. mcp/ cannot: it has no D1 binding.
const WORKERS_DIR = fileURLToPath(new URL("../workers", import.meta.url));
const ROOT_DIR = fileURLToPath(new URL("..", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

/** Source with comments removed, so a comment that names the table (this
 *  page's own header does) is not mistaken for a reader. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("J69: the reader guard", () => {
  it("finds a known reference first, so an empty result means something", () => {
    const hits = walk(APP_DIR).filter((f) => readFileSync(f, "utf8").includes("intelligenceNotificationPreferences"));
    expect(hits.some((f) => f.endsWith(join("db", "schema.ts")))).toBe(true);
  });

  it("the walk reaches workers/ too", () => {
    expect(walk(WORKERS_DIR).some((f) => f.endsWith(join("workers", "app.ts")))).toBe(true);
  });

  it("nothing in app/ or workers/ reads Recova's Intelligence preferences except the schema and account deletion", () => {
    const allowed = [join("db", "schema.ts"), join("auth", "delete-account.server.ts")];
    const readers = [...walk(APP_DIR), ...walk(WORKERS_DIR)]
      .filter((f) => !allowed.some((a) => f.endsWith(a)))
      .filter((f) =>
        /intelligenceNotificationPreferences|intelligence_notification_preferences|weekly_?[nN]arrative_?(email|slack|Email|Slack)|health_?[aA]lert_?(email|slack|threshold|Email|Slack|Threshold)/.test(
          code(readFileSync(f, "utf8")),
        ),
      )
      .map((f) => f.slice(ROOT_DIR.length));
    expect(
      readers,
      "a reader now exists: add its control to /settings/intelligence and update this guard",
    ).toEqual([]);
  });

  it("the page file itself names none of Recova's five fields", () => {
    const src = readFileSync(ROUTE_FILE, "utf8");
    for (const field of [
      "weekly_narrative_email",
      "weekly_narrative_slack",
      "health_alert_email",
      "health_alert_slack",
      "health_alert_threshold",
    ]) {
      expect(code(src)).not.toContain(field);
    }
  });
});

describe("J69: the docs describe the page that now exists", () => {
  it("the Intelligence guide names Settings and Intelligence, and no longer says there is no page", async () => {
    const { DOC_GUIDES } = await import("~/lib/marketing/docs-content");
    const body = DOC_GUIDES.flatMap((g) => g.sections)
      .flatMap((s) => s.body)
      .map((b) => (typeof b === "string" ? b : JSON.stringify(b)))
      .join(" ");
    expect(body).not.toContain("Intelligence has no settings page of its own yet");
    expect(body).toContain("With Intelligence active, Settings and Intelligence lists");
    expect(body).toContain("there is no weekly narrative email");
  });
});
