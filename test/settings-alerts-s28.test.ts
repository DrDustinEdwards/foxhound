import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// S28, /settings/alerts.
//
// THE READER CAME FIRST ON THIS ROW. `evaluateAlerts` has been reading `alerts`
// and writing `alert_history` nightly against a table nothing could write to.
// So the plants are aimed at the two ways this surface could lie: offering a
// metric the evaluator does not compute, and promising a notification nothing
// sends.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { action, loader } = await import("~/routes/app/settings/alerts");
const { ALERT_METRICS } = await import("~/lib/constants");
const { evaluateAlerts } = await import("~/lib/intelligence/alerts");

const ACCOUNT = "acct_1";
const OTHER = "acct_other";

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, 1000)").run(ACCOUNT, "Acme");
  sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, 1000)").run(OTHER, "Other");
});

function seedAlert(opts: {
  id: string;
  accountId?: string;
  metric?: string;
  direction?: string;
  threshold?: number;
  enabled?: boolean;
  label?: string | null;
}): void {
  sqlite
    .prepare(
      "INSERT INTO alerts (id, account_id, metric, threshold_value, direction, channel, label, enabled, created_at) VALUES (?, ?, ?, ?, ?, 'email', ?, ?, 1000)",
    )
    .run(
      opts.id,
      opts.accountId ?? ACCOUNT,
      opts.metric ?? "mrr_at_risk_cents",
      opts.threshold ?? 100,
      opts.direction ?? "above",
      opts.label ?? null,
      opts.enabled === false ? 0 : 1,
    );
}

function alertRows(accountId: string) {
  return sqlite
    .prepare(
      "SELECT id, metric, threshold_value AS threshold, direction, channel, label, enabled FROM alerts WHERE account_id = ? ORDER BY id",
    )
    .all(accountId) as {
    id: string;
    metric: string;
    threshold: number;
    direction: string;
    channel: string;
    label: string | null;
    enabled: number;
  }[];
}

const ctx = {
  get(key: unknown) {
    if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
    if (key === authContext) {
      return {
        userId: "user_1",
        userName: "Owner",
        email: "owner@acme.test",
        membership: { memberId: "m2", accountId: ACCOUNT, accountName: "Acme", role: "owner" },
        // The caller holds TWO accounts and is switched to the LATER one, so a
        // reader that resolved the earliest membership instead of the active
        // one fails rather than coincidentally agreeing.
        memberships: [
          { memberId: "m1", accountId: OTHER, accountName: "Other", role: "owner" },
          { memberId: "m2", accountId: ACCOUNT, accountName: "Acme", role: "owner" },
        ],
        activeAccountId: ACCOUNT,
        isAdmin: false,
        isDemo: false,
        demoSignedIn: false,
      };
    }
    throw new Error("unexpected context key");
  },
} as unknown as Parameters<typeof action>[0]["context"];

async function post(fields: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = (await action({
    context: ctx,
    request: new Request("https://foxhoundapp.test/settings/alerts", { method: "POST", body: form }),
    params: {},
  } as never)) as unknown as { data: Record<string, unknown>; init?: { status?: number } };
  return { status: res.init?.status ?? 200, body: res.data };
}

describe("PLANT 1: create writes only the columns this surface owns", () => {
  it("stores the alert with the account, the channel default and enabled true", async () => {
    const res = await post({
      _action: "create",
      metric: "mrr_at_risk_cents",
      direction: "above",
      threshold: "50",
      label: "Churn watch",
    });

    expect(res.status).toBe(200);
    const rows = alertRows(ACCOUNT);
    expect(rows).toHaveLength(1);
    // Dollars in the form, CENTS in the column the evaluator compares against.
    expect(rows[0].threshold).toBe(5000);
    expect(rows[0].label).toBe("Churn watch");
    expect(rows[0].enabled).toBe(1);
  });

  it("a form posting extra column names writes none of them", async () => {
    await post({
      _action: "create",
      metric: "health_score_avg",
      direction: "below",
      threshold: "40",
      accountId: OTHER,
      account_id: OTHER,
      enabled: "false",
      channel: "slack",
      lastTriggeredAt: "1",
      last_triggered_at: "1",
    });

    const rows = alertRows(ACCOUNT);
    expect(rows).toHaveLength(1);
    expect(rows[0].enabled).toBe(1);
    // The channel is the module's default, never the form's.
    expect(rows[0].channel).toBe("email");
    expect(alertRows(OTHER)).toHaveLength(0);
    const lastTriggered = sqlite
      .prepare("SELECT last_triggered_at AS t FROM alerts WHERE id = ?")
      .get(rows[0].id) as { t: number | null };
    expect(lastTriggered.t).toBeNull();
  });

  it("health_score_avg is NOT converted to cents", async () => {
    await post({ _action: "create", metric: "health_score_avg", direction: "below", threshold: "40" });
    expect(alertRows(ACCOUNT)[0].threshold).toBe(40);
  });
});

