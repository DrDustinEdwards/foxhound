import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import { ALERT_METRICS } from "~/lib/constants";
import { DOC_GUIDES, type DocBlock, type DocInline } from "~/lib/marketing/docs-content";

import { createInMemoryDb } from "./helpers/inmemory-db";

// PHASE (g)'S OWN GUARDS: the things the merge had to make true ABOUT THE REPO,
// as opposed to about one cron run. The behavioural suite is
// test/audit-monthly-362.test.ts; this file holds the derived sweeps and the
// pinned absences, which are the two kinds of assertion that go stale silently.
//
// THE ONE THAT MATTERS MOST IS PLANT 1. 362 ruling 3 exists because Foxhound had
// grown a SECOND monthly email off the same toggle without anyone noticing until
// a walk went looking. A plant naming the two known modules would not have caught
// that and would not catch the next one, so this derives the property from the
// toggle itself: whatever gates on `audit_auto_run` and also sends is the set,
// and the set has exactly one member.

const ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, ROOT)), "utf8");

/** Source with comments stripped, so an assertion cannot pass on a comment that
 *  EXPLAINS the thing it is asserting is absent (session 57's lesson, which this
 *  campaign has now walked into three times). */
const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

/** Every .ts/.tsx under app/, as repo-relative posix paths with their source. */
function appModules(): { path: string; body: string }[] {
  const out: { path: string; body: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = `${dir}/${entry}`;
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) {
        out.push({
          path: full.slice(full.indexOf("app/")).split("\\").join("/"),
          body: code(readFileSync(full, "utf8")),
        });
      }
    }
  };
  walk(fileURLToPath(new URL("app", ROOT)));
  return out;
}

// ============================================================================

