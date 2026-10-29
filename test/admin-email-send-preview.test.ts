import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { accounts, adminAuditLog, apiKeys, failedPayments, stripeConnections } from "~/db/schema";
import { MCP_TOKEN_PREFIX, MCP_TOKEN_SCOPE } from "~/lib/auth/mcp-tokens";

import { SCOPE_READ, SCOPE_WRITE } from "../mcp/src/scopes";
import { serveAdminMcp } from "../mcp/src/server";
import { ADMIN_TOOLS } from "../mcp/src/tools";

import { createInMemoryDb } from "./helpers/inmemory-db";
import { mcpRequest, readMcp, toolOutput } from "./helpers/mcp-client";

// THE OWNER-ONLY "SEND OR PREVIEW ANY EMAIL" CAPABILITY on the admin API.
//
// Dustin approved it on 2026-10-15 (cmsg_01Nd8kh3hkgYNYpWXrNkvBQLJoLik1xYvr9pCLcgZ3SSMJ)
// by answering "ok" to: "build #1 and #2 together as one owner-only 'send or
// preview any email' tool behind your admin key". #1 sends every email type to
// a test inbox after a deploy; #2 renders any email as a chosen merchant's
// customer would get it, without sending.
//
// What these plants hold it to:
//   1. The admin API's two credentials, as for every other route.
//   2. Mail goes only to the acting admin's own address or an address on the
//      ADMIN_EMAIL_TEST_RECIPIENTS list (RULES.md 4.7: a typed address would
//      make Foxhound an open mail relay).
//   3. A preview sends nothing.
//   4. Every type in the catalog renders.
//   5. A send goes through the one send module, with the merchant's sender
//      name and Reply-To.
//   6. Every send leaves an admin_audit_log row naming the acting admin.
//   7. No tracking link, card-update link, email_sends row, engagement row or
//      any other row a billing or a merchant count reads. No real customer
//      data is read into a message.

const sendSpies = vi.hoisted(() => ({
  sendEmail: null as unknown as ReturnType<typeof vi.fn>,
  sendTransactionalEmail: null as unknown as ReturnType<typeof vi.fn>,
  sendRenderedTransactionalEmail: null as unknown as ReturnType<typeof vi.fn>,
}));
vi.mock("~/lib/email/send", async (importOriginal) => {
  const real = await importOriginal<typeof import("~/lib/email/send")>();
  sendSpies.sendEmail = vi.fn(real.sendEmail);
  sendSpies.sendTransactionalEmail = vi.fn(real.sendTransactionalEmail);
  sendSpies.sendRenderedTransactionalEmail = vi.fn(real.sendRenderedTransactionalEmail);
  return {
    ...real,
    sendEmail: sendSpies.sendEmail,
    sendTransactionalEmail: sendSpies.sendTransactionalEmail,
    sendRenderedTransactionalEmail: sendSpies.sendRenderedTransactionalEmail,
  };
});

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { handleAdminApiRequest } = await import("~/lib/admin-api/handler.server");
const { hashMcpToken } = await import("~/lib/auth/mcp-tokens");

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
const SECOND_ADMIN = "second@foxhound.test";
const TEST_INBOX = "inbox@mailtest.test";
const STRANGER = "stranger@elsewhere.test";
const MERCHANT = "acct_alpha";
const SENDER_NAME = "Acme Billing";
const REPLY_TO = "help@acme.test";
const BRAND_VOICE = "Warm, brief, never pushy";
const REAL_CUSTOMER_EMAIL = "realperson@shopper.test";
const REAL_CUSTOMER_NAME = "Quentin Realname";
const NOW = new Date("2026-10-15T12:00:00.000Z");

const ALL_TYPES = [
  "recovery_day1",
  "recovery_day3",
  "recovery_day7",
  "recovery_day14",
  "recovery_day30",
  "recovery_revoked",
  "winback_step1",
  "winback_step2",
  "winback_step3",
  "expiring_card",
  "expiring_card_no_payment_method",
  "settings_test",
  "weekly_digest",
  "recovery_notification",
  "sequence_complete",
  "sign_in_link",
];
const CUSTOMER_TYPES = ALL_TYPES.slice(0, 12);

