import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Outlet, createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "~/db";
import { accounts, failedPayments, recoverySteps } from "~/db/schema";
import { estimateCustomerLtvCents, getFailedPaymentDetail } from "~/lib/recovery/queries.server";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// /recovery/payments/:id on Foxhound's engine.

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
const Page = route.default as unknown as (
  props: Record<string, unknown>,
) => ReturnType<typeof createElement>;

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
        return {
          env: {} as Env,
          ctx: { waitUntil() {} } as unknown as ExecutionContext,
        };
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

function render(
  loaderData: LoaderData,
  opts: { actionData?: unknown; isDemo?: boolean } = {},
): string {
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

describe("the action row", () => {
  it("names the next step on the trigger button, from the engine's schedule", async () => {
    seedPayment();
    seedStep({
      id: "s1",
      stepType: "email_day1",
      stepNumber: 1,
      executedAt: new Date(NOW - 2 * DAY),
      result: "email_sent",
    });
    seedStep({ id: "s2", stepType: "email_day3", stepNumber: 2, scheduledAt: new Date(NOW + DAY) });
    expect(render(await load())).toContain("Trigger Day 3 email now");
  });
});

describe("the action result", () => {
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
      request: new Request("https://x.test/", {
        method: "POST",
        body: new URLSearchParams({ intent: "resend" }),
      }),
    } as never)) as { data: { error?: string }; init: { status: number } };
    expect(res.init.status).toBe(500);
    expect(res.data.error).toBe("Email resent failed");
    expect(spy).toHaveBeenCalledWith(expect.any(String), boom);
  });
});

describe("the dispatcher logs the whole error on a failed resend", () => {
  const manual = () => import("~/lib/recovery/manual-actions.server");
  const throwingCommit = (err: Error) => async () => {
    throw err;
  };
  const noTrigger = {
    loadStep: async () => null,
    runRetry: async () => {},
    runEmail: async () => ({ suppressed: false }),
  };

  it("reports a resend whose send throws, and one whose timeline row fails", async () => {
    seedPayment();
    seedStep({
      id: "s1",
      executedAt: new Date(NOW - DAY),
      result: "email_sent",
      aiSubject: "S",
      aiBodyHtml: "<p>B</p>",
    });
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
});

// failed_payments.customer_ltv_cents holds a different value and must never be
// shown as the estimated LTV: it is computed fresh from recovered payments.
describe("estimateCustomerLtvCents", () => {
  it("averages and multiplies by twelve, and is null below two payments", () => {
    expect(estimateCustomerLtvCents([1000, 2000])).toBe(18000);
    expect(estimateCustomerLtvCents([1000, 2000, 3000])).toBe(24000);
    expect(estimateCustomerLtvCents([])).toBeNull();
    expect(estimateCustomerLtvCents([5000])).toBeNull();
  });
});

describe("previous failures", () => {
  it("stay account-scoped: the same Stripe customer id on another account never appears", async () => {
    const payment = (id: string, accountId: string, day: number) => ({
      id,
      accountId,
      stripeEventId: `evt_${id}`,
      stripeInvoiceId: `in_${id}`,
      stripeCustomerId: "cus_shared",
      customerEmail: "x@example.com",
      amountCents: 4200,
      currency: "usd",
      declineCategory: "soft",
      status: "active",
      detectedAt: new Date(Date.UTC(2026, 9, day)),
    });
    runStatement(
      sqlite,
      db
        .insert(failedPayments)
        .values([payment("fp_now", A, 10), payment("fp_before", A, 5), payment("fp_other", B, 8)]),
    );
    const detail = await getFailedPaymentDetail(db, A, "fp_now");
    expect(detail?.previousFailures.map((p) => p.id)).toEqual(["fp_before"]);
  });
});