describe("PLANT 1: EXACTLY ONE monthly merchant email hangs off the audit toggle", () => {
  it("one module both gates on audit_auto_run AND sends", () => {
    // DERIVED FROM THE TOGGLE, NOT FROM A LIST OF NAMES. 316 shipped a second
    // monthly send gated on this column and addressed to the same recipient, and
    // nothing went red: no plant existed that could see two of a thing. This one
    // can. A module that reads the opt-in and also reaches the sender is by
    // definition a monthly merchant email off this toggle, whatever it is called.
    const gatesOnToggle = (b: string) =>
      b.includes("isDigestEnabled") || b.includes("auditAutoRun") || b.includes("audit_auto_run");
    const sends = (b: string) =>
      b.includes("sendTransactionalEmail") || /\bsendEmail\s*\(/.test(b);

    const senders = appModules()
      .filter((m) => gatesOnToggle(m.body) && sends(m.body))
      .map((m) => m.path)
      .sort();

    expect(senders).toEqual(["app/lib/audit/monthly.server.ts"]);
  });

  it("and the dead module is GONE, not merely unregistered", () => {
    // A superseded send left on disk is a send one import away from returning.
    expect(appModules().map((m) => m.path)).not.toContain("app/lib/audit/digest.server.ts");
    expect(() => read("app/lib/audit/digest.server.ts")).toThrow();
  });

  it("the surviving module really does send, so PLANT 1 cannot pass by sending nothing", () => {
    // The non-vacuous half. An assertion that "exactly one module sends" is
    // satisfied just as well by one module that has stopped sending, which is
    // the failure mode 362 ruling 3 would produce if the merge dropped the email
    // instead of merging it.
    const monthly = code(read("app/lib/audit/monthly.server.ts"));
    expect(monthly).toContain("sendTransactionalEmail");
    expect(monthly).toContain("isDigestEnabled");
    expect(monthly).toContain("notificationEmail");
  });
});

describe("PLANT 2: legacy's alerts re-evaluation is ABSENT, and the reason is asserted", () => {
  it("the merged cron does not call the alert evaluator", () => {
    const monthly = code(read("app/lib/audit/monthly.server.ts"));
    expect(monthly).not.toContain("evaluateAlerts");
    expect(monthly).not.toContain("intelligence/alerts");
  });

  it("BECAUSE NO ALERT METRIC READS audit_runs, which is the part that can rot", () => {
    // THE JUSTIFICATION, PINNED RATHER THAN TRUSTED. Legacy runs its evaluator
    // after each audit insert because two of ITS metrics, audit_leaking_cents and
    // audit_leaking_delta_cents, source from the latest two runs. Foxhound has
    // neither, so the call would recompute a metric set no new audit row can
    // change. That is only true while the metric list stays audit-free: the day
    // someone adds an audit-sourced metric, this goes red and the decision gets
    // revisited on purpose, which is what session 66's plant did for audit_runs.
    expect([...ALERT_METRICS]).toEqual([
      "health_score_avg",
      "mrr_at_risk_cents",
      "mrr_churn_cents",
      "mrr_contraction_cents",
    ]);
    for (const metric of ALERT_METRICS) {
      expect(metric).not.toContain("audit");
    }
    // And nothing on the alert path reads the table, derived rather than assumed.
    const alertPath = appModules().filter(
      (m) =>
        m.path.startsWith("app/lib/intelligence/") ||
        m.path === "app/lib/settings/alerts.server.ts" ||
        m.path === "app/lib/cron/alerts.server.ts",
    );
    expect(alertPath.length).toBeGreaterThan(3); // it read something
    for (const m of alertPath) {
      expect(m.body, `${m.path} reads audit_runs`).not.toContain("auditRuns");
    }
  });

  it("Foxhound's evaluator is a DIFFERENT FUNCTION from legacy's, not the same one skipped", () => {
    // Legacy: evaluateAlerts(supabase, accountId), which does its own reads.
    // Foxhound: evaluateAlerts(configs, metrics, previousActuals), pure. Calling
    // it here would need metrics computed first, which is the intelligence cron's
    // whole job. Pinned so "we skipped an idempotent call" is not read back later
    // as the finding; the finding is that it is not that call at all.
    const alerts = code(read("app/lib/intelligence/alerts.ts"));
    expect(alerts).toContain("export function evaluateAlerts(");
    expect(alerts).toContain("configs: AlertConfig[]");
    expect(alerts).toContain("metrics: Record<string, number>");
    expect(alerts).not.toContain("async function evaluateAlerts");
  });
});

describe("PLANT 3: the merged cron is still free", () => {
  const monthly = code(read("app/lib/audit/monthly.server.ts"));

  it("records no outcome, writes no billing row, attributes nothing", () => {
    // PRICING rev 3: the audit is free. Phase (g) is where a monthly per-account
    // job could most easily acquire a fee, so the pin follows it here.
    for (const forbidden of [
      "recordOutcome",
      "executeMoneyWrite",
      "billingLineItems",
      "recoveredPayments",
      "findAttributionSignals",
      "createPlatformInvoice",
    ]) {
      expect(monthly, `${forbidden} reached the monthly audit`).not.toContain(forbidden);
    }
  });

  it("and its one write path is the plain insert phase (d) built", () => {
    expect(monthly).toContain("saveAuditRun");
    const persist = code(read("app/lib/audit/persist.server.ts"));
    expect(persist).not.toContain("executeMoneyWrite");
  });
});

describe("PLANT 4: the docs say ONE email, and every earlier state is gone", () => {
  const flat = (b: DocBlock): string => {
    if (typeof b === "string") return b;
    const inline = (n: DocInline): string =>
      typeof n === "string"
        ? n
        : "code" in n
          ? n.code
          : "strong" in n
            ? n.strong
            : "mono" in n
              ? n.mono
              : n.link;
    const rich = (r: string | DocInline[]): string =>
      typeof r === "string" ? r : r.map(inline).join("");
    switch (b.kind) {
      case "p":
        return rich(b.body);
      case "h3":
        return b.text;
      case "note":
      case "tip":
        return rich(b.body);
      case "steps":
      case "list":
        return b.items.map(rich).join(" ");
      case "table":
        return [...b.columns, ...b.rows.flat().map(rich)].join(" ");
      case "widget":
        return b.name;
    }
  };
  const guideText = (slug: string) =>
    DOC_GUIDES.find((g) => g.slug === slug)!
      .sections.map((s) => `${s.heading}\n${s.body.map(flat).join("\n")}`)
      .join("\n");

  const AUDIT = guideText("audit");
  const ALL = DOC_GUIDES.map((g) => guideText(g.slug)).join("\n");

  it("the audit guide says the monthly report re-runs the audit against Stripe", () => {
    expect(AUDIT).toContain("It is ONE email.");
    expect(AUDIT).toContain("The report reads your Stripe account fresh");
    expect(AUDIT).toContain(
      "on the 1st of each month Foxhound runs the whole audit again and emails you the result",
    );
  });

  it("EVERY EARLIER STATE OF THE DIGEST SENTENCE IS ABSENT, per 366's pattern", () => {
    // The digest's copy was true of the digest and is false of the merged
    // report. A guide that accumulates its own history is how two contradictory
    // claims end up on one page, which is the failure 360 opened M22 for.
    for (const dead of [
      "from its own records rather than from a fresh read of Stripe",
      "reads Foxhound's own numbers rather than calling Stripe again",
      "so it needs no live connection",
      "The lookback control on the same settings page has no reader yet",
      "the monthly digest is all-time and does not use it",
    ]) {
      expect(ALL, `stale digest claim survives: ${dead}`).not.toContain(dead);
    }
  });

  it("the guide says what the merged email needs, since it needs more than the digest did", () => {
    // The digest needed no Stripe connection; this does. Stating it is the
    // difference between a merchant understanding an absent email and filing a
    // bug about one.
    expect(AUDIT).toContain("needs a live Stripe connection");
    expect(AUDIT).toContain("Turn auto-run off and nothing is sent.");
  });

  it("and the lookback control's reader is acknowledged, because it now has one", () => {
    // Phase (f) gave the column its first reader and phase (g) its second. The
    // guide said for two sessions that it had none.
    expect(AUDIT).toContain("uses the lookback you set");
    const monthly = code(read("app/lib/audit/monthly.server.ts"));
    expect(monthly).toContain("readAuditSettings");
  });

  it("the notifications list names the monthly report beside the weekly digest", () => {
    const platform = guideText("platform");
    expect(platform).toContain("Monthly audit report.");
    expect(platform).toContain("Weekly digest.");
    // ONE email, said where a merchant looks for what will arrive.
    expect(platform).toContain("One email on the 1st");
  });
});

// ============================================================================
// The cron's own no-write proof, against the real schema
// ============================================================================

const harness = vi.hoisted(() => ({ db: null as unknown, stripe: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));
vi.mock("~/lib/stripe/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/stripe/client")>()),
  getConnectedStripe: () => harness.stripe,
}));
vi.mock("~/lib/stripe/encryption", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/stripe/encryption")>()),
  decryptToken: async () => "sk_test_token",
}));

