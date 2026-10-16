import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Outlet, createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "~/db";
import {
  accounts,
  customerContext,
  disputeApprovals,
  disputeEvidence,
  disputes,
  failedPayments,
  recoverySteps,
  stripeConnections,
} from "~/db/schema";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { DISPUTE_FEE_BPS, DISPUTE_FEE_CAP_CENTS } from "~/lib/constants";
import { buildDisputeTimeline } from "~/lib/disputes/timeline";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// J77 (job_4d41a53774f0), row S14: /disputes/:id is Recova's page
// (app/(app)/disputes/[id]/page.tsx a9452f59, DisputeDetailClient.tsx 3d56b55d,
// components/disputes/* at the blobs the job names, read whole) built from
// Capsomer 0.9.0's parts (Q10), teal (Q11), on Foxhound's engine. Every
// assertion here was seen failing first.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  approve: null as null | ((...args: unknown[]) => Promise<unknown>),
  importResult: { status: "imported" } as { status: string },
}));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));
vi.mock("~/lib/disputes/queries.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("~/lib/disputes/queries.server")>();
  return {
    ...real,
    approveAndSubmitDispute: (...args: Parameters<typeof real.approveAndSubmitDispute>) =>
      harness.approve ? harness.approve(...args) : real.approveAndSubmitDispute(...args),
  };
});
vi.mock("~/lib/disputes/manual-import.server", () => ({
  importDisputeFromStripe: async () => harness.importResult,
}));

const route = await import("~/routes/app/disputes/detail");
const Page = route.default as unknown as (props: Record<string, unknown>) => ReturnType<typeof createElement>;
const SOURCE = readFileSync("app/routes/app/disputes/detail.tsx", "utf8");