interface SentMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

let sent: SentMessage[] = [];

function env(overrides: Record<string, unknown> = {}): Env {
  return {
    DB: {
      prepare: () => ({
        run: async () => ({ meta: { size_after: 4096 } }),
        all: async () => ({ results: [] }),
      }),
    },
    ADMIN_EMAIL: `${ADMIN}, ${SECOND_ADMIN}`,
    ADMIN_EMAIL_TEST_RECIPIENTS: TEST_INBOX,
    BETTER_AUTH_URL: ORIGIN,
    PHYSICAL_ADDRESS: "1 Test Street, Austin, TX 78701",
    ENCRYPTION_KEY: "ab".repeat(32),
    EMAIL: {
      send: async (message: SentMessage) => {
        sent.push(message);
        return { id: `msg_${sent.length}` };
      },
    },
    RATE_LIMITER: {
      idFromName: (n: string) => n,
      get: () => ({ hit: async () => ({ ok: true, retryAfterSeconds: 60 }) }),
    },
    ...overrides,
  } as unknown as Env;
}

async function seed() {
  const { db, sqlite } = createInMemoryDb();
  harness.db = db;
  await db.insert(accounts).values({
    id: MERCHANT,
    name: "Acme",
    createdAt: NOW,
    currency: "usd",
    notificationEmail: "owner@acme.test",
  });
  await db.insert(stripeConnections).values({
    id: "sc_alpha",
    accountId: MERCHANT,
    stripeUserId: "acct_stripe_alpha",
    stripeAccessToken: "enc_token",
    isPrimary: true,
    connectedAt: NOW,
    createdAt: NOW,
    senderName: SENDER_NAME,
    replyToEmail: REPLY_TO,
    brandVoice: BRAND_VOICE,
  });
  // A real customer on that account. Nothing in a preview or a send may carry
  // this person's address or name.
  await db.insert(failedPayments).values({
    id: "fp_real",
    accountId: MERCHANT,
    stripeEventId: "evt_1",
    stripeInvoiceId: "in_1",
    stripeCustomerId: "cus_1",
    customerEmail: REAL_CUSTOMER_EMAIL,
    customerName: REAL_CUSTOMER_NAME,
    amountCents: 4900,
    currency: "usd",
    declineCategory: "soft",
    status: "active",
    detectedAt: NOW,
  });
  const admin = `${MCP_TOKEN_PREFIX}admin`;
  const merchantKey = `${MCP_TOKEN_PREFIX}merchant`;
  for (const [token, scope, accountId] of [
    [admin, MCP_TOKEN_SCOPE.ADMIN, null],
    [merchantKey, MCP_TOKEN_SCOPE.MERCHANT, MERCHANT],
  ] as const) {
    await db.insert(apiKeys).values({
      id: `key_${token}`,
      accountId,
      keyHash: await hashMcpToken(token),
      label: "test",
      scope,
      createdAt: NOW,
    });
  }
  return { db, sqlite, keys: { admin, merchant: merchantKey } };
}

async function api(
  path: string,
  opts: { key?: string | null; actor?: string | null; method?: string; body?: unknown; env?: Env } = {},
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
    opts.env ?? env(),
  )) as Response;
  const text = await res.text();
  return { status: res.status, text, json: (text ? JSON.parse(text) : null) as Record<string, unknown> };
}

const post = (key: string, path: string, body: unknown, extra: { actor?: string; env?: Env } = {}) =>
  api(path, { key, actor: extra.actor ?? ADMIN, method: "POST", body, env: extra.env });

