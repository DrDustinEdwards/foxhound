import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";


import { createInMemoryDb } from "./helpers/inmemory-db";

// E23 review round 1 (PR 158): the digest's Unsubscribe switches the digest
// off for that account and nothing else. Recova's unsubscribe writes an
// address-wide suppression, but Recova's merchant notices never read it, so a
// Recova merchant who leaves the digest keeps every notice. Foxhound's
// suppression gate stops every audience, so an address-wide row here would
// silence dispute deadlines and alerts too, could be tripped by
// a link scanner's GET (3.4), and would hit every account sharing the address
// (1.6). The seat's call: the digest token carries `list: "digest"`, and /u/
// sets digest_enabled false for that account when the address still matches.

interface SentMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

const harness = vi.hoisted(() => ({
  db: null as unknown,
  sent: [] as SentMessage[],
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/intelligence/views.server", () => ({
  isIntelligenceEntitled: async () => false,
}));

const route = await import("~/routes/utility/unsubscribe");
const { runWeeklyDigest } = await import("~/lib/cron/digest");
const { verifyUnsubscribeToken } = await import("~/lib/email/unsubscribe-token");

const BASE = "https://foxhoundapp.test";
const OWNER = "owner@acme.test";
const A = "acct_1";
const B = "acct_2";
const MONDAY_1 = new Date("2026-11-02T08:00:00Z");

const env = {
  ENCRYPTION_KEY: "ab".repeat(32),
  BETTER_AUTH_URL: BASE,
  PHYSICAL_ADDRESS: "1 Test Way, Austin TX",
  EMAIL: {
    send: async (m: SentMessage) => {
      harness.sent.push(m);
      return { id: `msg_${harness.sent.length}` };
    },
  },
} as unknown as Env;

let sqlite: Database.Database;

function seedAccount(id: string): void {
  sqlite
    .prepare(
      "INSERT INTO accounts (id, name, created_at, digest_enabled, notification_email, processing_paused, live_sends_enabled) VALUES (?, 'Acme', 1000, 1, ?, 0, 1)",
    )
    .run(id, OWNER);
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, stripe_access_token, sender_name, connected_at, created_at) VALUES (?, ?, ?, 1, 'cipher', 'Teamflow', 1000, 1000)",
    )
    .run(`c_${id}`, id, `acct_s_${id}`);
}

beforeEach(() => {
  let db: ReturnType<typeof createInMemoryDb>["db"];
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.sent = [];
  seedAccount(A);
  seedAccount(B);
});

const routeContext = () =>
  ({ get: () => ({ env, ctx: {} as ExecutionContext, nonce: "n" }) }) as never;

/** The page's confirm button: the visit that writes (a GET only offers it). */
const visit = async (token: string) =>
  route.action({
    params: { token },
    request: new Request(`${BASE}/u/${token}`, { method: "POST", body: new URLSearchParams({ confirm: "1" }) }),
    context: routeContext(),
  } as never);

const post = async (token: string) =>
  (await route.action({
    params: { token },
    request: new Request(`${BASE}/u/${token}`, { method: "POST" }),
    context: routeContext(),
  } as never)) as Response;

const digestOn = (id: string) =>
  (sqlite.prepare("SELECT digest_enabled AS d FROM accounts WHERE id = ?").get(id) as { d: number | null }).d;

const suppressionCount = () =>
  (sqlite.prepare("SELECT count(*) AS n FROM email_suppressions").get() as { n: number }).n;

/** The unsubscribe token in the digest the cron sent to account A. */
async function digestTokenForA(): Promise<string> {
  await runWeeklyDigest(env, MONDAY_1);
  for (const m of harness.sent) {
    const href = /href="https:\/\/foxhoundapp\.test\/u\/([^"]+)"[^>]*>Unsubscribe</.exec(m.html)?.[1];
    if (!href) continue;
    const token = decodeURIComponent(href);
    if ((await verifyUnsubscribeToken(env, token))?.accountId === A) return token;
  }
  throw new Error("no digest for account A");
}

describe("a digest Unsubscribe switches off that account's digest and nothing else", () => {
  it("the visit reads done, the toggle is off, and no suppression row is written", async () => {
    const token = await digestTokenForA();

    expect(await visit(token)).toEqual({ state: "done" });
    expect(digestOn(A)).toBe(0);
    expect(suppressionCount()).toBe(0);
  });

  it("the RFC 8058 POST does the same", async () => {
    const token = await digestTokenForA();

    expect((await post(token)).status).toBe(200);
    expect(digestOn(A)).toBe(0);
    expect(suppressionCount()).toBe(0);
  });

  it("a second visit reads already unsubscribed, naming the address", async () => {
    const token = await digestTokenForA();
    await visit(token);
    expect(await visit(token)).toEqual({ state: "already", email: OWNER });
  });

  it("an address changed since the mail went out is reported, never claimed as done (RULES.md 3.9)", async () => {
    const token = await digestTokenForA();
    sqlite.prepare("UPDATE accounts SET notification_email = 'new@acme.test' WHERE id = ?").run(A);

    expect(await visit(token)).toEqual({ state: "changed" });
    expect(digestOn(A)).toBe(1);
  });
});
