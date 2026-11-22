import { beforeEach, describe, expect, it, vi } from "vitest";

import { accounts, failedPayments, recoverySteps } from "~/db/schema";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// /recovery/payments on Foxhound's engine: the loader and the CSV export.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const route = await import("~/routes/app/recovery/payments/index");
const exportRoute = await import("~/routes/app/recovery/payments/export");
const NOW = Date.parse("2026-10-16T12:00:00.000Z");
const DAY = 86_400_000;

type LoaderData = Awaited<ReturnType<typeof route.loader>>;

const A = "acct_alpha";
const B = "acct_beta";

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

async function load(path: string, accountId = A): Promise<LoaderData> {
  return (await route.loader({
    context: contextFor(accountId),
    request: new Request(`https://foxhoundapp.test${path}`),
    params: {},
  } as never)) as LoaderData;
}

let seq = 0;
function seed(
  sqlite: ReturnType<typeof createInMemoryDb>["sqlite"],
  db: ReturnType<typeof createInMemoryDb>["db"],
  over: Partial<typeof failedPayments.$inferInsert>,
): string {
  const id = `fp_${++seq}`;
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
      amountCents: 1000,
      currency: "usd",
      declineCategory: "soft",
      declineCode: "insufficient_funds",
      status: "active",
      detectedAt: new Date(NOW - DAY),
      ...over,
    }),
  );
  return id;
}

describe("recovery payments", () => {
  let sqlite: ReturnType<typeof createInMemoryDb>["sqlite"];
  let db: ReturnType<typeof createInMemoryDb>["db"];

  beforeEach(() => {
    ({ sqlite, db } = createInMemoryDb());
    harness.db = db;
    runStatement(sqlite, db.insert(accounts).values({ id: A, name: "Alpha" }));
    runStatement(sqlite, db.insert(accounts).values({ id: B, name: "Beta" }));
  });

  it("names the next step by Foxhound's schedule and counts done of total", async () => {
    const id = seed(sqlite, db, { declineCategory: "soft" });
    const steps = [
      {
        stepType: "retry_early",
        stepNumber: 1,
        executedAt: new Date(NOW - DAY),
        result: "retry_card_declined",
      },
      { stepType: "email_day1", stepNumber: 2, executedAt: null, result: null },
      { stepType: "retry_day2", stepNumber: 3, executedAt: null, result: null },
    ];
    steps.forEach((s, i) =>
      runStatement(
        sqlite,
        db.insert(recoverySteps).values({
          id: `st_${i}`,
          accountId: A,
          failedPaymentId: id,
          stepType: s.stepType,
          stepNumber: s.stepNumber,
          scheduledAt: new Date(NOW),
          executedAt: s.executedAt,
          result: s.result,
        } as typeof recoverySteps.$inferInsert),
      ),
    );
    const out = await load("/recovery/payments");
    expect(out.result.payments[0]!.steps).toEqual({ completed: 1, total: 3, next: "Day 1 email" });
  });

  it("counts a customer's other failures and flags a note, sending no raw note text", async () => {
    seed(sqlite, db, { stripeCustomerId: "cus_r", notes: "Called them" });
    seed(sqlite, db, { stripeCustomerId: "cus_r" });
    seed(sqlite, db, { stripeCustomerId: "cus_r" });
    const out = await load("/recovery/payments");
    const first = out.result.payments[0]!;
    expect(out.result.payments.map((p) => p.priorFailures)).toEqual([2, 2, 2]);
    expect(out.result.payments.some((p) => p.hasNote)).toBe(true);
    expect(JSON.stringify(first)).not.toContain("Called them");
    expect(first).not.toHaveProperty("stripeCustomerId");
  });

  async function exportRows(path: string, accountId = A): Promise<string[]> {
    const res = (await exportRoute.loader({
      context: contextFor(accountId),
      request: new Request(`https://foxhoundapp.test${path}`),
      params: {},
    } as never)) as Response;
    expect(res.status).toBe(200);
    return (await res.text()).trim().split("\r\n").slice(1);
  }

  it("exports the rows on screen, as Recova's Export CSV does, never every filtered row", async () => {
    for (let i = 0; i < 30; i++) seed(sqlite, db, { detectedAt: new Date(NOW - (i + 1) * 60_000) });
    expect(await exportRows("/recovery/payments/export.csv")).toHaveLength(25);
    expect(await exportRows("/recovery/payments/export.csv?perPage=10&page=3")).toHaveLength(10);
    expect(await exportRows("/recovery/payments/export.csv?page=2")).toHaveLength(5);
    expect(await exportRows("/recovery/payments/export.csv?perPage=all")).toHaveLength(30);
  });
});
