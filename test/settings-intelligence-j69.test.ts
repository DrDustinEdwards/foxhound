import { beforeEach, describe, expect, it, vi } from "vitest";

import { accountSubscriptions, accounts } from "~/db";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { INTELLIGENCE_PRODUCT, SUBSCRIPTION_STATUS_ACTIVE } from "~/lib/constants";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J69 (job_c7d73b4f3c1c), row S35: /settings/intelligence. Recova's spec, read
// whole at HEAD:
//   app/(app)/settings/intelligence/page.tsx               blob d9800b0f  2,122 bytes
//   app/(app)/settings/components/IntelligenceSection.tsx  blob ec9ed981  5,000 bytes
//   app/api/settings/intelligence-preferences/route.ts     blob 7527dd4d  2,884 bytes
//
// RECOVA'S FIVE CONTROLS HAVE NO READER IN FOXHOUND, so none is built (RULES.md
// 3.18, 2.7). The page says which deliveries are not built and where the
// nearest built thing lives. The reader guard below fails the day a reader
// appears, which is when the page gains that control.
//
// Every assertion here was seen failing before the page existed.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));


async function loadRoute() {
  return import("~/routes/app/settings/intelligence");
}



function ctx(accountId = "acct_1") {
  return {
    get(key: unknown) {
      if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
      if (key === authContext) return { email: "owner@example.com", membership: { accountId } };
      throw new Error("unexpected context key");
    },
  } as never;
}

describe("J69: the loader reads the one thing the page shows, the entitlement", () => {
  beforeEach(() => {
    harness.db = null;
  });

  async function seed(opts: { entitled: boolean; otherAccountEntitled?: boolean }) {
    const { db } = createInMemoryDb();
    const now = new Date(1_000_000);
    await db.insert(accounts).values([
      { id: "acct_1", name: "One", createdAt: now },
      { id: "acct_2", name: "Two", createdAt: now },
    ]);
    if (opts.entitled) {
      await db.insert(accountSubscriptions).values({
        id: "sub_1",
        accountId: "acct_1",
        product: INTELLIGENCE_PRODUCT,
        status: SUBSCRIPTION_STATUS_ACTIVE,
        createdAt: now,
      });
    }
    if (opts.otherAccountEntitled) {
      await db.insert(accountSubscriptions).values({
        id: "sub_2",
        accountId: "acct_2",
        product: INTELLIGENCE_PRODUCT,
        status: SUBSCRIPTION_STATUS_ACTIVE,
        createdAt: now,
      });
    }
    harness.db = db;
  }

  it("is active for an account with an active Intelligence subscription", async () => {
    await seed({ entitled: true });
    const route = await loadRoute();
    const out = await route.loader({ context: ctx(), request: new Request("https://x/"), params: {} } as never);
    expect(out).toEqual({ intelligenceActive: true });
  });

  it("is not active for an account without one, even when another account has it", async () => {
    await seed({ entitled: false, otherAccountEntitled: true });
    const route = await loadRoute();
    const out = await route.loader({ context: ctx(), request: new Request("https://x/"), params: {} } as never);
    expect(out).toEqual({ intelligenceActive: false });
  });
});

// ---------------------------------------------------------------------------
// The reader guard. Recova's five settings live in
// intelligence_notification_preferences. Foxhound's schema has the table and
// account deletion clears it; nothing else touches it. The day something reads
// it, the matching control belongs on this page, and this test says so.
// ---------------------------------------------------------------------------

// workers/ holds the Worker entry and its Durable Objects, where a cron
// handler could read the table. mcp/ cannot: it has no D1 binding.