const { runMonthlyAudit } = await import("~/lib/audit/monthly.server");
const { accounts, stripeConnections } = await import("~/db/schema");

const NOW = new Date("2026-09-01T09:00:00.000Z");

describe("PLANT 5: a real run leaves no money row behind", () => {
  it("audits, stores and mails without touching outcomes or billing", async () => {
    // The source pin above says the names are absent; this says the TABLES are
    // untouched after a run that really happened, against the committed schema.
    const { sqlite, db } = createInMemoryDb();
    harness.db = db;
    harness.stripe = {
      invoices: {
        list: () => ({
          async *[Symbol.asyncIterator]() {
            yield { amount_due: 4200, currency: "usd", status: "uncollectible" } as unknown as Stripe.Invoice;
          },
        }),
      },
      subscriptions: { list: () => ({ async *[Symbol.asyncIterator]() {} }) },
      disputes: { list: () => ({ async *[Symbol.asyncIterator]() {} }) },
      events: { list: () => ({ async *[Symbol.asyncIterator]() {} }) },
    } as unknown as Stripe;

    await db.insert(accounts).values({
      id: "acct_on",
      name: "acct_on",
      notificationEmail: "owner@merchant.test",
      auditAutoRun: true,
      createdAt: NOW,
    });
    await db.insert(stripeConnections).values({
      id: "sc_on",
      accountId: "acct_on",
      stripeUserId: "acct_stripe_on",
      stripeAccessToken: "enc",
      isPrimary: true,
      connectedAt: NOW,
      createdAt: NOW,
    });

    const env = {
      DB: {},
      EMAIL: { send: async () => ({ id: "m" }) },
      BETTER_AUTH_URL: "https://foxhoundapp.test",
    } as unknown as Env;

    const result = await runMonthlyAudit(env, NOW, null);
    expect(result.sent).toBe(1);

    const count = (t: string) =>
      (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    expect(count("outcomes")).toBe(0);
    expect(count("billing_line_items")).toBe(0);
    expect(count("recovered_payments")).toBe(0);
    // What it DID write: one audit run and one month claim.
    expect(count("audit_runs")).toBe(1);
    expect(count("audit_digest_runs")).toBe(1);
  });
});