describe("PLANT 2: every bound the evaluator implies is enforced", () => {
  it("400 and NO write for a metric the evaluator does not compute", async () => {
    // Legacy offers eleven metrics. Foxhound computes four. This is one of
    // legacy's, and storing it would create a rule that is skipped every night
    // without ever saying so.
    const res = await post({
      _action: "create",
      metric: "recovery_rate_pct",
      direction: "below",
      threshold: "25",
    });

    expect(res.status).toBe(400);
    expect(alertRows(ACCOUNT)).toHaveLength(0);
  });

  it("every metric the form offers IS one the evaluator computes", async () => {
    // The real invariant, asserted against the evaluator rather than the list.
    for (const metric of ALERT_METRICS) {
      const res = await post({ _action: "create", metric, direction: "above", threshold: "1" });
      expect(res.status).toBe(200);
    }
    expect(alertRows(ACCOUNT)).toHaveLength(ALERT_METRICS.length);

    const configs = alertRows(ACCOUNT).map((r) => ({
      id: r.id,
      accountId: ACCOUNT,
      metric: r.metric,
      thresholdValue: r.threshold,
      direction: r.direction as "above" | "below",
      channel: "email",
      enabled: true,
    }));
    const metrics = Object.fromEntries(ALERT_METRICS.map((m) => [m, 1_000_000]));
    // Every one of them fires, so none was stored as a key the evaluator skips.
    expect(evaluateAlerts(configs, metrics, new Map())).toHaveLength(ALERT_METRICS.length);
  });

  it("400 and NO write for a bad direction, a negative threshold, or no threshold", async () => {
    for (const fields of [
      { _action: "create", metric: "health_score_avg", direction: "sideways", threshold: "5" },
      { _action: "create", metric: "health_score_avg", direction: "below", threshold: "-1" },
      { _action: "create", metric: "health_score_avg", direction: "below", threshold: "" },
      { _action: "create", metric: "health_score_avg", direction: "below", threshold: "abc" },
    ]) {
      const res = await post(fields);
      expect(res.status).toBe(400);
    }
    expect(alertRows(ACCOUNT)).toHaveLength(0);
  });

  it("no error string carries a wide dash", async () => {
    const wide = new RegExp("[" + String.fromCharCode(0x2014, 0x2013) + "]");
    const res = await post({ _action: "create", metric: "nope", direction: "above", threshold: "1" });
    expect(String(res.body.error)).not.toMatch(wide);
  });
});

describe("PLANT 3: toggle and delete are account-scoped", () => {
  it("toggling flips enabled on this account's alert", async () => {
    seedAlert({ id: "a1", enabled: true });
    await post({ _action: "toggle", alertId: "a1", enabled: "false" });
    expect(alertRows(ACCOUNT)[0].enabled).toBe(0);
  });

  it("an alert on ANOTHER account is untouched by toggle and by delete", async () => {
    seedAlert({ id: "a_theirs", accountId: OTHER, enabled: true });

    await post({ _action: "toggle", alertId: "a_theirs", enabled: "false" });
    expect(alertRows(OTHER)[0].enabled).toBe(1);

    await post({ _action: "delete", alertId: "a_theirs" });
    expect(alertRows(OTHER)).toHaveLength(1);
  });

  it("delete removes the alert and its own firing history, and nobody else's", async () => {
    seedAlert({ id: "a1" });
    seedAlert({ id: "a2" });
    for (const [id, alertId] of [
      ["h1", "a1"],
      ["h2", "a2"],
    ] as const) {
      sqlite
        .prepare(
          "INSERT INTO alert_history (id, alert_id, account_id, metric, threshold_value, direction, actual_value, channel, fired_at, notification_sent) VALUES (?, ?, ?, 'mrr_at_risk_cents', 100, 'above', 200, 'email', 1000, 0)",
        )
        .run(id, alertId, ACCOUNT);
    }

    const res = await post({ _action: "delete", alertId: "a1" });

    expect(res.status).toBe(200);
    expect(alertRows(ACCOUNT).map((r) => r.id)).toEqual(["a2"]);
    const remaining = sqlite.prepare("SELECT id FROM alert_history ORDER BY id").all() as { id: string }[];
    expect(remaining.map((r) => r.id)).toEqual(["h2"]);
  });

  it("400 and no write when no alert id is sent", async () => {
    seedAlert({ id: "a1", enabled: true });
    expect((await post({ _action: "toggle", enabled: "false" })).status).toBe(400);
    expect((await post({ _action: "delete" })).status).toBe(400);
    expect(alertRows(ACCOUNT)[0].enabled).toBe(1);
  });
});