const NOW = Date.parse("2026-10-16T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const A = "acct_alpha";
const B = "acct_beta";

type LoaderData = Awaited<ReturnType<typeof route.loader>>;

function contextFor(accountId: string, isDemo = false): unknown {
  return {
    get(key: unknown) {
      if (key === cloudflareContext) {
        return { env: {} as Env, ctx: { waitUntil() {} } as unknown as ExecutionContext, nonce: "n" };
      }
      if (key === authContext) {
        return {
          userId: "u",
          userName: "u",
          email: "owner@alpha.test",
          membership: { memberId: "m", accountId, accountName: "Alpha", role: "owner" },
          memberships: [],
          activeAccountId: accountId,
          isAdmin: false,
          isDemo,
          demoSignedIn: false,
        };
      }
      throw new Error("unexpected context key");
    },
  };
}

let sqlite: ReturnType<typeof createInMemoryDb>["sqlite"];
let db: Db;

function seedDispute(over: Partial<typeof disputes.$inferInsert> = {}): string {
  const id = over.id ?? "dsp_1";
  runStatement(
    sqlite,
    db.insert(disputes).values({
      id,
      accountId: A,
      stripeDisputeId: `dp_${id}`,
      stripeChargeId: `ch_${id}`,
      stripeCustomerId: "cus_1",
      customerEmail: "jordan@example.com",
      customerName: "Jordan Lee",
      amountCents: 12_000,
      currency: "usd",
      reason: "product_not_received",
      status: "needs_response",
      evidenceDeadline: new Date(NOW + 9 * DAY),
      createdAt: new Date(NOW - 2 * DAY),
      state: "pending_review",
      ...over,
    }),
  );
  return id;
}

function seedEvidence(fieldName: string, fieldValue: string, over: Partial<typeof disputeEvidence.$inferInsert> = {}) {
  runStatement(
    sqlite,
    db.insert(disputeEvidence).values({
      id: `ev_${fieldName}_${over.accountId ?? A}`,
      disputeId: "dsp_1",
      accountId: A,
      fieldName,
      fieldValue,
      createdAt: new Date(NOW - 2 * DAY),
      ...over,
    }),
  );
}

function seedFailedPayment(over: Partial<typeof failedPayments.$inferInsert> & { id: string }) {
  runStatement(
    sqlite,
    db.insert(failedPayments).values({
      accountId: A,
      stripeEventId: `evt_${over.id}`,
      stripeInvoiceId: `in_${over.id}`,
      stripeCustomerId: "cus_1",
      customerEmail: "jordan@example.com",
      customerName: "Jordan Lee",
      amountCents: 4999,
      currency: "usd",
      declineCategory: "soft",
      declineCode: "insufficient_funds",
      status: "recovered",
      detectedAt: new Date(NOW - 40 * DAY),
      ...over,
    }),
  );
}

function seedStep(over: Partial<typeof recoverySteps.$inferInsert> & { id: string; failedPaymentId: string }) {
  runStatement(
    sqlite,
    db.insert(recoverySteps).values({
      accountId: A,
      stepType: "email_day1",
      stepNumber: 1,
      scheduledAt: new Date(NOW - 39 * DAY),
      executedAt: null,
      result: null,
      attemptCount: 0,
      ...over,
    }),
  );
}

function seedConnection(): void {
  runStatement(
    sqlite,
    db.insert(stripeConnections).values({
      id: "conn_1",
      accountId: A,
      stripeUserId: "acct_stripe_1",
      stripeAccessToken: "enc",
      createdAt: new Date(NOW - 90 * DAY),
    }),
  );
}

async function load(id = "dsp_1", accountId = A, isDemo = false): Promise<LoaderData> {
  return (await route.loader({
    context: contextFor(accountId, isDemo),
    request: new Request(`https://foxhoundapp.test/disputes/${id}`),
    params: { id },
  } as never)) as LoaderData;
}

async function act(fields: Record<string, string>, id = "dsp_1", accountId = A): Promise<{ status: number; body: unknown }> {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  const result = await route.action({
    context: contextFor(accountId),
    request: new Request(`https://foxhoundapp.test/disputes/${id}`, { method: "POST", body }),
    params: { id },
  } as never);
  const r = result as { init?: { status?: number }; data?: unknown };
  return { status: r.init?.status ?? 200, body: r.data ?? result };
}

function render(loaderData: LoaderData, opts: { actionData?: unknown; isDemo?: boolean } = {}): string {
  try {
    const Stub = createRoutesStub([
      {
        id: "app-shell",
        path: "/",
        Component: () => createElement(Outlet),
        children: [
          {
            path: "disputes/:id",
            Component: () => createElement(Page, { loaderData, actionData: opts.actionData }),
          },
        ],
      },
    ] as never);
    return renderToStaticMarkup(
      createElement(Stub, {
        initialEntries: ["/disputes/dsp_1"],
        hydrationData: { loaderData: { "app-shell": { isDemo: Boolean(opts.isDemo) } } },
      } as never),
    );
  } catch (err) {
    return `render failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function text(html: string): string {
  return html
    .replace(/<span class="sr-only">[\s\S]*?<\/span>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&middot;/g, "·")
    .replace(/\s+/g, " ")
    .trim();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.approve = null;
  harness.importResult = { status: "imported" };
  runStatement(sqlite, db.insert(accounts).values({ id: A, name: "Alpha" }));
  runStatement(sqlite, db.insert(accounts).values({ id: B, name: "Beta" }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---- Built from Capsomer ----

describe("J77: built from Capsomer 0.9.0's parts (Q10)", () => {
  it("uses Capsomer's panel and status, not Foxhound's badge", () => {
    expect(SOURCE).not.toContain('from "~/components/badge"');
    expect(SOURCE).toContain('from "capsomer/react/panel"');
    expect(SOURCE).toContain('from "capsomer/react/status"');
  });

  it("puts no Foxhound class on a Capsomer element", async () => {
    seedDispute();
    seedEvidence("product_description", "Growth plan");
    seedEvidence("uncategorized_text", "The customer used the product.");
    const html = render(await load(), { actionData: { error: "Stripe did not accept the submission: no" } });
    const classes = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]!);
    const capsomer = classes.filter((c) => c.split(/\s+/).some((x) => x.startsWith("cap-")));
    expect(capsomer.length).toBeGreaterThan(8);
    for (const cls of capsomer) expect(cls.split(/\s+/).every((c) => c.startsWith("cap-")), cls).toBe(true);
  });

  it("puts no block element inside a paragraph", async () => {
    seedDispute();
    seedEvidence("product_description", "Growth plan");
    const html = render(await load(), { actionData: { error: "Stripe did not accept the submission: no" } });
    for (const p of html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)) {
      expect(p[1], p[0].slice(0, 120)).not.toMatch(/<(div|p|ul|ol|li|h[1-6]|section|dl)\b/);
    }
  });
});

// ---- Layout and header ----

describe("J77: Recova's container, back link and header", () => {
  it("sits in Recova's 960px column with its padding", () => {
    expect(SOURCE).toContain('className="mx-auto max-w-[960px] px-4 py-10 md:px-8"');
  });

  it("opens with Recova's back link to the disputes dashboard", async () => {
    seedDispute();
    const html = render(await load());
    expect(html).toMatch(/<a[^>]*href="\/disputes\/dashboard"[^>]*>[^<]*Back to disputes<\/a>/);
  });

  it("reads 'All disputes' in the demo, as Recova's demo does", async () => {
    seedDispute();
    const html = render(await load("dsp_1", A, true), { isDemo: true });
    expect(text(html)).toContain("All disputes");
    expect(text(html)).not.toContain("Back to disputes");
  });

  it("shows the amount large and first, then the customer as the heading, then the reason", async () => {
    seedDispute();
    const html = render(await load());
    const amount = html.indexOf("$120.00");
    const h1 = html.indexOf("<h1");
    expect(amount).toBeGreaterThan(-1);
    expect(amount).toBeLessThan(h1);
    const amountClass = html.match(/<div class="([^"]*)">\$120\.00<\/div>/)?.[1]?.split(" ") ?? [];
    expect(amountClass).toEqual(expect.arrayContaining(["text-display", "font-mono", "font-bold", "text-brand-text"]));
    expect(html).toMatch(/<h1[^>]*>Jordan Lee<\/h1>/);
    expect(text(html)).toMatch(/Jordan Lee Product not received/);
  });

  it("names an unnamed customer 'Unknown customer', as Recova does", async () => {
    seedDispute({ customerName: null });
    expect(render(await load())).toMatch(/<h1[^>]*>Unknown customer<\/h1>/);
  });

  it("says the days remaining in Recova's words", async () => {
    seedDispute();
    expect(text(render(await load()))).toContain("9 days remaining");
  });

  it("says one day in the singular", async () => {
    seedDispute({ evidenceDeadline: new Date(NOW + 12 * HOUR) });
    expect(text(render(await load()))).toContain("1 day remaining");
  });

  it("says when the deadline has passed or was never set", async () => {
    seedDispute({ evidenceDeadline: new Date(NOW - DAY) });
    expect(text(render(await load()))).toContain("Deadline passed");
    sqlite.exec("delete from disputes");
    seedDispute({ evidenceDeadline: null });
    expect(text(render(await load()))).toContain("No deadline set");
  });

  it("shows Recova's Won badge once closed, and no deadline", async () => {
    seedDispute({ state: "resolved_won", resolvedAt: new Date(NOW - DAY), resolvedFeeCents: 2400, resolvedFeeCurrency: "usd" });
    const t = text(render(await load()));
    expect(t).toMatch(/Product not received Won/);
    expect(t).not.toContain("remaining");
  });

  it("carries no state badge or due date Recova's header lacks", async () => {
    seedDispute();
    const t = text(render(await load()));
    expect(t).not.toContain("Pending review");
    expect(t).not.toContain("Evidence due");
  });
});

// ---- What Foxhound found ----

describe("J77: What Foxhound found (Recova's DisputeEvidenceSummary)", () => {
  it("is titled for Foxhound, never Recova", async () => {
    seedDispute();
    const html = render(await load());
    expect(html).toMatch(/<h2[^>]*>What Foxhound found<\/h2>/);
    expect(html).not.toContain("Recova");
  });

  it("lists the customer's name and email under Customer context", async () => {
    seedDispute();
    const t = text(render(await load()));
    expect(t).toContain("Customer context Name Jordan Lee Email jordan@example.com");
  });

  it("shows the customer's dispute history from the Intelligence counters", async () => {
    seedDispute();
    runStatement(
      sqlite,
      db.insert(customerContext).values({
        id: "cc_1",
        accountId: A,
        stripeCustomerId: "cus_1",
        disputeSignals: { disputeCount: 4, wonCount: 1, lostCount: 2 },
        createdAt: new Date(NOW - 50 * DAY),
        updatedAt: new Date(NOW - DAY),
      }),
    );
    expect(text(render(await load()))).toContain("Dispute history 1 won · 2 lost");
  });

  it("flags a fraud decline on record with its code", async () => {
    seedDispute();
    seedFailedPayment({ id: "fp_f", declineCategory: "fraud", declineCode: "stolen_card", status: "failed_unrecovered" });
    expect(text(render(await load()))).toContain("Fraud decline on record (stolen_card)");
  });

  it("shows the recovery context and the emails Foxhound sent for the latest failed payment", async () => {
    seedDispute();
    seedFailedPayment({ id: "fp_old", detectedAt: new Date(NOW - 90 * DAY), declineCategory: "expired", status: "failed_unrecovered" });
    seedFailedPayment({ id: "fp_new", detectedAt: new Date(NOW - 40 * DAY), declineCategory: "soft", status: "recovered" });
    seedStep({ id: "s1", failedPaymentId: "fp_new", stepType: "silent_retry", executedAt: new Date(NOW - 39 * DAY), result: "retry_failed" });
    seedStep({
      id: "s2",
      failedPaymentId: "fp_new",
      stepType: "email_day1",
      executedAt: new Date(Date.parse("2026-09-07T10:00:00Z")),
      result: "email_sent",
      emailOpenedCount: 3,
    });
    seedStep({ id: "s3", failedPaymentId: "fp_new", stepType: "email_day3", executedAt: null });
    const t = text(render(await load()));
    expect(t).toMatch(/Recovery email history Sep 7, 2026 .*email.* · opened 3x/i);
    expect(t).toContain("Recovery context");
    expect(t).toMatch(/Decline category: Soft/i);
    expect(t).toContain("Steps attempted: 2");
    expect(t).toContain("Sequence outcome: Recovered");
  });

  it("reads only the active account's rows for the same customer", async () => {
    seedDispute();
    seedFailedPayment({ id: "fp_b", accountId: B, declineCategory: "fraud", declineCode: "stolen_card" });
    runStatement(
      sqlite,
      db.insert(customerContext).values({
        id: "cc_b",
        accountId: B,
        stripeCustomerId: "cus_1",
        disputeSignals: { disputeCount: 9, wonCount: 5, lostCount: 4 },
        createdAt: new Date(NOW - 50 * DAY),
        updatedAt: new Date(NOW - DAY),
      }),
    );
    const t = text(render(await load()));
    expect(t).not.toContain("Fraud decline");
    expect(t).not.toContain("Dispute history");
    expect(t).not.toContain("Recovery context");
  });

  it("renders nothing over data no Foxhound code writes (RULES.md 3.18)", async () => {
    seedDispute({
      avsResult: "pass",
      cvvResult: "pass",
      radarRiskScore: 14,
      radarRiskLevel: "normal",
      smartDisputesStatus: "available",
      triageRecommendation: "fight",
      triageReasoning: "Strong history.",
      triageConfidence: 88,
      priorChargesCount: 3,
      priorChargesTotal: 30_000,
      billingAddress: "1 Main St",
      threeDSecure: "authenticated",
    });
    const t = text(render(await load()));
    for (const word of ["AVS", "CVV", "Radar", "Smart Disputes", "recommends", "Confidence", "Prior charge", "Billing address", "3D Secure"]) {
      expect(t, word).not.toContain(word);
    }
  });
});

// ---- Staged evidence and Additional evidence ----

describe("J77: Staged evidence and Additional evidence", () => {
  it("lists the structured fields read-only and the narrative in Recova's editable box", async () => {
    seedDispute();
    seedEvidence("product_description", "Growth plan");
    seedEvidence("uncategorized_text", "The customer used the product.");
    const html = render(await load());
    expect(html).toMatch(/<h2[^>]*>Staged evidence<\/h2>/);
    expect(html).toMatch(/<dt[^>]*>Product description<\/dt><dd[^>]*>Growth plan<\/dd>/);
    expect(html).toMatch(/<label[^>]*for="dispute_evidence_narrative"[^>]*>Evidence narrative \(editable\)<\/label>/);
    expect(html).toMatch(/<textarea[^>]*id="dispute_evidence_narrative"[^>]*>The customer used the product\.<\/textarea>/);
    expect(text(html)).toContain("Save draft");
  });

  it("says truly that nothing was drafted, never that evidence is on the way", async () => {
    seedDispute();
    const t = text(render(await load()));
    expect(t).toContain("Staged evidence");
    expect(t).not.toContain("being prepared");
    expect(t).toContain("Foxhound found no records for this charge to draft evidence from.");
  });

  it("offers Recova's Customer IP box while the dispute is open", async () => {
    seedDispute();
    seedEvidence("product_description", "Growth plan");
    const html = render(await load());
    expect(html).toMatch(/<h2[^>]*>Additional evidence \(optional\)<\/h2>/);
    expect(html).toMatch(/<label[^>]*for="dispute_customer_ip"[^>]*>Customer IP<\/label>/);
    expect(html).toContain('placeholder="e.g. 198.51.100.14"');
    expect(text(html)).toContain(
      "Only add if you have the actual IP from your own logs. Do not guess. Saved with your draft and included when you submit.",
    );
  });

  it("drops the editing once submitted", async () => {
    seedDispute({ state: "submitted", submittedAt: new Date(NOW - DAY), submittedBy: "owner@alpha.test" });
    seedEvidence("uncategorized_text", "Narrative.");
    const html = render(await load());
    expect(html).not.toContain("Additional evidence");
    expect(text(html)).not.toContain("Save draft");
    expect(html).toMatch(/<textarea[^>]*readOnly=""|<textarea[^>]*readonly=""/);
  });

  it("hides editing in the demo, as Recova's demo does", async () => {
    seedDispute();
    seedEvidence("uncategorized_text", "Narrative.");
    const html = render(await load("dsp_1", A, true), { isDemo: true });
    expect(html).not.toContain("dispute_evidence_narrative");
    expect(html).not.toContain("Additional evidence");
    expect(text(html)).not.toContain("Approve and submit");
    expect(text(html)).not.toContain("Sync a different dispute");
  });

  it("saves the narrative over its row and adds the IP as Stripe's customer_purchase_ip", async () => {
    seedDispute();
    seedEvidence("uncategorized_text", "Old.");
    const res = await act({ intent: "save", narrative: "New narrative.", customer_ip: "198.51.100.14" });
    expect(res.status).toBe(200);
    const rows = sqlite
      .prepare("select field_name, field_value, account_id from dispute_evidence where dispute_id = 'dsp_1' order by field_name")
      .all();
    expect(rows).toEqual([
      { field_name: "customer_purchase_ip", field_value: "198.51.100.14", account_id: A },
      { field_name: "uncategorized_text", field_value: "New narrative.", account_id: A },
    ]);
  });

  it("adds no row for a blank field", async () => {
    seedDispute();
    await act({ intent: "save", narrative: "", customer_ip: "  " });
    expect(sqlite.prepare("select count(*) as n from dispute_evidence").get()).toEqual({ n: 0 });
  });

  it("refuses to save another account's dispute", async () => {
    seedDispute();
    await expect(act({ intent: "save", narrative: "x" }, "dsp_1", B)).rejects.toMatchObject({ status: 404 });
  });

  it("logs the whole error and answers 500 with Recova's line when a save fails", async () => {
    seedDispute();
    const err = new Error("D1 down");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const realBatch = (db as unknown as { batch: unknown }).batch;
    (db as unknown as { batch: unknown }).batch = async () => {
      throw err;
    };
    try {
      const res = await act({ intent: "save", narrative: "x" });
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ intent: "save", error: "Could not save." });
      expect(spy).toHaveBeenCalledWith(expect.any(String), err);
    } finally {
      (db as unknown as { batch: unknown }).batch = realBatch;
    }
  });

  it("shows Recova's Saved and Could not save lines beside the button", async () => {
    seedDispute();
    seedEvidence("uncategorized_text", "x");
    expect(text(render(await load(), { actionData: { ok: true, intent: "save" } }))).toContain("Save draft Saved.");
    expect(text(render(await load(), { actionData: { error: "Could not save.", intent: "save" } }))).toContain(
      "Save draft Could not save.",
    );
  });
});

// ---- Sync, approve, order ----

describe("J77: Recova's sync form and the approve card", () => {
  it("offers Recova's 'Sync a different dispute from Stripe' below the evidence", async () => {
    seedDispute();
    const html = render(await load());
    expect(html).toMatch(/<button[^>]*>Sync a different dispute from Stripe<\/button>/);
  });

  it("imports through the same importer and reports in its words", async () => {
    seedDispute();
    harness.importResult = { status: "not_found" };
    const res = await act({ intent: "sync_dispute", stripe_dispute_id: "dp_x" });
    expect(res.body).toMatchObject({ sync: { ok: false, message: "No dispute with that ID on your Stripe account." } });
  });

  it("states the fee terms from the billing constants", async () => {
    seedDispute();
    const t = text(render(await load()));
    expect(t).toContain(`${DISPUTE_FEE_BPS / 100}% of the disputed amount, capped at $${DISPUTE_FEE_CAP_CENTS / 100}`);
    expect(SOURCE).not.toMatch(/\(20% of|capped at \$500/);
  });

  it("keeps the approval gate: the approver's user id goes to approveAndSubmitDispute", async () => {
    seedConnection();
    seedDispute({ stripeConnectionId: "conn_1" });
    let seen: unknown[] = [];
    harness.approve = async (...args: unknown[]) => {
      seen = args;
      return { status: "submitted" };
    };
    const res = await act({ intent: "approve" });
    expect(res.status).toBe(200);
    expect(seen[2]).toMatchObject({ approvedByUserId: "u", accountId: A, disputeId: "dsp_1" });
  });

  it("logs the whole error and answers 500 with a true line when approval throws", async () => {
    seedConnection();
    seedDispute({ stripeConnectionId: "conn_1" });
    const err = new Error("confirm write failed");
    harness.approve = async () => {
      throw err;
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await act({ intent: "approve" });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      intent: "approve",
      error:
        "Something went wrong while submitting. Stripe may or may not have received the evidence, so check this dispute in Stripe before trying again.",
    });
    expect(spy).toHaveBeenCalledWith(expect.any(String), err);
  });

  it("shows an approve failure on the approve card", async () => {
    seedDispute();
    const html = render(await load(), { actionData: { error: "Stripe did not accept the submission: no", intent: "approve" } });
    const card = html.indexOf("Approve and submit");
    const err = html.indexOf("Stripe did not accept the submission");
    expect(err).toBeGreaterThan(card);
    expect(html).toMatch(/role="alert"/);
  });

  it("orders the sections as Recova does", async () => {
    seedDispute();
    seedEvidence("product_description", "Growth plan");
    const t = text(render(await load()));
    const order = [
      "Back to disputes",
      "$120.00",
      "Timeline",
      "What Foxhound found",
      "Staged evidence",
      "Additional evidence (optional)",
      "Sync a different dispute from Stripe",
      "Approve and submit",
    ].map((s) => t.indexOf(s));
    for (const i of order) expect(i).toBeGreaterThan(-1);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("keeps the approval record and the fee receipt once submitted", async () => {
    seedDispute({ state: "resolved_won", resolvedAt: new Date(NOW - DAY), resolvedFeeCents: 2400, resolvedFeeCurrency: "usd", submittedAt: new Date(NOW - 3 * DAY) });
    runStatement(
      sqlite,
      db.insert(disputeApprovals).values({
        id: "ap_1",
        disputeId: "dsp_1",
        accountId: A,
        approvedByUserId: "u",
        approvedByEmail: "owner@alpha.test",
        evidenceVersionHash: "h",
        approvedAt: new Date(NOW - 3 * DAY),
      }),
    );
    const t = text(render(await load()));
    expect(t).toContain("Approved by owner@alpha.test");
    expect(t).toContain("Won. Fee of $24.00 billed at the next monthly run.");
  });
});

// ---- Timeline in Recova's words ----

describe("J77: the timeline in Recova's words", () => {
  const base = {
    createdAt: new Date(NOW),
    amountCents: 9_900,
    currency: "usd",
    reason: "product_not_received",
    aiGeneratedAt: null,
    stagedAt: null,
    submittedAt: null,
    submittedBy: null,
    outcomeNotifiedAt: null,
    resolvedAt: null,
    state: "pending_review",
  };

  it("says who submitted as Recova does", () => {
    const ours = buildDisputeTimeline({ ...base, submittedAt: new Date(NOW + DAY), submittedBy: "owner@alpha.test", state: "submitted" });
    expect(ours.at(-1)!.label).toBe("Evidence submitted to bank by Foxhound.");
    const theirs = buildDisputeTimeline({ ...base, submittedAt: new Date(NOW + DAY), submittedBy: "merchant_or_stripe", state: "submitted" });
    expect(theirs.at(-1)!.label).toBe("Evidence submitted to bank by externally (merchant or Stripe).");
  });

  it("states the ruling as Recova does", () => {
    const won = buildDisputeTimeline({ ...base, resolvedAt: new Date(NOW + DAY), state: "resolved_won" });
    expect(won.at(-1)!.label).toBe("Bank ruled: WON. Funds retained.");
    const lost = buildDisputeTimeline({ ...base, resolvedAt: new Date(NOW + DAY), state: "resolved_lost" });
    expect(lost.at(-1)!.label).toBe("Bank ruled: LOST. Funds deducted.");
  });

  it("prints each event in Recova's text size and colour", async () => {
    seedDispute();
    const html = render(await load());
    expect(html).toMatch(/<span class="text-label text-text">Dispute received\. \$120\.00 for Product not received\.<\/span>/);
  });
});

// ---- Review of 8d09fe5 (CHANGES): the draft is locked once approved ----

describe("J77 review: the draft cannot change after an approval exists", () => {
  function seedApproval(): void {
    runStatement(
      sqlite,
      db.insert(disputeApprovals).values({
        id: "ap_1",
        disputeId: "dsp_1",
        accountId: A,
        approvedByUserId: "u",
        approvedByEmail: "owner@alpha.test",
        evidenceVersionHash: "h",
        approvedAt: new Date(NOW - HOUR),
      }),
    );
  }
  const evidenceRows = () =>
    sqlite.prepare("select field_name, field_value from dispute_evidence order by field_name").all();

  it("refuses a save on a submitted dispute with 409 and changes nothing", async () => {
    seedDispute({ state: "submitted", submittedAt: new Date(NOW - HOUR), submittedBy: "owner@alpha.test" });
    seedEvidence("uncategorized_text", "Approved text.");
    const res = await act({ intent: "save", narrative: "Edited.", customer_ip: "198.51.100.14" });
    expect(res.status).toBe(409);
    expect(evidenceRows()).toEqual([{ field_name: "uncategorized_text", field_value: "Approved text." }]);
  });

  it("refuses a save with 409 once a pending approval row exists, though the state is still approvable", async () => {
    seedDispute();
    seedEvidence("uncategorized_text", "Approved text.");
    seedApproval();
    const res = await act({ intent: "save", narrative: "Edited.", customer_ip: "198.51.100.14" });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ intent: "save", error: "This dispute has been approved, so its evidence is locked." });
    expect(evidenceRows()).toEqual([{ field_name: "uncategorized_text", field_value: "Approved text." }]);
  });

  it("writes nothing when the approval lands between the read and the write (the guard is joined to the write)", async () => {
    seedDispute();
    seedEvidence("uncategorized_text", "Approved text.");
    const { saveDisputeDraft } = await import("~/lib/disputes/queries.server");
    const existing = [{ id: "ev_uncategorized_text_acct_alpha", fieldName: "uncategorized_text" }];
    seedApproval(); // after the caller's read, before its write
    await saveDisputeDraft(db, A, "dsp_1", existing, [
      { fieldName: "uncategorized_text", fieldValue: "Edited." },
      { fieldName: "customer_purchase_ip", fieldValue: "198.51.100.14" },
    ], new Date(NOW));
    expect(evidenceRows()).toEqual([{ field_name: "uncategorized_text", field_value: "Approved text." }]);
  });

  it("does not insert a second row for a field another save already added", async () => {
    seedDispute();
    const { saveDisputeDraft } = await import("~/lib/disputes/queries.server");
    // Two first-time saves that both read "no IP row yet".
    await saveDisputeDraft(db, A, "dsp_1", [], [{ fieldName: "customer_purchase_ip", fieldValue: "198.51.100.1" }], new Date(NOW));
    await saveDisputeDraft(db, A, "dsp_1", [], [{ fieldName: "customer_purchase_ip", fieldValue: "198.51.100.2" }], new Date(NOW));
    expect(evidenceRows()).toEqual([{ field_name: "customer_purchase_ip", field_value: "198.51.100.1" }]);
  });

  it("shows the draft read-only with no Save draft once approved", async () => {
    seedDispute();
    seedEvidence("uncategorized_text", "Approved text.");
    seedApproval();
    const html = render(await load());
    expect(html).toMatch(/<textarea[^>]*readOnly=""|<textarea[^>]*readonly=""/);
    expect(text(html)).not.toContain("Save draft");
    expect(html).not.toContain("Additional evidence");
  });
});

describe("J77 review: Approve never sends a draft with unsaved edits", () => {
  it("blocks Approve and says why while the draft has unsaved edits", () => {
    const html = renderToStaticMarkup(createElement(route.ApproveButton, { label: "Approve and submit (fee $24.00)", approving: false, dirty: true }));
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*aria-describedby="dispute_approve_unsaved"/);
    expect(text(html)).toContain("You have unsaved changes. Save your draft first: Approve submits the saved draft.");
  });

  it("lets Approve through once the draft is saved", () => {
    const html = renderToStaticMarkup(createElement(route.ApproveButton, { label: "Approve and submit (fee $24.00)", approving: false, dirty: false }));
    expect(html).not.toContain("aria-disabled");
    expect(html).not.toContain("unsaved changes");
  });

  it("counts an edit made during a save as still unsaved", async () => {
    const { draftAfter } = await import("~/lib/disputes/detail");
    let s = { edits: 0, submitted: 0, saved: 0 };
    s = draftAfter(s, { type: "edit" });
    expect(s.edits !== s.saved).toBe(true);
    s = draftAfter(s, { type: "submit" });
    s = draftAfter(s, { type: "edit" }); // typed while the save was in flight
    s = draftAfter(s, { type: "saved" });
    expect(s.edits !== s.saved).toBe(true);
    s = draftAfter(s, { type: "submit" });
    s = draftAfter(s, { type: "saved" });
    expect(s.edits !== s.saved).toBe(false);
  });
});

describe("J77 review: one row per field, the same one everywhere", () => {
  it("sends Stripe the first row of a duplicated field, the one the page shows and the save edits", async () => {
    const { buildStripeEvidencePayload } = await import("~/lib/disputes/submission");
    const { splitEvidence } = await import("~/lib/disputes/detail");
    const rows = [
      { id: "a", fieldName: "uncategorized_text", fieldValue: "First." },
      { id: "b", fieldName: "uncategorized_text", fieldValue: "Second." },
    ];
    expect(splitEvidence(rows, true).narrative).toBe("First.");
    expect(buildStripeEvidencePayload(rows).uncategorized_text).toBe("First.");
  });

  it("reads evidence in a fixed order, oldest first", async () => {
    seedDispute();
    seedEvidence("uncategorized_text", "Later.", { id: "ev_z", createdAt: new Date(NOW - DAY) });
    seedEvidence("uncategorized_text", "Earlier.", { id: "ev_y", createdAt: new Date(NOW - 2 * DAY) });
    const data = await load();
    expect(data.evidence.map((e) => e.id)).toEqual(["ev_y", "ev_z"]);
  });
});
