import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// E23 review round 1 (PR 158): the digest's Unsubscribe switches the digest
// off for that account and nothing else. Recova's unsubscribe writes an
// address-wide suppression, but Recova's merchant notices never read it, so a
// Recova merchant who leaves the digest keeps every notice. Foxhound's
// suppression gate stops every audience, so an address-wide row here would
// silence dispute deadlines and alerts too (RULES.md 3.16), could be tripped by
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
const settingsRoute = await import("~/routes/app/settings/notifications");
const { runWeeklyDigest } = await import("~/lib/cron/digest");
const { signUnsubscribeToken, verifyUnsubscribeToken } = await import("~/lib/email/unsubscribe-token");
const { sendRecoveryNotification } = await import("~/lib/recovery/merchant-notification.server");
const { sendSequenceCompleteNotification } = await import(
  "~/lib/recovery/sequence-complete-notification.server"
);
const { sendDisputeCreatedNotice } = await import("~/lib/disputes/notices.server");
const { notifyCriticalCustomers } = await import("~/lib/intelligence/alert-notify.server");

const BASE = "https://foxhoundapp.test";
const OWNER = "owner@acme.test";
const A = "acct_1";
const B = "acct_2";
const MONDAY_1 = new Date("2026-11-02T08:00:00Z");
const MONDAY_2 = new Date("2026-11-09T08:00:00Z");

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

const visit = async (token: string) =>
  route.loader({ params: { token }, request: new Request(`${BASE}/u/${token}`), context: routeContext() } as never);

const post = async (token: string) =>
  route.action({
    params: { token },
    request: new Request(`${BASE}/u/${token}`, { method: "POST" }),
    context: routeContext(),
  } as never);

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

describe("the digest's token says which list it is", () => {
  it("the cron signs {email, accountId, list: digest}", async () => {
    const token = await digestTokenForA();
    expect(await verifyUnsubscribeToken(env, token)).toEqual({ email: OWNER, accountId: A, list: "digest" });
  });

  it("a digest token and a customer token for the same address and account differ", async () => {
    const customer = await signUnsubscribeToken(env, { email: OWNER, accountId: A });
    const digest = await signUnsubscribeToken(env, { email: OWNER, accountId: A, list: "digest" });
    expect(digest).not.toBe(customer);
  });
});

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

  it("E10, E11, a dispute notice and an E22 alert to the same address still send", async () => {
    const token = await digestTokenForA();
    await visit(token);
    harness.sent = [];

    sqlite
      .prepare(
        "INSERT INTO failed_payments (id, account_id, stripe_event_id, stripe_invoice_id, stripe_customer_id, customer_email, customer_name, amount_cents, currency, decline_category, status, detected_at) VALUES ('fp_1', ?, 'evt', 'in_1', 'cus_1', 'buyer@acme.test', 'Jane Buyer', 9900, 'usd', 'soft', 'recovered', 1000)",
      )
      .run(A);
    sqlite
      .prepare(
        "INSERT INTO disputes (id, account_id, stripe_dispute_id, stripe_charge_id, customer_name, customer_email, amount_cents, currency, reason, status, state, created_at, stripe_connection_id) VALUES ('d1', ?, 'dp_1', 'ch_1', 'Jane Buyer', 'buyer@acme.test', 5000, 'usd', 'product_not_received', 'needs_response', 'draft', 1000, ?)",
      )
      .run(A, `c_${A}`);

    const e10 = await sendRecoveryNotification(env, { accountId: A, failedPaymentId: "fp_1" });
    const e11 = await sendSequenceCompleteNotification(env, { accountId: A, failedPaymentId: "fp_1" });
    const dispute = await sendDisputeCreatedNotice(env, { accountId: A, disputeId: "d1" });
    const alert = await notifyCriticalCustomers(env, harness.db as never, A, 2, MONDAY_1);

    expect(e10).toMatchObject({ kind: "sent", result: { status: "sent" } });
    expect(e11).toMatchObject({ kind: "sent", result: { status: "sent" } });
    expect(dispute).toMatchObject({ kind: "sent", result: { status: "sent" } });
    expect(alert).toMatchObject({ channel: "email", notificationSent: true });
    expect(harness.sent.map((m) => m.to)).toEqual([OWNER, OWNER, OWNER, OWNER]);
  });

  it("a second account sharing the address keeps its digest", async () => {
    const token = await digestTokenForA();
    await visit(token);
    harness.sent = [];

    const next = await runWeeklyDigest(env, MONDAY_2);

    expect(next.outcomes).toEqual([{ accountId: B, status: "sent" }]);
    expect(digestOn(B)).toBe(1);
  });

  it("the settings page shows the digest off afterwards", async () => {
    const token = await digestTokenForA();
    await visit(token);

    const settingsContext = {
      get(key: unknown) {
        if (key === cloudflareContext) return { env, ctx: {} as ExecutionContext, nonce: "n" };
        if (key === authContext) {
          return {
            userId: "user_1",
            email: OWNER,
            membership: { memberId: "m1", accountId: A, accountName: "Acme", role: "owner" },
          };
        }
        throw new Error("unexpected context key");
      },
    } as never;
    const loaded = (await settingsRoute.loader({
      context: settingsContext,
      request: new Request(`${BASE}/settings/notifications`),
      params: {},
    } as never)) as { digestEnabled: boolean };
    expect(loaded.digestEnabled).toBe(false);
  });
});

describe("a customer token cannot switch off a digest", () => {
  it("it suppresses the address as before and leaves the toggle alone", async () => {
    const customer = await signUnsubscribeToken(env, { email: OWNER, accountId: A });

    expect(await visit(customer)).toEqual({ state: "done" });
    expect(digestOn(A)).toBe(1);
    expect(suppressionCount()).toBe(1);
  });
});

describe("the cron still honours suppression for bounces, complaints and migrated opt-outs", () => {
  it("a bounced notification address gets no digest", async () => {
    sqlite
      .prepare(
        "INSERT INTO email_suppressions (id, email, token, reason, suppressed_at) VALUES ('s1', ?, 't', 'bounce', 1000)",
      )
      .run(OWNER);

    const run = await runWeeklyDigest(env, MONDAY_1);

    expect(harness.sent).toEqual([]);
    expect(run.outcomes.map((o) => o.status)).toEqual(["suppressed", "suppressed"]);
  });
});
