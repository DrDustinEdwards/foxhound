import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Outlet, createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "~/db";
import { accounts, failedPayments, recoveredPayments, recoverySteps } from "~/db/schema";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// J76 (job_61a5aec299ad), row S7: /recovery/payments/:id is Recova's page
// (app/(app)/recovery/payments/[id]/page.tsx 6034a8ba and PaymentDetailClient.tsx
// 7f54aa45, read whole, with lib/format.ts 080fb3b2 and lib/ui-display.ts
// 35c4d676 for its formatters and step words) built from Capsomer 0.9.0's parts
// (Q10), teal throughout (Q11), on Foxhound's engine. Every assertion here was
// seen failing first.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  dispatch: null as null | ((req: unknown) => Promise<unknown>),
}));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));
vi.mock("~/lib/recovery/manual-actions.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("~/lib/recovery/manual-actions.server")>();
  return {
    ...real,
    dispatchManualAction: (req: Parameters<typeof real.dispatchManualAction>[0]) =>
      harness.dispatch ? harness.dispatch(req) : real.dispatchManualAction(req),
  };
});

const route = await import("~/routes/app/recovery/payments/detail");
const Page = route.default as unknown as (props: Record<string, unknown>) => ReturnType<typeof createElement>;
const SOURCE = readFileSync("app/routes/app/recovery/payments/detail.tsx", "utf8");

const NOW = Date.parse("2026-10-16T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const A = "acct_alpha";
const B = "acct_beta";

type LoaderData = Awaited<ReturnType<typeof route.loader>>;

function contextFor(accountId: string): unknown {
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
          isDemo: false,
          demoSignedIn: false,
        };
      }
      throw new Error("unexpected context key");
    },
  };
}

let sqlite: ReturnType<typeof createInMemoryDb>["sqlite"];
let db: Db;

function seedPayment(over: Partial<typeof failedPayments.$inferInsert> = {}): string {
  const id = over.id ?? "fp_1";
  runStatement(
    sqlite,
    db.insert(failedPayments).values({
      id,
      accountId: A,
      stripeEventId: `evt_${id}`,
      stripeInvoiceId: `in_${id}`,
      stripeCustomerId: "cus_1",
      customerEmail: "jordan@example.com",
      customerName: "Jordan Lee",
      planName: "Growth",
      amountCents: 4999,
      currency: "usd",
      declineCategory: "soft",
      declineCode: "insufficient_funds",
      status: "active",
      detectedAt: new Date(NOW - 3 * DAY),
      ...over,
    }),
  );
  return id;
}

function seedStep(over: Partial<typeof recoverySteps.$inferInsert> & { id: string }): void {
  runStatement(
    sqlite,
    db.insert(recoverySteps).values({
      accountId: A,
      failedPaymentId: "fp_1",
      stepType: "email_day1",
      stepNumber: 1,
      scheduledAt: new Date(NOW - 2 * DAY),
      executedAt: null,
      result: null,
      attemptCount: 0,
      ...over,
    }),
  );
}

