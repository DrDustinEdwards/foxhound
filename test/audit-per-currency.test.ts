import type Database from "better-sqlite3";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AuditDisputesSection,
  AuditHealthSection,
  AuditRecoverySection,
} from "~/components/audit/sections";
import { runAudit, type ScopeOutcome } from "~/lib/audit/engine";
import { buildMonthlyAuditEmail } from "~/lib/audit/monthly-email";
import { toAuditRunView, type AuditRunView } from "~/lib/audit/render";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// job_ed1c41e4bd95: an account charging in two currencies. Recova added the
// amounts together and labelled the sum with the first currency it saw, so
// $1,240 and EUR 310 read "$1,550". Dustin approved one line per currency on
// 2026-10-25 (parity/APPROVED-DIFFERENCES.md). Each money figure is kept per
// currency (RULES.md 3.20) on the live page, a saved run and the monthly email.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const RAN_AT = new Date("2026-10-10T09:00:00.000Z");
const ok = <T>(data: T[]): ScopeOutcome<T[]> => ({ ok: true, data });

const invoice = (amount: number, currency: string) =>
  ({ amount_due: amount, currency, created: 1 }) as unknown as Stripe.Invoice;
const subscription = (amount: number, currency: string, customer: string) =>
  ({
    status: "active",
    currency,
    customer,
    default_payment_method: { card: { exp_month: 10, exp_year: 2026 } },
    items: { data: [{ price: { unit_amount: amount, recurring: { interval: "month", interval_count: 1 } } }] },
  }) as unknown as Stripe.Subscription;
const dispute = (amount: number, currency: string, status: string) =>
  ({ amount, currency, status, evidence_details: { submission_count: 0 } }) as unknown as Stripe.Dispute;

/** $1,240 and EUR 310 failed; $1,000 and EUR 500 MRR; $200 and EUR 50 in open
 *  disputes, and $300 and EUR 70 lost without a response. */
const twoCurrencies = () =>
  runAudit({
    stripeAccountId: "acct_stripe_x",
    lookbackDays: 90,
    ranAt: RAN_AT,
    reads: {
      uncollectibleInvoices: ok([invoice(100_000, "usd"), invoice(31_000, "eur"), invoice(24_000, "usd")]),
      openInvoices: ok<Stripe.Invoice>([]),
      subscriptions: ok([subscription(100_000, "usd", "cus_1"), subscription(50_000, "eur", "cus_2")]),
      disputes: ok([
        dispute(20_000, "usd", "needs_response"),
        dispute(5_000, "eur", "under_review"),
        dispute(30_000, "usd", "lost"),
        dispute(7_000, "eur", "lost"),
      ]),
      cardUpdaterEvents: ok<Stripe.Event>([]),
    },
  });

function render(element: ReactElement): string {
  const Stub = createRoutesStub([{ path: "/", Component: () => element }]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/"] }));
}

function renderRun(run: AuditRunView): string {
  return [
    render(createElement(AuditRecoverySection, { run, ctaState: "active" })),
    render(createElement(AuditDisputesSection, { run, ctaState: "active" })),
    render(createElement(AuditHealthSection, { run, when: "stored" })),
  ].join("\n");
}

/** Each figure's lines in the order shown, and never a sum across currencies. */
function expectPerCurrency(html: string) {
  for (const [usd, eur, mixed] of [
    ["$1,240", "€310", "$1,550"], // failed invoices
    ["$1,000", "€500", "$1,500"], // expiring MRR, and MRR
    ["$12,000", "€6,000", "$18,000"], // ARR
    ["$200", "€50", "$250"], // open disputes
    ["$300", "€70", "$370"], // accepted without fighting
  ] as const) {
    // Each amount is an element of its own, so match it whole.
    expect(html).toContain(`>${usd}<`);
    expect(html).toContain(`>${eur}<`);
    expect(html).not.toContain(`>${mixed}<`);
    expect(html.indexOf(`>${usd}<`)).toBeLessThan(html.indexOf(`>${eur}<`));
  }
}

let sqlite: Database.Database;
const ACCOUNT = "acct_alpha";

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

describe("audit money figures, one line per currency", () => {
  beforeEach(() => {
    const made = createInMemoryDb();
    sqlite = made.sqlite;
    harness.db = made.db;
    sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, 1000)").run(ACCOUNT, ACCOUNT);
  });

  async function loadRun(id: string): Promise<AuditRunView> {
    const runPage = await import("~/routes/app/audit/run");
    const data = (await runPage.loader({
      context: contextFor(ACCOUNT),
      request: new Request(`https://foxhoundapp.test/audit/results/${id}`),
      params: { id },
    } as never)) as { run: AuditRunView };
    return data.run;
  }

  it("/audit/results shows each currency on its own line", () => {
    expectPerCurrency(renderRun(toAuditRunView(twoCurrencies(), null)));
  });

  it("/audit/results/:id keeps the lines through the save", async () => {
    const { saveAuditRun } = await import("~/lib/audit/persist.server");
    const id = await saveAuditRun({} as Env, twoCurrencies(), {
      accountId: ACCOUNT,
      isAuthenticated: true,
      summary: "s",
      now: RAN_AT,
    });
    expectPerCurrency(renderRun(await loadRun(id)));
  });

  it("a run stored before this keeps showing its one total", async () => {
    sqlite
      .prepare(
        `INSERT INTO audit_runs (id, account_id, run_at, lookback_days, created_at, currency,
           failed_invoices_count, failed_invoices_cents, mrr_cents, arr_cents, active_subscriptions_count,
           voluntary_churn_rate_bps, involuntary_churn_rate_bps)
         VALUES ('old', ?, 1000, 90, 1000, 'usd', 3, 155000, 150000, 1800000, 2, 0, 0)`,
      )
      .run(ACCOUNT);
    const html = renderRun(await loadRun("old"));
    expect(html).toContain(">$1,550<");
    expect(html).toContain(">$1,500<");
    expect(html).toContain(">$18,000<");
  });

  it("the monthly audit email gives each currency its own line", () => {
    const { blocks } = buildMonthlyAuditEmail({
      result: twoCurrencies(),
      summary: "s",
      runId: "run_1",
      baseUrl: "https://foxhoundapp.test",
      comparisons: [],
    });
    const lines = blocks.map((b) => ("text" in b ? b.text : ""));
    const after = (first: string) => lines[lines.indexOf(first) + 1];
    expect(after("MRR: $1,000")).toBe("€500");
    expect(after("ARR: $12,000")).toBe("€6,000");
    expect(after("Failed payments detected: 3, $1,240")).toBe("€310");
    expect(after("Expiring cards: 2, $1,000 MRR at risk")).toBe("€500 MRR at risk");
    expect(after("Open disputes: 2, $200")).toBe("€50");
    expect(lines.join("\n")).not.toMatch(/\$1,550|\$1,500|\$18,000|\$250/);
  });
});