/** Every table's row count, so a test can prove nothing else was written. */
function tableCounts(sqlite: ReturnType<typeof createInMemoryDb>["sqlite"]): Record<string, number> {
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'")
    .all() as { name: string }[];
  return Object.fromEntries(
    tables.map(({ name }) => [name, (sqlite.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n]),
  );
}

function withoutLogs(counts: Record<string, number>) {
  return Object.fromEntries(Object.entries(counts).filter(([name]) => name !== "admin_audit_log" && name !== "admin_api_calls"));
}

beforeEach(() => {
  sent = [];
  sendSpies.sendEmail?.mockClear();
  sendSpies.sendTransactionalEmail?.mockClear();
  sendSpies.sendRenderedTransactionalEmail?.mockClear();
});

// ============================================================================

describe("PLANT 1: the admin API's two credentials guard both routes", () => {
  it("no key, or a merchant key, is a 401 and nothing is sent", async () => {
    const { keys } = await seed();
    for (const key of [null, keys.merchant]) {
      for (const path of ["/emails", "/emails/preview", "/emails/send"]) {
        const { status } = await api(path, {
          key,
          actor: ADMIN,
          method: path === "/emails" ? "GET" : "POST",
          body: path === "/emails" ? undefined : { type: "recovery_day1" },
        });
        expect(status, `${String(key)} ${path}`).toBe(401);
      }
    }
    expect(sent).toEqual([]);
  });

  it("an acting person who is not on ADMIN_EMAIL is a 403 and nothing is sent", async () => {
    const { keys } = await seed();
    const { status } = await post(keys.admin, "/emails/send", { type: "recovery_day1" }, { actor: STRANGER });
    expect(status).toBe(403);
    expect(sent).toEqual([]);
  });
});

describe("PLANT 2: mail goes only to the caller or the configured test inboxes", () => {
  it("with no `to`, it goes to the acting admin's own address", async () => {
    const { keys } = await seed();
    const { status, json } = await post(keys.admin, "/emails/send", { types: ["sign_in_link"] });
    expect(status, JSON.stringify(json)).toBe(200);
    expect(sent.map((m) => m.to)).toEqual([ADMIN]);
  });

  it("the caller's own address in any case, and an allow-listed inbox, are accepted", async () => {
    const { keys } = await seed();
    for (const to of [ADMIN.toUpperCase(), TEST_INBOX]) {
      const { status, json } = await post(keys.admin, "/emails/send", { types: ["sign_in_link"], to });
      expect(status, `${to}: ${JSON.stringify(json)}`).toBe(200);
    }
    expect(sent.map((m) => m.to)).toEqual([ADMIN, TEST_INBOX]);
  });

  it("any other address, another admin's included, is refused with no send", async () => {
    const { keys } = await seed();
    for (const to of [STRANGER, SECOND_ADMIN, REAL_CUSTOMER_EMAIL, `${ADMIN}\r\nBcc: ${STRANGER}`, `${ADMIN}, ${STRANGER}`, ""]) {
      const { status, json } = await post(keys.admin, "/emails/send", { types: ["recovery_day1"], to });
      expect(status, JSON.stringify(to)).toBe(400);
      expect(String(json.error), JSON.stringify(to)).toMatch(/ADMIN_EMAIL_TEST_RECIPIENTS|own address/);
    }
    expect(sent).toEqual([]);
  });

  it("with the allow list unset, only the caller's own address is accepted", async () => {
    const { keys } = await seed();
    const bare = env({ ADMIN_EMAIL_TEST_RECIPIENTS: undefined });
    expect((await post(keys.admin, "/emails/send", { types: ["sign_in_link"], to: TEST_INBOX }, { env: bare })).status).toBe(400);
    expect((await post(keys.admin, "/emails/send", { types: ["sign_in_link"] }, { env: bare })).status).toBe(200);
    expect(sent.map((m) => m.to)).toEqual([ADMIN]);
  });
});

describe("PLANT 3 and 4: every type previews, and a preview sends nothing", () => {
  it("the catalog lists exactly the types this capability renders", async () => {
    const { keys } = await seed();
    const { status, json } = await api("/emails", { key: keys.admin, actor: ADMIN });
    expect(status).toBe(200);
    const types = (json.data as { types: { type: string; audience: string; description: string }[] }).types;
    expect(types.map((t) => t.type)).toEqual(ALL_TYPES);
    for (const t of types) {
      expect(["customer", "merchant", "platform"], t.type).toContain(t.audience);
      expect(t.description.length, t.type).toBeGreaterThan(10);
    }
  });

  it("each type renders a subject, an HTML part and a text part, and nothing is sent or written", async () => {
    const { sqlite, keys } = await seed();
    const before = withoutLogs(tableCounts(sqlite));
    for (const type of ALL_TYPES) {
      const { status, json } = await post(keys.admin, "/emails/preview", { type, account_id: MERCHANT });
      expect(status, `${type}: ${JSON.stringify(json)}`).toBe(200);
      const preview = (json.data as { preview: { subject: string; html: string; text: string; from: string; to: string } }).preview;
      expect(preview.subject.length, type).toBeGreaterThan(3);
      expect(preview.html, type).toMatch(/<html|<body|<table/i);
      expect(preview.text.length, type).toBeGreaterThan(20);
      expect(preview.to, type).toBe(ADMIN);
    }
    expect(sent).toEqual([]);
    expect(sendSpies.sendEmail).not.toHaveBeenCalled();
    expect(sendSpies.sendTransactionalEmail).not.toHaveBeenCalled();
    expect(sendSpies.sendRenderedTransactionalEmail).not.toHaveBeenCalled();
    expect(withoutLogs(tableCounts(sqlite))).toEqual(before);
  });

  it("a customer email previews with the merchant's From name, Reply-To, footer and brand voice", async () => {
    const { keys } = await seed();
    const { json } = await post(keys.admin, "/emails/preview", { type: "recovery_day1", account_id: MERCHANT });
    const data = json.data as {
      preview: { from: string; reply_to: string | null; text: string; headers: Record<string, string> };
      merchant: { brand_voice: Record<string, string | null> };
    };
    expect(data.preview.from).toMatch(new RegExp(`^${SENDER_NAME} <`));
    expect(data.preview.reply_to).toBe(REPLY_TO);
    expect(data.preview.text).toContain(`You're receiving this from ${SENDER_NAME}`);
    expect(data.preview.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(data.merchant.brand_voice.default).toBe(BRAND_VOICE);
  });

  it("an unknown type, or an unknown merchant, is a 400 that says how to fix it", async () => {
    const { keys } = await seed();
    const unknown = await post(keys.admin, "/emails/preview", { type: "dispute_notice" });
    expect(unknown.status).toBe(400);
    expect(String(unknown.json.error)).toMatch(/recovery_day1/);
    const nobody = await post(keys.admin, "/emails/preview", { type: "recovery_day1", account_id: "acct_nope" });
    expect(nobody.status).toBe(400);
    expect(String(nobody.json.error)).toMatch(/merchants/);
  });
});

describe("PLANT 5 and 6: a send goes through the send module, with Reply-To, and is audited", () => {
  it("sending every type delivers each one through the send module", async () => {
    const { keys } = await seed();
    const { status, json } = await post(keys.admin, "/emails/send", { types: "all", account_id: MERCHANT });
    expect(status, JSON.stringify(json)).toBe(200);
    const results = (json.data as { results: { type: string; status: string }[] }).results;
    expect(results.map((r) => [r.type, r.status])).toEqual(ALL_TYPES.map((t) => [t, "sent"]));
    expect(sent).toHaveLength(ALL_TYPES.length);
    expect(sent.every((m) => m.to === ADMIN)).toBe(true);
    // Customer and merchant mail through sendEmail, the sign-in link through
    // the module's rendered sender: the binding is reached from nowhere else.
    expect(sendSpies.sendEmail).toHaveBeenCalledTimes(ALL_TYPES.length - 1);
    expect(sendSpies.sendRenderedTransactionalEmail).toHaveBeenCalledTimes(1);
  });

  it("customer mail carries the merchant's sender name and Reply-To; merchant notices carry none", async () => {
    const { keys } = await seed();
    await post(keys.admin, "/emails/send", { types: ["recovery_day3", "winback_step1", "recovery_notification"], account_id: MERCHANT });
    const [dunning, winback, notice] = sent;
    for (const message of [dunning, winback]) {
      expect(message.from).toMatch(new RegExp(`^${SENDER_NAME} <`));
      expect(message.replyTo).toBe(REPLY_TO);
      expect(message.headers?.["List-Unsubscribe"]).toMatch(new RegExp(`^<${ORIGIN}/u/`));
    }
    expect(notice.from).toMatch(/^Foxhound </);
    expect(notice.replyTo).toBeUndefined();
  });

  it("each send leaves an admin_audit_log row naming the acting admin, the type and the merchant", async () => {
    const { db, keys } = await seed();
    await post(keys.admin, "/emails/send", { types: ["recovery_day1", "sign_in_link"], account_id: MERCHANT, to: TEST_INBOX });
    const rows = (await db.select().from(adminAuditLog)).filter((r) => r.action === "email.test_send");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.actorEmail).toBe(ADMIN);
      expect(row.targetEmail).toBe(TEST_INBOX);
      expect((row.metadata as { accountId: string }).accountId).toBe(MERCHANT);
    }
    expect(rows.map((r) => (r.metadata as { type: string }).type).sort()).toEqual(["recovery_day1", "sign_in_link"]);
  });

  it("a suppressed test inbox is reported, not sent to, for customer mail", async () => {
    const { sqlite, keys } = await seed();
    sqlite
      .prepare("INSERT INTO email_suppressions (id, email, token, reason, suppressed_at) VALUES ('s1', ?, 't', 'unsubscribe', ?)")
      .run(ADMIN, NOW.getTime());
    const { json } = await post(keys.admin, "/emails/send", { types: ["recovery_day1"], account_id: MERCHANT });
    const results = (json.data as { results: { status: string }[] }).results;
    expect(results.map((r) => r.status)).toEqual(["suppressed"]);
    expect(sent).toEqual([]);
  });

  it("with no postal address set, customer mail fails by name and nothing goes out for it", async () => {
    const { keys } = await seed();
    const { json } = await post(
      keys.admin,
      "/emails/send",
      { types: ["recovery_day1", "sign_in_link"], account_id: MERCHANT },
      { env: env({ PHYSICAL_ADDRESS: undefined }) },
    );
    const results = (json.data as { results: { type: string; status: string; error: string | null }[] }).results;
    expect(results[0]).toMatchObject({ type: "recovery_day1", status: "failed" });
    expect(String(results[0].error)).toMatch(/physical address/);
    expect(results[1]).toMatchObject({ type: "sign_in_link", status: "sent" });
    expect(sent.map((m) => m.subject)).toEqual(["Your sign-in link for Foxhound"]);
  });
});