describe("PLANT 4: the render offers legacy's control set, minus what would lie", () => {
  const SOURCE = readFileSync(
    fileURLToPath(new URL("../app/routes/app/settings/alerts.tsx", import.meta.url)),
    "utf8",
  );
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("carries legacy's create, toggle and delete controls and both empty states", () => {
    expect(code).toContain("Create alert");
    expect(code).toContain("Delete alert");
    expect(code).toContain("Recent triggers");
    expect(code).toContain("No alerts yet.");
    expect(code).toContain("No alerts have fired yet.");
  });

  it("the metric options come from the evaluator's enum, not a hand-written list", () => {
    // A hand-written list is how the eleven-versus-four gap would come back.
    expect(code).toContain("ALERT_METRICS.map");
    for (const legacyOnly of [
      "recovery_rate_pct",
      "active_sequences",
      "emails_sent_7d",
      "open_disputes_count",
      "audit_leaking_cents",
    ]) {
      expect(code).not.toContain(legacyOnly);
    }
  });

  it("NO channel picker, and no promise of a notification nothing sends", () => {
    // alert_history.notification_sent is written false and never read by a
    // sender. Legacy's subtitle "Get notified..." is therefore not ported.
    expect(code).not.toContain('name="channel"');
    expect(code).not.toContain("Slack");
    expect(code).not.toContain("Get notified");
    expect(code).not.toContain("email goes to");
  });

  it("every write goes through DemoGuardedForm", () => {
    expect(code).toContain('<DemoGuardedForm method="post"');
    expect(code).not.toContain('<Form method="post"');
    expect(code).not.toContain('<form method="post"');
  });

  it("the loader reuses the existing reader rather than a second query", () => {
    expect(SOURCE).toContain("getAlertsView");
  });
});

describe("PLANT 5: the loader is scoped to the active account", () => {
  it("returns the ACTIVE account's alerts, never the earliest membership's", async () => {
    seedAlert({ id: "a_mine" });
    // OTHER is an account the SAME caller holds, and it is their earliest
    // membership. This is the case a first-membership shim gets wrong.
    seedAlert({ id: "a_theirs", accountId: OTHER });

    const loaded = (await loader({
      context: ctx,
      request: new Request("https://x/settings/alerts"),
      params: {},
    } as never)) as { alerts: { id: string }[]; history: unknown[] };

    expect(loaded.alerts.map((a) => a.id)).toEqual(["a_mine"]);
    expect(loaded.history).toEqual([]);
  });
});

describe("PLANT 6: the docs describe what was built, including what it does not do", () => {
  const DOCS = readFileSync(
    fileURLToPath(new URL("../app/lib/marketing/docs-content.ts", import.meta.url)),
    "utf8",
  );

  it("names the four metrics and no others", () => {
    expect(DOCS).toContain("Settings and Alerts");
    for (const shown of ["average health score", "MRR at risk", "churned MRR", "contracted MRR"]) {
      expect(DOCS).toContain(shown);
    }
    // Legacy metrics Foxhound does not compute must not be promised HERE.
    // Scoped to the Alerts section: "recovery rate" is legitimate prose in the
    // recovery guide, and a whole-file assertion caught that instead.
    const section = DOCS.slice(DOCS.indexOf('heading: "Alerts"'), DOCS.indexOf('heading: "API keys"'));
    for (const absent of ["recovery rate", "active sequences", "open disputes"]) {
      expect(section.toLowerCase()).not.toContain(absent);
    }
  });

  it("says plainly that nothing is delivered yet", () => {
    expect(DOCS).toContain("does not email or Slack you when an alert fires yet");
    expect(DOCS).toContain("Recent triggers");
  });
});
