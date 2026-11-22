import { describe, expect, it, vi } from "vitest";

import { accounts } from "~/db/schema";

import { createInMemoryDb } from "./helpers/inmemory-db";

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));
const { loader, action } = await import("~/routes/app/settings/audit");

const ACCOUNT = "acct_1";

function ctx() {
  return {
    get: (key: unknown) => {
      const name = String((key as { name?: string })?.name ?? "");
      if (name.includes("cloudflare")) return { env: {} as Env };
      return { membership: { accountId: ACCOUNT } };
    },
  } as never;
}

async function seedAccount(
  db: ReturnType<typeof createInMemoryDb>["db"],
  row: Record<string, unknown>,
) {
  await db.insert(accounts).values({ id: ACCOUNT, name: "Acme", createdAt: new Date(), ...row });
}

describe("audit settings", () => {
  function post(fields: Record<string, string>) {
    const body = new FormData();
    for (const [k, v] of Object.entries(fields)) body.append(k, v);
    return action({
      request: new Request("http://x/settings/audit", { method: "POST", body }),
      context: ctx(),
    } as never);
  }

  it("turning the digest on writes it and the loader reads it back", async () => {
    const { db } = createInMemoryDb();
    harness.db = db;
    await seedAccount(db, {});

    await post({ audit_lookback_days: "180", audit_auto_run: "true" });

    const rows = await db.select().from(accounts);
    expect(rows[0].auditAutoRun).toBe(true);
    expect(rows[0].auditLookbackDays).toBe(180);
    expect(await loader({ context: ctx() } as never)).toEqual({
      lookbackDays: 180,
      autoRun: true,
    });
  });
});
