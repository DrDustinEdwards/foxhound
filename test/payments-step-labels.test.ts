import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "~/db";
import { accounts, failedPayments, recoverySteps } from "~/db/schema";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// The payment detail loader never carries a raw email body.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const route = await import("~/routes/app/recovery/payments/detail");

const A = "acct_alpha";
const NOW = Date.parse("2026-10-16T12:00:00.000Z");
const DAY = 86_400_000;

describe("the payment detail loader", () => {
  let sqlite: ReturnType<typeof createInMemoryDb>["sqlite"];
  let db: Db;

  beforeEach(() => {
    ({ sqlite, db } = createInMemoryDb());
    harness.db = db;
    runStatement(sqlite, db.insert(accounts).values({ id: A, name: "Alpha" }));
  });

  it("carries no raw email body, only the sanitized preview", async () => {
    runStatement(
      sqlite,
      db.insert(failedPayments).values({
        id: "fp_1",
        accountId: A,
        stripeEventId: "evt_1",
        stripeInvoiceId: "in_1",
        stripeCustomerId: "cus_1",
        customerEmail: "jordan@example.com",
        amountCents: 4999,
        currency: "usd",
        declineCategory: "soft",
        status: "active",
        detectedAt: new Date(NOW - 3 * DAY),
      }),
    );
    const raw = '<p onclick="steal()">Hi Jordan</p><script>alert("raw-body-marker")</script>';
    runStatement(
      sqlite,
      db.insert(recoverySteps).values({
        id: "s1",
        accountId: A,
        failedPaymentId: "fp_1",
        stepType: "email_day1",
        stepNumber: 1,
        scheduledAt: new Date(NOW - 2 * DAY),
        executedAt: new Date(NOW - 2 * DAY),
        result: "email_sent",
        aiSubject: "Your card",
        aiBodyHtml: raw,
        attemptCount: 1,
      }),
    );
    const data = await route.loader({
      context: {
        get(key: unknown) {
          if (key === cloudflareContext) return { env: {}, ctx: { waitUntil() {} } };
          if (key === authContext) return { membership: { accountId: A } };
          throw new Error("unexpected context key");
        },
      },
      request: new Request("https://foxhoundapp.test/recovery/payments/fp_1"),
      params: { id: "fp_1" },
    } as never);
    const step = data.steps.find((s) => s.id === "s1");
    expect(step?.previewHtml).toContain("Hi Jordan");
    expect(step).not.toHaveProperty("aiBodyHtml");
    const json = JSON.stringify(data);
    expect(json).not.toContain("raw-body-marker");
    expect(json).not.toContain("onclick");
    expect(json).not.toContain("<script");
  });
});