describe("PLANT 7: no tracking, no billable record, no real customer data", () => {
  it("no message carries an open pixel, a tracked click, a scanner trap or a card-update link", async () => {
    const { keys } = await seed();
    await post(keys.admin, "/emails/send", { types: "all", account_id: MERCHANT });
    expect(sent).toHaveLength(ALL_TYPES.length);
    for (const message of sent) {
      for (const part of [message.html, message.text]) {
        expect(part, message.subject).not.toContain(`${ORIGIN}/e/`);
        expect(part, message.subject).not.toContain(`${ORIGIN}/p/`);
      }
    }
  });

  it("a send writes no email_sends, engagement, step, outcome or billing row: only the two admin logs grow", async () => {
    const { sqlite, keys } = await seed();
    const before = withoutLogs(tableCounts(sqlite));
    await post(keys.admin, "/emails/send", { types: "all", account_id: MERCHANT });
    expect(sent).toHaveLength(ALL_TYPES.length);
    expect(withoutLogs(tableCounts(sqlite))).toEqual(before);
  });

  it("the merchant's real customers never appear in a preview or a send", async () => {
    const { keys } = await seed();
    const previews: string[] = [];
    for (const type of ALL_TYPES) {
      previews.push((await post(keys.admin, "/emails/preview", { type, account_id: MERCHANT })).text);
    }
    await post(keys.admin, "/emails/send", { types: CUSTOMER_TYPES, account_id: MERCHANT });
    for (const body of [...previews, ...sent.map((m) => JSON.stringify(m))]) {
      expect(body).not.toContain(REAL_CUSTOMER_EMAIL);
      expect(body).not.toContain(REAL_CUSTOMER_NAME);
    }
  });

  it("the capability's module never touches the EMAIL binding or a money writer", () => {
    const body = code(read("app/lib/admin/email-send.server.ts"));
    for (const forbidden of [
      "env.EMAIL",
      ".EMAIL.send",
      "processEmailJob",
      "emailSends",
      "executeMoneyWrite",
      "recordOutcome",
      "signEngagementToken",
      "signCardUpdateToken",
      "buildEngagementUrls",
    ]) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });
});

