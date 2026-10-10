import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { accounts, accountSubscriptions, adminAuditLog, apiKeys, cronConfig, stripeConnections } from "~/db/schema";
import { MCP_TOKEN_PREFIX, MCP_TOKEN_SCOPE } from "~/lib/auth/mcp-tokens";

import { createInMemoryDb } from "./helpers/inmemory-db";

// JOB job_21de68b30fc2, PR 1: THE FOXHOUND ADMIN API (MCP ruling 2026-10-10,
// rule 9 amendment and DECIDE answer 4).
//
// The Foxhound Admin MCP will run as its own Worker holding no Stripe key, no
// money binding and no database. Everything it does goes through this API, so
// this API is where the rules live:
//
//   1. TWO CREDENTIALS ON EVERY CALL. An admin-scope key (the MCP Worker's) AND
//      the acting admin's email, which is re-checked against ADMIN_EMAIL on
//      every call. A key alone does not make anybody an admin.
//   2. READS, PAUSE AND STAGING ONLY. Pausing stops money moving, so it is a
//      direct write. Resuming, re-enabling a cron, billing exemption and a plan
//      grant start or change money, so they are STAGED: a pending row with an
//      audit entry, applied only when an admin confirms it in /admin/staged.
//      Refunds, adjustments, cancel and Stripe disconnect are not offered at all.
//   3. EVERY CALL IS LOGGED in an append-only table, and every write and every
//      staging leaves an admin_audit_log row naming the acting admin.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { handleAdminApiRequest } = await import("~/lib/admin-api/handler.server");
const { hashMcpToken } = await import("~/lib/auth/mcp-tokens");
const { confirmStagedChange, rejectStagedChange } = await import("~/lib/admin/staged.server");

const ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, ROOT)), "utf8");
const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

const ORIGIN = "https://foxhoundapp.test";
const ADMIN = "dustin@foxhound.test";
const NOT_ADMIN = "intruder@foxhound.test";
const NOW = new Date("2026-10-10T12:00:00.000Z");
const MERCHANT = "acct_alpha";
const OTHER = "acct_beta";
const ACCESS_TOKEN = "enc_ACCESS_TOKEN_quokka";
const WEBHOOK = "https://hooks.slack.com/services/T0ADM/B0ADM/adminWombatSecret";

function env(): Env {
  return {
    DB: {
      prepare: () => ({
        run: async () => ({ meta: { size_after: 4096 } }),
        all: async () => ({ results: [] }),
      }),
    },
    ADMIN_EMAIL: `${ADMIN}, second@foxhound.test`,
    RATE_LIMITER: {
      idFromName: (n: string) => n,
      get: () => ({ check: async () => ({ allowed: true, retryAfterSec: 60 }) }),
    },
  } as unknown as Env;
}

async function seed() {
  const { db, sqlite } = createInMemoryDb();
  harness.db = db;
  for (const id of [MERCHANT, OTHER]) {
    await db.insert(accounts).values({
      id,
      name: `Merchant ${id}`,
      createdAt: NOW,
      currency: "usd",
      slackWebhookUrl: WEBHOOK,
    });
    await db.insert(stripeConnections).values({
      id: `sc_${id}`,
      accountId: id,
      stripeUserId: `acct_stripe_${id}`,
      stripeAccessToken: ACCESS_TOKEN,
      isPrimary: true,
      connectedAt: NOW,
      createdAt: NOW,
    });
  }
  const mint = async (token: string, scope: string, accountId: string | null, revoked = false) =>
    db.insert(apiKeys).values({
      id: `key_${token}`,
      accountId,
      keyHash: await hashMcpToken(token),
      label: "test",
      scope,
      createdAt: NOW,
      revokedAt: revoked ? NOW : null,
    });
  const admin = `${MCP_TOKEN_PREFIX}admin`;
  const merchant = `${MCP_TOKEN_PREFIX}merchant`;
  const revoked = `${MCP_TOKEN_PREFIX}revoked`;
  await mint(admin, MCP_TOKEN_SCOPE.ADMIN, null);
  await mint(merchant, MCP_TOKEN_SCOPE.MERCHANT, MERCHANT);
  await mint(revoked, MCP_TOKEN_SCOPE.ADMIN, null, true);
  return { db, sqlite, keys: { admin, merchant, revoked } };
}

