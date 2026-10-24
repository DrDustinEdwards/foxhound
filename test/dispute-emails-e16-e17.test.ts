import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J92 (job_ec4810299217), parity rows E16 and E17: the new dispute notice and
// the dispute deadline reminder say and carry what Recova's say, on Capsomer's
// `notice` template. Recova's spec, read whole at HEAD:
//   lib/disputes-email.ts                   blob 156719f1 (lines 80 to 159)
//   lib/email.ts                            blob 3f882729 (wrapEmailHtml)
//   lib/dispute-handlers.ts                 blob e2bb8de8 (the E16 trigger)
//   app/api/cron/process-disputes/route.ts  blob 1cbd5bd0 (the E17 trigger)
//
// J06 built the triggers, the skips and the once-only claims, and its own tests
// (dispute-notices-j06, dispute-reminders-j06) hold them; this file holds what
// each mail SAYS and CARRIES, read from the message the binding is handed.
// E18 is not built (RULES.md 5.6): its only Recova trigger is auto-submit.

interface SentMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

const harness = vi.hoisted(() => ({
  db: null as unknown,
  sqlite: null as unknown,
  seen: new Set<string>(),
  sent: [] as SentMessage[],
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/money/execute", () => ({
  executeMoneyWrite: async (_env: Env, write: { idempotencyKey: string; build: (db: unknown) => unknown[] }) => {
    if (harness.seen.has(write.idempotencyKey)) return { applied: false };
    const sqlite = harness.sqlite as Database.Database;
    sqlite.exec("BEGIN");
    try {
      await (harness.db as { batch: (s: unknown[]) => Promise<unknown> }).batch(write.build(harness.db));
      sqlite.exec("COMMIT");
    } catch (err) {
      sqlite.exec("ROLLBACK");
      if (/UNIQUE constraint failed/.test(String(err))) return { applied: false };
      throw err;
    }
    harness.seen.add(write.idempotencyKey);
    return { applied: true };
  },
}));

const { processConnectedWebhook } = await import("~/lib/webhooks/process");
const { DISPUTE_CREATED_TEMPLATE } = await import(
  "~/lib/disputes/notices"
);

const ACCOUNT = "acct_1";
const BASE = "https://foxhoundapp.test";
const NOW = new Date("2026-11-10T12:00:00Z");
const DEADLINE = new Date("2026-11-24T23:59:59Z");
const YEAR = new Date().getUTCFullYear();

/** Recova's wrapEmailHtml footer sentence, for a given sender name. */
const footerNote = (sender: string) => `You're receiving this from ${sender} about a recent payment. © ${YEAR}`;

function makeEnv(baseUrl = BASE): Env {
  return {
    ENCRYPTION_KEY: "ab".repeat(32),
    BETTER_AUTH_URL: baseUrl,
    EMAIL: {
      send: async (m: SentMessage) => {
        harness.sent.push(m);
        return { id: `msg_${harness.sent.length}` };
      },
    },
  } as unknown as Env;
}
const env = makeEnv();

let sqlite: Database.Database;

beforeEach(() => {
  const made = createInMemoryDb();
  sqlite = made.sqlite;
  harness.db = made.db;
  harness.sqlite = made.sqlite;
  harness.seen = new Set();
  harness.sent = [];
});

function seedAccount(opts: { senderName?: string | null } = {}) {
  sqlite
    .prepare(
      "INSERT INTO accounts (id, name, created_at, notification_email, processing_paused, live_sends_enabled) VALUES (?, 'Acme', 1000, 'ops@acme.test', 0, 1)",
    )
    .run(ACCOUNT);
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, stripe_access_token, connected_at, created_at, sender_name) VALUES ('c1', ?, 'acct_stripe', 1, 'cipher', 1000, 1000, ?)",
    )
    .run(ACCOUNT, opts.senderName === undefined ? "Acme Billing" : opts.senderName);
}


function only(): SentMessage {
  expect(harness.sent).toHaveLength(1);
  return harness.sent[0];
}

// ============================================================================
// E16: when it sends, on Recova's trigger
// ============================================================================

describe("E16 sends on charge.dispute.created with Recova's words and footer", () => {
  it("one mail, to the notification address, after the intake commits", async () => {
    seedAccount();
    const event = {
      id: "evt_c1",
      type: "charge.dispute.created",
      account: "acct_stripe",
      data: {
        object: {
          id: "dp_new",
          object: "dispute",
          charge: "ch_new",
          payment_intent: null,
          amount: 5000,
          currency: "usd",
          reason: "product_not_received",
          status: "needs_response",
          evidence_details: { due_by: Math.floor(DEADLINE.getTime() / 1000) },
          created: Math.floor(NOW.getTime() / 1000),
        },
      },
    } as never;
    expect(await processConnectedWebhook(env, event, NOW)).toEqual({ status: "applied" });
    const m = only();
    const row = sqlite.prepare("SELECT id FROM disputes WHERE stripe_dispute_id = 'dp_new'").get() as { id: string };
    expect(m.to).toBe("ops@acme.test");
    expect(m.subject).toBe("New dispute: $50.00 from Unknown customer");
    expect(m.text).toContain("Unknown customer disputed $50.00 for reason: Product Not Received.");
    expect(m.text).toContain(`Review dispute:\n${BASE}/disputes/${row.id}`);
    expect(m.text).toContain(`${footerNote("Acme Billing")}\nManage email settings: ${BASE}/settings`);
    const sends = sqlite.prepare("SELECT status, template FROM email_sends").all();
    expect(sends).toEqual([{ status: "sent", template: DISPUTE_CREATED_TEMPLATE }]);
  });
});
