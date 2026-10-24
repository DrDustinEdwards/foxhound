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
  stripeConnections,
} from "~/db/schema";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// J77 (job_4d41a53774f0), row S14: /disputes/:id is Recova's page
// (app/(app)/disputes/[id]/page.tsx a9452f59, DisputeDetailClient.tsx 3d56b55d,
// components/disputes/* at the blobs the job names, read whole) built from
// Capsomer 0.9.0's parts (Q10), teal (Q11), on Foxhound's engine. Every
// assertion here was seen failing first.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  approve: null as null | ((...args: unknown[]) => Promise<unknown>),
  beforeSave: null as null | (() => void),
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
    // Lets a test act between the action's read and its write.
    saveDisputeDraft: (...args: Parameters<typeof real.saveDisputeDraft>) => {
      harness.beforeSave?.();
      return real.saveDisputeDraft(...args);
    },
  };
});
vi.mock("~/lib/disputes/manual-import.server", () => ({
  importDisputeFromStripe: async () => harness.importResult,
}));

const route = await import("~/routes/app/disputes/detail");
const { ApproveButton } = await import("~/components/dispute-detail-parts");
const Page = route.default as unknown as (props: Record<string, unknown>) => ReturnType<typeof createElement>;

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
  harness.beforeSave = null;
  harness.importResult = { status: "imported" };
  runStatement(sqlite, db.insert(accounts).values({ id: A, name: "Alpha" }));
  runStatement(sqlite, db.insert(accounts).values({ id: B, name: "Beta" }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---- What Foxhound found ----

describe("J77: What Foxhound found (Recova's DisputeEvidenceSummary)", () => {

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
});

// ---- Staged evidence and Additional evidence ----

describe("J77: Staged evidence and Additional evidence", () => {

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
});

// ---- Sync, approve, order ----

describe("J77: Recova's sync form and the approve card", () => {

  it("imports through the same importer and reports in its words", async () => {
    seedDispute();
    harness.importResult = { status: "not_found" };
    const res = await act({ intent: "sync_dispute", stripe_dispute_id: "dp_x" });
    expect(res.body).toMatchObject({ sync: { ok: false, message: "No dispute with that ID on your Stripe account." } });
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
});

describe("J77 review: Approve never sends a draft with unsaved edits", () => {
  it("blocks Approve and says why while the draft has unsaved edits", () => {
    const html = renderToStaticMarkup(createElement(ApproveButton, { label: "Approve and submit (fee $24.00)", approving: false, dirty: true }));
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*aria-describedby="dispute_approve_unsaved"/);
    expect(text(html)).toContain("You have unsaved changes. Save your draft first: Approve submits the saved draft.");
  });

  it("lets Approve through once the draft is saved", () => {
    const html = renderToStaticMarkup(createElement(ApproveButton, { label: "Approve and submit (fee $24.00)", approving: false, dirty: false }));
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
});

// ---- Re-review of a297ac1 (CHANGES): a guarded write that wrote nothing is not "Saved." ----

describe("J77 re-review: a save that wrote nothing is reported, never Saved (RULES.md 3.9)", () => {
  const NOT_SAVED = "Your draft was not saved: this dispute changed. Reload to see the current evidence.";

  it("answers 409 when an approval lands between the read and the write", async () => {
    seedDispute();
    seedEvidence("uncategorized_text", "Approved text.");
    harness.beforeSave = () =>
      runStatement(
        sqlite,
        db.insert(disputeApprovals).values({
          id: "ap_race",
          disputeId: "dsp_1",
          accountId: A,
          approvedByUserId: "u",
          approvedByEmail: "owner@alpha.test",
          evidenceVersionHash: "h",
          approvedAt: new Date(NOW),
        }),
      );
    const res = await act({ intent: "save", narrative: "Edited." });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ intent: "save", error: NOT_SAVED });
  });

  it("shows the refusal beside Save draft, so the draft stays unsaved", async () => {
    seedDispute();
    seedEvidence("uncategorized_text", "x");
    const t = text(render(await load(), { actionData: { error: NOT_SAVED, intent: "save" } }));
    expect(t).toContain(`Save draft ${NOT_SAVED}`);
    expect(t).not.toContain("Saved.");
  });
});

describe("PR 149 review (J06): Accept beside an approval, and the confirmation's name", () => {
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

  it("the action refuses an Accept while an approval stands, with 409, before Stripe", async () => {
    seedDispute();
    seedConnection();
    seedApproval();
    const res = await act({ intent: "accept" });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      intent: "accept",
      error: "This dispute's evidence has been approved for submission, so it cannot be accepted here.",
    });
    expect((sqlite.prepare("select state from disputes where id = 'dsp_1'").get() as { state: string }).state).not.toBe(
      "resolved_lost",
    );
  });
});
