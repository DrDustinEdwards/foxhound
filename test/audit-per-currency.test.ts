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
import { cloudflareContext } from "@dustinedwards/site-runtime/context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// An account charging in two currencies shows one line per currency, never a sum, on the live page,
// a saved run, the history and the monthly email.

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
    items: {
      data: [
        { price: { unit_amount: amount, recurring: { interval: "month", interval_count: 1 } } },
      ],
    },
  }) as unknown as Stripe.Subscription;
const dispute = (amount: number, currency: string, status: string) =>
  ({
    amount,
    currency,
    status,
    evidence_details: { submission_count: 0 },
  }) as unknown as Stripe.Dispute;

/** $1,240 and EUR 310 failed; $1,000 and EUR 500 MRR; $200 and EUR 50 in open
 *  disputes, and $300 and EUR 70 lost without a response. USD comes first in
 *  Stripe's rows. `failed` replaces the failed invoices, for an earlier run. */
const twoCurrencies = (
  failed = [invoice(100_000, "usd"), invoice(31_000, "eur"), invoice(24_000, "usd")],
  ranAt = RAN_AT,
) =>
  runAudit({
    stripeAccountId: "acct_stripe_x",
    lookbackDays: 90,
    ranAt,
    reads: {
      uncollectibleInvoices: ok(failed),
      openInvoices: ok<Stripe.Invoice>([]),
      subscriptions: ok([
        subscription(100_000, "usd", "cus_1"),
        subscription(50_000, "eur", "cus_2"),
      ]),
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
    render(createElement(AuditHealthSection, { run })),
  ].join("\n");
}

/** Each figure's lines, never a sum across currencies, in currency-code order
 *  as the other per-currency totals are (views.server.ts), not in the order
 *  Stripe's rows came. */
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
    expect(html.indexOf(`>${eur}<`)).toBeLessThan(html.indexOf(`>${usd}<`));
  }
}

let sqlite: Database.Database;
const ACCOUNT = "acct_alpha";

function contextFor(accountId: string): unknown {
  return {
    get(key: unknown) {
      if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext };
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
    sqlite
      .prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, 1000)")
      .run(ACCOUNT, ACCOUNT);
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
    expect(after("MRR: €500")).toBe("$1,000");
    expect(after("ARR: €6,000")).toBe("$12,000");
    expect(after("Failed payments detected: 3, €310")).toBe("$1,240");
    expect(after("Expiring cards: 2, €500 MRR at risk")).toBe("$1,000 MRR at risk");
    expect(after("Open disputes: 2, €50")).toBe("$200");
    expect(lines.join("\n")).not.toMatch(/\$1,550|\$1,500|\$18,000|\$250/);
  });

  async function save(result: ReturnType<typeof twoCurrencies>, now: Date): Promise<string> {
    const { saveAuditRun } = await import("~/lib/audit/persist.server");
    return saveAuditRun({} as Env, result, {
      accountId: ACCOUNT,
      isAuthenticated: true,
      summary: "s",
      now,
    });
  }

  async function renderHistory(): Promise<string> {
    const page = await import("~/routes/app/audit/dashboard");
    const loaderData = await page.loader({
      context: contextFor(ACCOUNT),
      request: new Request("https://foxhoundapp.test/audit/dashboard"),
      params: {},
    } as never);
    return render(createElement(page.default, { loaderData, actionData: undefined } as never));
  }

  const EARLIER = new Date("2026-09-10T09:00:00.000Z");

  it("/audit/dashboard shows each currency on its own line, compared like with like", async () => {
    // A month earlier: $1,000 and EUR 200 failed.
    await save(twoCurrencies([invoice(100_000, "usd"), invoice(20_000, "eur")], EARLIER), EARLIER);
    await save(twoCurrencies(), RAN_AT);
    const html = await renderHistory();
    for (const cell of [">$1,240<", ">€310<", ">$200<", ">€50<", ">$1,000<", ">€500<", ">€200<"]) {
      expect(html).toContain(cell);
    }
    expect(html).not.toMatch(/>\$1,550<|>\$1,500<|>\$250<|>\$1,200</);
    // Failed invoices: EUR 200 to EUR 310 is up 55% and $1,000 to $1,240 up
    // 24%, each in its own currency. MRR and open disputes did not move.
    expect(html).toMatch(/€310<.*vs.*€200<.*55%.*\$1,240<.*vs.*\$1,000<.*24%/s);
  });
});