async function api(
  path: string,
  opts: { key?: string | null; actor?: string | null; method?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
  if (opts.actor) headers["Foxhound-Acting-Admin"] = opts.actor;
  const res = (await handleAdminApiRequest(
    new Request(`${ORIGIN}/api/admin/v1${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
    env(),
  )) as Response;
  const text = await res.text();
  return { status: res.status, text, json: (text ? JSON.parse(text) : null) as Record<string, unknown> };
}

const asAdmin = (key: string) => ({ key, actor: ADMIN });

// ============================================================================

describe("PLANT 1: two credentials on every call", () => {
  it("only claims /api/admin/v1", async () => {
    expect(await handleAdminApiRequest(new Request(`${ORIGIN}/api/carrel/v1/x`), env())).toBeNull();
    expect(await handleAdminApiRequest(new Request(`${ORIGIN}/admin`), env())).toBeNull();
  });

  it("no key, a merchant key and a revoked key are one identical 401", async () => {
    const { keys } = await seed();
    const bodies = new Set<string>();
    for (const key of [null, "not-a-key", keys.merchant, keys.revoked]) {
      const { status, text } = await api("/platform", { key, actor: ADMIN });
      expect(status, String(key)).toBe(401);
      bodies.add(text);
    }
    expect(bodies.size).toBe(1);
  });

  it("a good key with no acting admin, or one who is not on ADMIN_EMAIL, is 403", async () => {
    const { keys } = await seed();
    for (const actor of [null, NOT_ADMIN, ""]) {
      const { status, json } = await api("/platform", { key: keys.admin, actor });
      expect(status, String(actor)).toBe(403);
      expect(String(json.error)).toMatch(/acting admin/i);
    }
  });

  it("and the acting admin is matched case-insensitively, as the /admin guard does", async () => {
    const { keys } = await seed();
    const { status } = await api("/platform", { key: keys.admin, actor: ADMIN.toUpperCase() });
    expect(status).toBe(200);
  });
});

describe("PLANT 2: the reads", () => {
  it("platform, merchants, health, whats-next and the audit log answer 200 with data", async () => {
    const { keys } = await seed();
    for (const path of ["/platform", "/merchants", "/health", "/whats-next", "/audit-log", "/staged"]) {
      const { status, json } = await api(path, asAdmin(keys.admin));
      expect(status, path).toBe(200);
      expect(json.ok, path).toBe(true);
    }
  });

  it("GET /me names the acting admin, so the MCP can ask at sign-in whether someone is an admin", async () => {
    const { keys } = await seed();
    const { status, json } = await api("/me", asAdmin(keys.admin));
    expect(status).toBe(200);
    expect(json.data).toEqual({ actor: ADMIN });
    expect((await api("/me", { key: keys.admin, actor: NOT_ADMIN })).status).toBe(403);
  });

  it("merchant search finds by name or id, and pages with a cursor", async () => {
    const { keys } = await seed();
    const { json } = await api("/merchants?query=beta", asAdmin(keys.admin));
    const data = json.data as { merchants: { id: string }[]; has_more: boolean; next_cursor: string | null };
    expect(data.merchants.map((m) => m.id)).toEqual([OTHER]);
    expect(data.has_more).toBe(false);
    expect(data.next_cursor).toBeNull();
  });

  it("one merchant's detail never carries a Stripe access token or the Slack webhook URL", async () => {
    const { keys } = await seed();
    const { status, text } = await api(`/merchants/${MERCHANT}`, asAdmin(keys.admin));
    expect(status).toBe(200);
    expect(text).toContain(MERCHANT);
    expect(text).not.toContain(ACCESS_TOKEN);
    expect(text).not.toContain("stripeAccessToken");
    expect(text).not.toContain("adminWombatSecret");
  });

  it("an unknown merchant is a 404 that says how to find one", async () => {
    const { keys } = await seed();
    const { status, json } = await api("/merchants/acct_nope", asAdmin(keys.admin));
    expect(status).toBe(404);
    expect(String(json.error)).toMatch(/merchants/);
  });
});

describe("PLANT 3: pause is a direct write, audited under the acting admin", () => {
  it("pausing one merchant stops processing now and records who did it", async () => {
    const { db, keys } = await seed();
    const { status } = await api("/pause", { ...asAdmin(keys.admin), method: "POST", body: { account_id: MERCHANT } });
    expect(status).toBe(200);
    const [row] = await db.select().from(accounts).where(eq(accounts.id, MERCHANT));
    expect(row.processingPaused).toBe(true);
    const [other] = await db.select().from(accounts).where(eq(accounts.id, OTHER));
    expect(other.processingPaused).toBe(false);
    const audit = await db.select().from(adminAuditLog);
    expect(audit.map((a) => [a.actorEmail, a.action])).toContainEqual([ADMIN, "merchant.processing.pause"]);
  });

  it("pausing all engages the brake", async () => {
    const { db, keys } = await seed();
    const { status } = await api("/pause", { ...asAdmin(keys.admin), method: "POST", body: { all: true } });
    expect(status).toBe(200);
    const rows = await db.select().from(accounts);
    expect(rows.every((r) => r.processingPaused)).toBe(true);
  });

  it("a pause naming nothing, or an unknown merchant, changes nothing and says why", async () => {
    const { db, keys } = await seed();
    for (const body of [{}, { account_id: "acct_nope" }]) {
      const { status, json } = await api("/pause", { ...asAdmin(keys.admin), method: "POST", body });
      expect(status, JSON.stringify(body)).toBe(400);
      expect(String(json.error).length).toBeGreaterThan(10);
    }
    expect((await db.select().from(accounts)).some((r) => r.processingPaused)).toBe(false);
  });
});

describe("PLANT 4: money starts only after a human confirms in /admin", () => {
  it("staging a resume leaves the merchant paused and writes a pending row plus an audit entry", async () => {
    const { db, keys } = await seed();
    await db.update(accounts).set({ processingPaused: true, pauseReason: "manual" }).where(eq(accounts.id, MERCHANT));
    const { status, json } = await api("/staged", {
      ...asAdmin(keys.admin),
      method: "POST",
      body: { kind: "resume_account", account_id: MERCHANT },
    });
    expect(status).toBe(200);
    const staged = (json.data as { staged: { id: string; status: string } }).staged;
    expect(staged.status).toBe("pending");
    const [row] = await db.select().from(accounts).where(eq(accounts.id, MERCHANT));
    expect(row.processingPaused).toBe(true);
    const audit = await db.select().from(adminAuditLog);
    expect(audit.map((a) => [a.actorEmail, a.action])).toContainEqual([ADMIN, "staged.create"]);

    // Confirmed by a person in /admin: now, and only now, the merchant resumes.
    const result = await confirmStagedChange(db, { id: staged.id, actorEmail: "second@foxhound.test", confirmPhrase: "", now: NOW });
    expect(result.ok).toBe(true);
    const [after] = await db.select().from(accounts).where(eq(accounts.id, MERCHANT));
    expect(after.processingPaused).toBe(false);
    const actions = (await db.select().from(adminAuditLog)).map((a) => [a.actorEmail, a.action]);
    expect(actions).toContainEqual(["second@foxhound.test", "staged.confirm"]);

    // A confirmed change cannot be applied twice.
    const again = await confirmStagedChange(db, { id: staged.id, actorEmail: ADMIN, confirmPhrase: "", now: NOW });
    expect(again.ok).toBe(false);
  });

  it("billing exemption and an Intelligence grant are staged, then applied on confirm", async () => {
    const { db, keys } = await seed();
    const exempt = await api("/staged", {
      ...asAdmin(keys.admin),
      method: "POST",
      body: { kind: "billing_exempt", account_id: MERCHANT, exempt: true },
    });
    const grant = await api("/staged", {
      ...asAdmin(keys.admin),
      method: "POST",
      body: { kind: "intelligence_grant", account_id: MERCHANT },
    });
    expect([exempt.status, grant.status]).toEqual([200, 200]);
    let [row] = await db.select().from(accounts).where(eq(accounts.id, MERCHANT));
    expect(row.billingExempt).toBe(false);
    expect(await db.select().from(accountSubscriptions)).toEqual([]);
    for (const staged of [exempt, grant]) {
      const id = (staged.json.data as { staged: { id: string } }).staged.id;
      expect((await confirmStagedChange(db, { id, actorEmail: ADMIN, confirmPhrase: "", now: NOW })).ok).toBe(true);
    }
    [row] = await db.select().from(accounts).where(eq(accounts.id, MERCHANT));
    expect(row.billingExempt).toBe(true);
    expect((await db.select().from(accountSubscriptions)).map((s) => s.adminGranted)).toEqual([true]);
  });

  it("a staged cron enable needs the same typed phrase /admin/crons asks for", async () => {
    const { db, keys } = await seed();
    await db.insert(cronConfig).values({ cronName: "recovery-tick", enabled: false, updatedAt: NOW });
    const staged = await api("/staged", {
      ...asAdmin(keys.admin),
      method: "POST",
      body: { kind: "cron_enable", cron_name: "recovery-tick" },
    });
    const id = (staged.json.data as { staged: { id: string } }).staged.id;
    const wrong = await confirmStagedChange(db, { id, actorEmail: ADMIN, confirmPhrase: "yes", now: NOW });
    expect(wrong.ok).toBe(false);
    const [still] = await db.select().from(cronConfig).where(eq(cronConfig.cronName, "recovery-tick"));
    expect(still.enabled).toBe(false);
    const right = await confirmStagedChange(db, { id, actorEmail: ADMIN, confirmPhrase: "ENABLE recovery-tick", now: NOW });
    expect(right.ok).toBe(true);
    const [now] = await db.select().from(cronConfig).where(eq(cronConfig.cronName, "recovery-tick"));
    expect(now.enabled).toBe(true);
  });

  it("a rejected change is never applied, and an expired one cannot be confirmed", async () => {
    const { db, keys } = await seed();
    await db.update(accounts).set({ processingPaused: true }).where(eq(accounts.id, MERCHANT));
    const stage = async () =>
      (
        (await api("/staged", {
          ...asAdmin(keys.admin),
          method: "POST",
          body: { kind: "resume_account", account_id: MERCHANT },
        })).json.data as { staged: { id: string } }
      ).staged.id;
    const rejected = await stage();
    expect((await rejectStagedChange(db, { id: rejected, actorEmail: ADMIN, now: NOW })).ok).toBe(true);
    expect((await confirmStagedChange(db, { id: rejected, actorEmail: ADMIN, confirmPhrase: "", now: NOW })).ok).toBe(false);
    const stale = await stage();
    const later = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect((await confirmStagedChange(db, { id: stale, actorEmail: ADMIN, confirmPhrase: "", now: later })).ok).toBe(false);
    const [row] = await db.select().from(accounts).where(eq(accounts.id, MERCHANT));
    expect(row.processingPaused).toBe(true);
  });

  it("an unknown kind, or a kind missing its target, is refused and stages nothing", async () => {
    const { sqlite, keys } = await seed();
    for (const body of [
      { kind: "refund", account_id: MERCHANT },
      { kind: "resume_account" },
      { kind: "cron_enable", cron_name: "not-a-cron" },
      { kind: "billing_exempt", account_id: MERCHANT },
    ]) {
      const { status } = await api("/staged", { ...asAdmin(keys.admin), method: "POST", body });
      expect(status, JSON.stringify(body)).toBe(400);
    }
    expect(sqlite.prepare("SELECT count(*) AS n FROM staged_changes").get()).toEqual({ n: 0 });
  });
});

describe("PLANT 5: no money path exists on the API", () => {
  it("refund, adjustment, cancel and disconnect paths are 404 with no write", async () => {
    const { db, keys } = await seed();
    for (const path of [
      `/merchants/${MERCHANT}/refund`,
      `/merchants/${MERCHANT}/adjustment`,
      `/merchants/${MERCHANT}/cancel`,
      `/merchants/${MERCHANT}/disconnect`,
      "/refund",
    ]) {
      const { status } = await api(path, { ...asAdmin(keys.admin), method: "POST", body: {} });
      expect(status, path).toBe(404);
    }
    const [row] = await db.select().from(accounts).where(eq(accounts.id, MERCHANT));
    expect(row.cancelledAt).toBeNull();
  });

  it("the API and the staging module import no money writer, cancel or disconnect", () => {
    for (const path of ["app/lib/admin-api/handler.server.ts", "app/lib/admin/staged.server.ts"]) {
      const body = code(read(path));
      for (const forbidden of [
        "cancelMerchant",
        "disconnectConnection",
        "createAdjustment",
        "executeMoneyWrite",
        "recordOutcome",
        "deauthorize",
        "refund",
      ]) {
        expect(body, `${path} names ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe("PLANT 6: every call is logged, append-only", () => {
  it("a read and a write each leave one row naming the acting admin and the key", async () => {
    const { sqlite, keys } = await seed();
    await api("/platform", asAdmin(keys.admin));
    await api("/pause", { ...asAdmin(keys.admin), method: "POST", body: { account_id: MERCHANT } });
    const rows = sqlite.prepare("SELECT * FROM admin_api_calls ORDER BY rowid").all() as {
      actor_email: string;
      api_key_id: string;
      method: string;
      path: string;
      status: number;
    }[];
    expect(rows.map((r) => [r.actor_email, r.method, r.path, r.status])).toEqual([
      [ADMIN, "GET", "/platform", 200],
      [ADMIN, "POST", "/pause", 200],
    ]);
    expect(rows[0].api_key_id).toBe(`key_${keys.admin}`);
    expect(() => sqlite.prepare("DELETE FROM admin_api_calls").run()).toThrow(/append-only/);
    expect(() => sqlite.prepare("UPDATE admin_api_calls SET path = 'x'").run()).toThrow(/append-only/);
  });
});
