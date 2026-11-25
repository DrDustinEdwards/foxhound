import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { adminContext } from "~/lib/admin/context";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";

import { createInMemoryDb } from "./helpers/inmemory-db";

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { action } = await import("~/routes/admin/staged");
const schema = await import("~/db/schema");
const { stageChange } = await import("~/lib/admin/staged.server");

const CONFIRMER = "dustin@foxhound.test";
const REQUESTER = "agent-acting-for@foxhound.test";
const NOW = new Date();

const fakeContext = {
  get(key: unknown) {
    if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext };
    if (key === adminContext) return { email: CONFIRMER };
    throw new Error("unexpected context key");
  },
} as unknown as Parameters<typeof action>[0]["context"];

function post(fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  return new Request("http://localhost/admin/staged", { method: "POST", body });
}

async function seedPausedMerchant() {
  const { db } = createInMemoryDb();
  harness.db = db;
  await db
    .insert(schema.accounts)
    .values({ id: "acct_a", name: "A", createdAt: NOW, processingPaused: true });
  const staged = await stageChange(db, {
    kind: "resume_account",
    accountId: "acct_a",
    requestedBy: REQUESTER,
    requestedVia: "admin-api",
    now: NOW,
  });
  if (!staged.ok) throw new Error(staged.error);
  return { db, id: staged.value.id };
}

const run = (fields: Record<string, string>) =>
  action({
    context: fakeContext,
    request: post(fields),
    params: {},
  } as never) as unknown as Promise<{
    data: { ok: boolean; error?: string };
  }>;

describe("/admin/staged", () => {
  it("confirm applies it under the SIGNED-IN admin, not the requester", async () => {
    const { db, id } = await seedPausedMerchant();
    const result = await run({ intent: "confirm", id, confirm: "" });
    expect(result.data.ok).toBe(true);
    const [account] = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, "acct_a"));
    expect(account.processingPaused).toBe(false);
    const [row] = await db
      .select()
      .from(schema.stagedChanges)
      .where(eq(schema.stagedChanges.id, id));
    expect([row.status, row.decidedBy]).toEqual(["confirmed", CONFIRMER]);
  });

  it("reject leaves the merchant paused", async () => {
    const { db, id } = await seedPausedMerchant();
    const result = await run({ intent: "reject", id });
    expect(result.data.ok).toBe(true);
    const [account] = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, "acct_a"));
    expect(account.processingPaused).toBe(true);
  });

  it("an unknown intent changes nothing", async () => {
    const { db, id } = await seedPausedMerchant();
    const result = await run({ intent: "apply-everything", id });
    expect(result.data.ok).toBe(false);
    const [row] = await db
      .select()
      .from(schema.stagedChanges)
      .where(eq(schema.stagedChanges.id, id));
    expect(row.status).toBe("pending");
  });
});