async function load(id = "fp_1", accountId = A): Promise<LoaderData> {
  return (await route.loader({
    context: contextFor(accountId),
    request: new Request(`https://foxhoundapp.test/recovery/payments/${id}`),
    params: { id },
  } as never)) as LoaderData;
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
            path: "recovery/payments/:id",
            Component: () => createElement(Page, { loaderData, actionData: opts.actionData }),
          },
        ],
      },
    ] as never);
    return renderToStaticMarkup(
      createElement(Stub, {
        initialEntries: ["/recovery/payments/fp_1"],
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
  harness.dispatch = null;
  runStatement(sqlite, db.insert(accounts).values({ id: A, name: "Alpha" }));
  runStatement(sqlite, db.insert(accounts).values({ id: B, name: "Beta" }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---- Built from Capsomer ----

describe("J76: built from Capsomer 0.9.0's parts (Q10)", () => {
  it("uses no Foxhound-only card or badge component", () => {
    expect(SOURCE).not.toContain('from "~/components/badge"');
    expect(SOURCE).not.toContain('from "~/components/stat-card"');
    expect(SOURCE).toContain('from "capsomer/react/panel"');
    expect(SOURCE).toContain('from "capsomer/react/status"');
    expect(SOURCE).toContain('from "capsomer/react/banner"');
  });

  it("puts no Foxhound class on a Capsomer element", async () => {
    seedPayment({ notes: "Called them." });
    seedStep({ id: "s1", executedAt: new Date(NOW - 2 * DAY), result: "email_sent", aiSubject: "Your card", aiBodyHtml: "<p>Hi</p>" });
    const html = render(await load(), { actionData: { notice: "Marked recovered successful" } });
    const classes = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]!);
    const capsomer = classes.filter((c) => c.split(/\s+/).some((x) => x.startsWith("cap-")));
    expect(capsomer.length).toBeGreaterThan(10);
    for (const cls of capsomer) expect(cls.split(/\s+/).every((c) => c.startsWith("cap-")), cls).toBe(true);
  });

  it("puts no block element inside a paragraph", async () => {
    seedPayment({ status: "recovered", resolvedAt: new Date(NOW - DAY) });
    runStatement(
      sqlite,
      db.insert(recoveredPayments).values({
        id: "rp_1",
        accountId: A,
        failedPaymentId: "fp_1",
        recoveredAt: new Date(NOW - 2 * DAY),
        amountCents: 4999,
        currency: "usd",
        recoveryMethod: "manual",
        attributionKind: "manual",
      }),
    );
    const html = render(await load(), { actionData: { error: "Step triggered failed" } });
    for (const p of html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)) {
      expect(p[1], p[0].slice(0, 120)).not.toMatch(/<(div|p|ul|ol|li|h[1-6]|section|dl)\b/);
    }
  });
});

// ---- Header ----

describe("J76: Recova's bare header", () => {
  it("is not boxed, and carries the status pill with the tab word but no amount", async () => {
    seedPayment();
    const html = render(await load());
    const header = html.match(/<header class="mb-7"[\s\S]*?<\/header>/)?.[0] ?? "";
    expect(header).toContain("<h1");
    expect(header).toMatch(/<span class="cap-pill"[^>]*>[\s\S]*?Active<\/span>/);
    expect(header).not.toContain("$49.99");
    expect(header).not.toContain("Soft");
    expect(html).not.toMatch(/rounded-lg border border-border bg-surface p-4"><div class="flex items-start/);
  });

  it("shows Copy email as Capsomer's link button and the plan after it", async () => {
    seedPayment();
    const t = text(render(await load()));
    expect(render(await load())).toMatch(/<button type="button" class="cap-link-btn"[^>]*>Copy email<\/button>/);
    expect(t).toMatch(/jordan@example\.com Copy email · Growth/);
  });
});

// ---- Actions ----

describe("J76: Recova's action row", () => {
  it("has no card or heading of Foxhound's own", async () => {
    seedPayment();
    expect(text(render(await load()))).not.toContain("Manual actions");
  });

  it("names the next step on the trigger button, from the engine's schedule", async () => {
    seedPayment();
    seedStep({ id: "s1", stepType: "email_day1", stepNumber: 1, executedAt: new Date(NOW - 2 * DAY), result: "email_sent" });
    seedStep({ id: "s2", stepType: "email_day3", stepNumber: 2, scheduledAt: new Date(NOW + DAY) });
    const html = render(await load());
    expect(html).toMatch(/<button[^>]*class="cap-btn"[^>]*data-variant="primary"[^>]*>Trigger Day 3 email now<\/button>/);
    expect(html).toMatch(/<button[^>]*class="cap-btn"[^>]*data-variant="danger"[^>]*>Stop recovery<\/button>/);
    expect(html).toMatch(/<button[^>]*class="cap-btn"[^>]*>Mark as recovered<\/button>/);
  });

  it("says Working... on the pressed button, as Recova's does", () => {
    expect(SOURCE).toContain('"Working..."');
  });

  it("shows disabled buttons in the demo, titled as Recova's are", async () => {
    seedPayment();
    seedStep({ id: "s2", stepType: "email_day3", stepNumber: 2, scheduledAt: new Date(NOW + DAY) });
    const html = render(await load(), { isDemo: true });
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*title="Connect Stripe to use this"[^>]*>Trigger Day 3 email now<\/button>/);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*title="Connect Stripe to use this"[^>]*>Mark as recovered<\/button>/);
    expect(html).not.toMatch(/name="intent" value="cancel"/);
  });
});

