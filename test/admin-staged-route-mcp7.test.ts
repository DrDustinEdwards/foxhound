import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { adminContext } from "~/lib/admin/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import routes from "~/routes";

import { createInMemoryDb } from "./helpers/inmemory-db";

// /admin/staged: where a person confirms what the Admin API staged
// (job_21de68b30fc2 PR 1), and the two pieces of wiring around the API:
// the worker mounts it, and the seat has a way to issue its key.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { action, loader } = await import("~/routes/admin/staged");
const schema = await import("~/db/schema");
const { stageChange } = await import("~/lib/admin/staged.server");

const ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, ROOT)), "utf8");

const CONFIRMER = "dustin@foxhound.test";
const REQUESTER = "agent-acting-for@foxhound.test";
const NOW = new Date();

const fakeContext = {
  get(key: unknown) {
    if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
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
  await db.insert(schema.accounts).values({ id: "acct_a", name: "A", createdAt: NOW, processingPaused: true });
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
  action({ context: fakeContext, request: post(fields), params: {} } as never) as unknown as Promise<{
    data: { ok: boolean; error?: string };
  }>;

describe("/admin/staged", () => {
  it("lists the pending change with its summary and who asked", async () => {
    await seedPausedMerchant();
    const data = (await loader({ context: fakeContext, request: new Request("http://localhost/admin/staged"), params: {} } as never)) as {
      pending: { summary: string; requestedBy: string }[];
    };
    expect(data.pending.map((p) => [p.summary, p.requestedBy])).toEqual([["Resume processing for acct_a", REQUESTER]]);
  });

  it("confirm applies it under the SIGNED-IN admin, not the requester", async () => {
    const { db, id } = await seedPausedMerchant();
    const result = await run({ intent: "confirm", id, confirm: "" });
    expect(result.data.ok).toBe(true);
    const [account] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, "acct_a"));
    expect(account.processingPaused).toBe(false);
    const [row] = await db.select().from(schema.stagedChanges).where(eq(schema.stagedChanges.id, id));
    expect([row.status, row.decidedBy]).toEqual(["confirmed", CONFIRMER]);
  });

  it("reject leaves the merchant paused", async () => {
    const { db, id } = await seedPausedMerchant();
    const result = await run({ intent: "reject", id });
    expect(result.data.ok).toBe(true);
    const [account] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, "acct_a"));
    expect(account.processingPaused).toBe(true);
  });

  it("an unknown intent changes nothing", async () => {
    const { db, id } = await seedPausedMerchant();
    const result = await run({ intent: "apply-everything", id });
    expect(result.data.ok).toBe(false);
    const [row] = await db.select().from(schema.stagedChanges).where(eq(schema.stagedChanges.id, id));
    expect(row.status).toBe("pending");
  });

  it("sits inside the admin shell's Access gate", () => {
    const flat = JSON.stringify(routes);
    const guardAt = flat.indexOf("./layouts/admin-shell.tsx");
    expect(guardAt).toBeGreaterThan(-1);
    expect(flat.indexOf("./routes/admin/staged.tsx")).toBeGreaterThan(guardAt);
  });
});

describe("the wiring around the API", () => {
  it("the admin API is served only on the AdminApi entrypoint, never the public fetch (FH-20)", () => {
    // workers/ imports cloudflare:workers, which does not load in node, so this
    // guards the one security line by its source: the public handler must never
    // call the admin API again.
    expect(read("workers/app.ts")).not.toContain("handleAdminApiRequest");
    expect(read("workers/app.ts")).toContain('export { AdminApi } from "./admin-api"');
    expect(read("workers/admin-api.ts")).toContain("handleAdminApiRequest(request, this.env)");
  });

  it("scripts/issue-admin-api-key.mjs prints a key once and the SQL that stores only its hash", () => {
    const out = execFileSync("node", [fileURLToPath(new URL("scripts/issue-admin-api-key.mjs", ROOT))], {
      encoding: "utf8",
    });
    const token = /fox_mcp_[A-Za-z0-9_-]{40,}/.exec(out)?.[0];
    expect(token).toBeDefined();
    const hash = createHash("sha256").update(token!).digest("hex");
    expect(out).toContain(hash);
    expect(out).toContain("'mcp_admin'");
    // The plaintext appears once, and never inside the SQL.
    const sql = out.slice(out.indexOf("INSERT INTO"));
    expect(sql).not.toContain(token!);
    expect(out).not.toContain("--remote-confirm");
    expect(out).toContain("--remote");
  });
});