// ============================================================================
// The Foxhound Admin MCP's two tools for it.

const KEY = "fox_mcp_test_admin_key";

function fakeFoxhound() {
  const calls: { method: string; path: string; body: unknown }[] = [];
  return {
    calls,
    binding: {
      async fetch(request: Request) {
        calls.push({
          method: request.method,
          path: new URL(request.url).pathname,
          body: request.method === "POST" ? await request.json() : null,
        });
        return new Response(JSON.stringify({ ok: true, data: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    },
  };
}

async function callTool(fox: ReturnType<typeof fakeFoxhound>, name: string, args: Record<string, unknown>, scopes: string[]) {
  const res = await serveAdminMcp(
    mcpRequest({ method: "tools/call", params: { name, arguments: args } }),
    { FOXHOUND: fox.binding, FOXHOUND_ADMIN_API_KEY: KEY } as never,
    { actor: ADMIN, client: "test client", scopes },
  );
  return toolOutput(await readMcp(res));
}

describe("PLANT 8: the admin MCP's preview and send tools", () => {
  it("preview is read-only and send is a write; both are foxhound_admin_ named", () => {
    const preview = ADMIN_TOOLS.find((t) => t.name === "foxhound_admin_preview_email");
    const send = ADMIN_TOOLS.find((t) => t.name === "foxhound_admin_send_test_email");
    expect(preview?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(send?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
  });

  it("preview calls the catalog with no type, and the preview route with one", async () => {
    const fox = fakeFoxhound();
    await callTool(fox, "foxhound_admin_preview_email", {}, [SCOPE_READ]);
    await callTool(fox, "foxhound_admin_preview_email", { type: "recovery_day1", account_id: MERCHANT }, [SCOPE_READ]);
    expect(fox.calls.map((c) => [c.method, c.path])).toEqual([
      ["GET", "/api/admin/v1/emails"],
      ["POST", "/api/admin/v1/emails/preview"],
    ]);
    expect(fox.calls[1].body).toEqual({ type: "recovery_day1", account_id: MERCHANT });
  });

  it("send needs the write grant, and passes types, merchant and recipient to the send route", async () => {
    const readOnly = fakeFoxhound();
    const refused = await callTool(readOnly, "foxhound_admin_send_test_email", { types: "all" }, [SCOPE_READ]);
    expect(refused.isError).toBe(true);
    expect(readOnly.calls).toEqual([]);

    const fox = fakeFoxhound();
    const out = await callTool(
      fox,
      "foxhound_admin_send_test_email",
      { types: ["recovery_day1"], account_id: MERCHANT, to: TEST_INBOX },
      [SCOPE_READ, SCOPE_WRITE],
    );
    expect(out.isError).toBe(false);
    expect(fox.calls).toEqual([
      { method: "POST", path: "/api/admin/v1/emails/send", body: { types: ["recovery_day1"], account_id: MERCHANT, to: TEST_INBOX } },
    ]);
  });
});