describe("J76: the action result, as Recova reports it", () => {
  it("says '<label> successful' on a Capsomer ok banner", async () => {
    seedPayment();
    harness.dispatch = async () => ({ ok: true, intent: "mark_recovered" });
    const res = (await route.action({
      context: contextFor(A),
      params: { id: "fp_1" },
      request: new Request("https://foxhoundapp.test/recovery/payments/fp_1", {
        method: "POST",
        body: new URLSearchParams({ intent: "mark_recovered" }),
      }),
    } as never)) as { data: { notice?: string }; init: { status: number } };
    expect(res.data.notice).toBe("Marked recovered successful");
    const html = render(await load(), { actionData: res.data });
    expect(html).toMatch(/<div class="cap-banner" data-tone="ok" role="status">[\s\S]*Marked recovered successful/);
  });

  it("uses Recova's words for each success", async () => {
    seedPayment();
    const cases: [unknown, string][] = [
      [{ ok: true, intent: "cancel" }, "Recovery stopped successful"],
      [{ ok: true, intent: "resend", subject: "Your card" }, "Email resent successful"],
      [{ ok: true, intent: "trigger", action: "email", result: "email_sent", subject: "S" }, "Step triggered successful"],
      [{ ok: true, intent: "trigger", action: "retry", result: "retry_succeeded", subject: null }, "Step triggered successful"],
    ];
    for (const [outcome, notice] of cases) {
      harness.dispatch = async () => outcome;
      const res = (await route.action({
        context: contextFor(A),
        params: { id: "fp_1" },
        request: new Request("https://x.test/", { method: "POST", body: new URLSearchParams({ intent: "x" }) }),
      } as never)) as { data: { notice?: string } };
      expect(res.data.notice).toBe(notice);
    }
  });

  it("clears a success after Recova's 2000ms and keeps an error", () => {
    expect(route.ACTION_SUCCESS_CLEAR_MS).toBe(2000);
    expect(SOURCE).toContain("setTimeout(() => setClearedNoticeFor(actionData), ACTION_SUCCESS_CLEAR_MS)");
    expect(SOURCE).toContain("setTimeout(() => setSavedClearedFor(noteResult), NOTE_SAVED_CLEAR_MS)");
  });

  it("shows an error on a Capsomer crit banner", async () => {
    seedPayment();
    const html = render(await load(), { actionData: { error: "No pending steps" } });
    expect(html).toMatch(/<div class="cap-banner" data-tone="crit" role="alert">[\s\S]*No pending steps/);
  });

  it("logs the whole error and answers 500 when the dispatcher throws", async () => {
    seedPayment();
    const boom = new Error("d1 went away");
    harness.dispatch = async () => {
      throw boom;
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = (await route.action({
      context: contextFor(A),
      params: { id: "fp_1" },
      request: new Request("https://x.test/", { method: "POST", body: new URLSearchParams({ intent: "resend" }) }),
    } as never)) as { data: { error?: string }; init: { status: number } };
    expect(res.init.status).toBe(500);
    expect(res.data.error).toBe("Email resent failed");
    expect(spy).toHaveBeenCalledWith(expect.any(String), boom);
  });
});

// ---- Info cards ----

describe("J76: Recova's four info cards", () => {
  it("are Amount, Decline, Detected and Customer age, in order, on Capsomer panels", async () => {
    seedPayment({ customerAgeDays: 400 });
    const html = render(await load());
    const titles = [...html.matchAll(/<header class="cap-panel-head"><h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1]);
    expect(titles.slice(0, 4)).toEqual(["Amount", "Decline", "Detected", "Customer age"]);
  });

  it("shows the amount in teal, the decline in Recova's word and colour, and Detected as Recova's time ago and short date", async () => {
    seedPayment({ detectedAt: new Date(NOW - 3 * DAY - 2 * HOUR) });
    const html = render(await load());
    expect(html).toMatch(/<p class="[^"]*text-brand-text[^"]*">\$49\.99<\/p>/);
    expect(html).toMatch(/<p class="[^"]*text-blue[^"]*">Soft<\/p>/);
    expect(text(html)).toMatch(/Detected 3d ago Oct 13/);
  });
});

// ---- Details and engagement ----

describe("J76: Decline details and Email engagement", () => {
  it("titles each section with a heading, as Recova does", async () => {
    seedPayment();
    const html = render(await load());
    for (const t of ["Decline details", "Email engagement", "Recovery timeline", "Internal notes"]) {
      expect(html).toMatch(new RegExp(`<h2[^>]*>${t}</h2>`));
    }
  });

  it("says Recova's empty line and dates a resolution as Recova does", async () => {
    seedPayment({ status: "cancelled", resolvedAt: new Date(NOW - DAY) });
    const t = text(render(await load()));
    expect(t).toContain("No emails sent yet");
    expect(t).not.toContain("No emails sent yet.");
    expect(t).toContain("Resolved Oct 15, 2026");
  });

  it("colours Opened and Clicked green when any were", async () => {
    seedPayment();
    seedStep({ id: "s1", executedAt: new Date(NOW - 2 * DAY), result: "email_sent", openedAt: new Date(NOW - DAY) });
    const html = render(await load());
    expect(html).toMatch(/<dd class="[^"]*text-green[^"]*">1 of 1<\/dd>/);
  });

  it("colours a previous failure's amount by its status and names its decline in Recova's word", async () => {
    seedPayment();
    seedPayment({ id: "fp_old", status: "recovered", detectedAt: new Date(NOW - 40 * DAY), declineCategory: "expired", amountCents: 1500 });
    const html = render(await load());
    expect(html).toMatch(/<span class="[^"]*text-green[^"]*">\$15\.00<\/span>/);
    expect(text(html)).toMatch(/Previous failures \(1\) 40d ago Expired \$15\.00/);
  });
});

// ---- Timeline ----

describe("J76: Recova's recovery timeline", () => {
  it("shows the count even at zero, and Recova's empty line", async () => {
    seedPayment();
    const t = text(render(await load()));
    expect(t).toContain("0 of 0 steps executed");
    expect(t).toContain("No recovery steps scheduled");
  });

  it("names steps in Recova's words with the result chip beside the name and the time on the right", async () => {
    seedPayment();
    seedStep({ id: "s1", stepType: "email_day1", stepNumber: 1, executedAt: new Date(NOW - 3 * DAY), result: "email_sent", aiSubject: "Your card" });
    seedStep({ id: "s2", stepType: "retry_day2", stepNumber: 2, executedAt: new Date(NOW - DAY), result: "retry_card_declined" });
    seedStep({ id: "s3", stepType: "email_day3", stepNumber: 3, scheduledAt: new Date(NOW + 26 * HOUR) });
    const t = text(render(await load()));
    expect(t).toContain("Day 1 email Email sent 3d ago");
    expect(t).toContain('"Your card" Executed Oct 13, 2026');
    // Recova's "Day 2 retry" (getStepLabel), true here because the soft
    // retry_day2 runs at 48 hours (job_3176bb519f89).
    expect(t).toContain("Day 2 retry Card declined 1d ago");
    expect(t).toContain("Day 3 email Pending in 1d Scheduled Oct 17, 2026");
    expect(t).not.toMatch(/\b1\. /);
  });

  it("orders the timeline by scheduled time, so a resend sits last as in Recova", async () => {
    seedPayment();
    seedStep({ id: "s1", stepType: "email_day1", stepNumber: 1, scheduledAt: new Date(NOW - 3 * DAY), executedAt: new Date(NOW - 3 * DAY), result: "email_sent", aiSubject: "A", aiBodyHtml: "<p>A</p>" });
    seedStep({ id: "s9", stepType: "email_resend", stepNumber: null, scheduledAt: new Date(NOW - HOUR), executedAt: new Date(NOW - HOUR), result: "email_sent", aiSubject: "A", aiBodyHtml: "<p>A</p>" });
    const data = await load();
    expect(data.steps.map((s) => s.id)).toEqual(["s1", "s9"]);
  });

  it("says Payment recovered for a retry that paid", async () => {
    seedPayment();
    seedStep({ id: "s1", stepType: "retry_day2", executedAt: new Date(NOW - HOUR), result: "retry_succeeded" });
    expect(text(render(await load()))).toContain("Payment recovered");
  });
});

// ---- Notes ----

describe("J76: Recova's internal notes", () => {
  it("is hidden in the demo, as Recova hides it", async () => {
    seedPayment();
    expect(text(render(await load(), { isDemo: true }))).not.toContain("Internal notes");
    expect(text(render(await load()))).toContain("Internal notes");
  });

  it("saves in place with Recova's words beside the button", () => {
    expect(SOURCE).toContain("useFetcher");
    expect(SOURCE).toContain('"Saving..."');
    expect(SOURCE).toContain("Could not save note. Please try again.");
    expect(SOURCE).toContain("Saved");
  });

  it("uses Capsomer's input and a primary Save note button", async () => {
    seedPayment();
    const html = render(await load());
    expect(html).toMatch(/<textarea[^>]*class="cap-input"/);
    expect(html).toMatch(/<button type="submit" class="cap-btn" data-variant="primary"[^>]*>Save note<\/button>/);
  });
});

// ---- Success banner ----

describe("J76: Recova's recovery success banner", () => {
  it("says Recova's sentence on a Capsomer ok banner", async () => {
    seedPayment({ status: "recovered", resolvedAt: new Date(NOW - 2 * DAY) });
    runStatement(
      sqlite,
      db.insert(recoveredPayments).values({
        id: "rp_1",
        accountId: A,
        failedPaymentId: "fp_1",
        recoveredAt: new Date(NOW - 2 * DAY),
        amountCents: 4999,
        currency: "usd",
        recoveryMethod: "manual",
        attributionKind: "manual",
      }),
    );
    const html = render(await load());
    expect(html).toMatch(/<div class="cap-banner" data-tone="ok" role="status">[\s\S]*Payment recovered/);
    expect(text(html)).toContain("$49.99 recovered via manually marked · 2d ago");
  });
});

// ---- Loader scope ----

describe("J76: the loader", () => {
  it("never shows another account's payment", async () => {
    seedPayment({ accountId: B });
    await expect(load("fp_1", A)).rejects.toMatchObject({ status: 404 });
  });

  it("names the next step for the trigger button from the same selector the server gates on", async () => {
    seedPayment();
    seedStep({ id: "s2", stepType: "email_day3", stepNumber: 2, scheduledAt: new Date(NOW + DAY) });
    expect((await load()).nextStepLabel).toBe("Day 3 email");
  });
});

// ---- The dispatcher's failure lines ----

describe("J76: the dispatcher logs the whole error on every failure line", () => {
  const manual = () => import("~/lib/recovery/manual-actions.server");
  const throwingCommit = (err: Error) => async () => {
    throw err;
  };
  const noTrigger = { loadStep: async () => null, runRetry: async () => {}, runEmail: async () => ({ suppressed: false }) };

  it("logs a failed note save and still answers write_failed", async () => {
    seedPayment();
    const err = new Error("note write broke");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { dispatchManualAction } = await manual();
    const out = await dispatchManualAction({
      db,
      accountId: A,
      failedPaymentId: "fp_1",
      intent: "note",
      note: "x",
      commit: throwingCommit(err),
      trigger: noTrigger as never,
      resend: { send: async () => ({ status: "sent", providerMessageId: "m" }) } as never,
    });
    expect(out).toEqual({ ok: false, reason: "write_failed", intent: "note" });
    expect(spy).toHaveBeenCalledWith(expect.any(String), err);
  });

  it("logs a failed stop and a failed mark as recovered", async () => {
    seedPayment();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { dispatchManualAction } = await manual();
    for (const intent of ["cancel", "mark_recovered"]) {
      const err = new Error(`${intent} broke`);
      await dispatchManualAction({
        db,
        accountId: A,
        failedPaymentId: "fp_1",
        intent,
        commit: throwingCommit(err),
        trigger: noTrigger as never,
        resend: { send: async () => ({ status: "sent", providerMessageId: "m" }) } as never,
      });
      expect(spy).toHaveBeenCalledWith(expect.any(String), err);
    }
  });

  it("logs a resend whose send throws, and one whose timeline row fails", async () => {
    seedPayment();
    seedStep({ id: "s1", executedAt: new Date(NOW - DAY), result: "email_sent", aiSubject: "S", aiBodyHtml: "<p>B</p>" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { dispatchManualAction } = await manual();
    const sendErr = new Error("send threw");
    const a = await dispatchManualAction({
      db,
      accountId: A,
      failedPaymentId: "fp_1",
      intent: "resend",
      commit: async () => ({ applied: true }),
      trigger: noTrigger as never,
      resend: {
        send: async () => {
          throw sendErr;
        },
      } as never,
    });
    expect(a).toEqual({ ok: false, reason: "resend_failed", detail: null });
    expect(spy).toHaveBeenCalledWith(expect.any(String), sendErr);
    const rowErr = new Error("row threw");
    const b = await dispatchManualAction({
      db,
      accountId: A,
      failedPaymentId: "fp_1",
      intent: "resend",
      commit: throwingCommit(rowErr),
      trigger: noTrigger as never,
      resend: { send: async () => ({ status: "sent", providerMessageId: "m" }) } as never,
    });
    expect(b).toEqual({ ok: false, reason: "resend_logged_failed" });
    expect(spy).toHaveBeenCalledWith(expect.any(String), rowErr);
  });

  it("logs a trigger whose executor throws", async () => {
    seedPayment();
    seedStep({ id: "s1", stepType: "email_day1" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { dispatchManualAction } = await manual();
    const err = new Error("executor threw");
    const out = await dispatchManualAction({
      db,
      accountId: A,
      failedPaymentId: "fp_1",
      intent: "trigger",
      commit: async () => ({ applied: true }),
      trigger: {
        loadStep: async () => ({}) as never,
        runRetry: async () => {},
        runEmail: async () => {
          throw err;
        },
      } as never,
      resend: { send: async () => ({ status: "sent", providerMessageId: "m" }) } as never,
    });
    expect(out).toEqual({ ok: false, reason: "step_failed", result: null });
    expect(spy).toHaveBeenCalledWith(expect.any(String), err);
  });
});

// ---- Measured on the rendered page (local demo account, both themes) ----

describe("J76: what the browser measurement found", () => {
  it("keeps the Outcome card's text off the tertiary grey, which measured 4.38:1 on its teal tint in dark", async () => {
    seedPayment();
    const html = render(await load());
    const outcome = html.slice(html.indexOf(">Outcome</h2>") - 200, html.indexOf("Recovery timeline"));
    expect(outcome).toContain("Still in recovery, no outcome yet.");
    expect(outcome).not.toContain("text-text-tertiary");
  });

  it("gives the back link a 24px target", async () => {
    seedPayment();
    expect(render(await load())).toMatch(/<a [^>]*class="[^"]*min-h-6[^"]*"[^>]*>← Back to dashboard<\/a>/);
  });
});
