
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// S33: /settings/email, the sender name, and the From header. Ruling 14's row,
// named a launch blocker in core.md.
//
// THE DEFECT THIS ROW CLOSES, stated so the plants are readable: `sender_name`
// had no writer anywhere, so every row was NULL, so `toEmailContext`'s copy
// fallback fired and `fromName` was fed "your subscription". Every recovery
// email would have gone out from a sender called "your subscription". The wire
// from column to header already existed; what was missing was the value.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  sent: [] as { from: string; to: string; subject: string; html: string }[],
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { action, loader } = await import("~/routes/app/settings/email");
const { buildEmailMessage } = await import("~/lib/email/send");
const { toEmailContext } = await import("~/lib/cron/due-steps");
const { buildRecoveryEmailJob } = await import("~/lib/engine/execute-step");

const USER = "user_1";
const ACCOUNT = "acct_1";
const OTHER = "acct_other";
const USER_EMAIL = "owner@acme.test";

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];

// A 64-hex ENCRYPTION_KEY so signUnsubscribeToken can import a real HMAC key.
const ENCRYPTION_KEY = "ab".repeat(32);

const env = {
  ENCRYPTION_KEY,
  BETTER_AUTH_URL: "https://foxhoundapp.test",
  PHYSICAL_ADDRESS: "1 Test Way, Austin TX",
  EMAIL: {
    send: async (m: { from: string; to: string; subject: string; html: string }) => {
      harness.sent.push(m);
      return { id: "msg_1" };
    },
  },
} as unknown as Env;

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.sent = [];

  sqlite
    .prepare("INSERT INTO accounts (id, name, created_at, live_sends_enabled) VALUES (?, ?, 1000, 1)")
    .run(ACCOUNT, "Acme");
  sqlite
    .prepare("INSERT INTO accounts (id, name, created_at, live_sends_enabled) VALUES (?, ?, 1000, 1)")
    .run(OTHER, "Someone else");
});

function seedConnection(opts: {
  id: string;
  accountId?: string;
  isPrimary?: boolean;
  senderName?: string | null;
  brandVoice?: string | null;
  disconnectedAt?: number | null;
}): void {
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, sender_name, brand_voice, connected_at, disconnected_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 1000, ?, 1000)",
    )
    .run(
      opts.id,
      opts.accountId ?? ACCOUNT,
      "acct_stripe_" + opts.id,
      opts.isPrimary === false ? 0 : 1,
      opts.senderName ?? null,
      opts.brandVoice ?? null,
      opts.disconnectedAt ?? null,
    );
}

function connectionRow(id: string): { senderName: string | null; brandVoice: string | null } {
  return sqlite
    .prepare("SELECT sender_name AS senderName, brand_voice AS brandVoice FROM stripe_connections WHERE id = ?")
    .get(id) as { senderName: string | null; brandVoice: string | null };
}

const ctx = {
  get(key: unknown) {
    if (key === cloudflareContext) return { env, ctx: {} as ExecutionContext, nonce: "n" };
    if (key === authContext) {
      return {
        userId: USER,
        userName: "Owner",
        email: USER_EMAIL,
        membership: { memberId: "m1", accountId: ACCOUNT, accountName: "Acme", role: "owner" },
        memberships: [{ memberId: "m1", accountId: ACCOUNT, accountName: "Acme", role: "owner" }],
        activeAccountId: ACCOUNT,
        isAdmin: false,
        isDemo: false,
        demoSignedIn: false,
      };
    }
    throw new Error("unexpected context key");
  },
} as unknown as Parameters<typeof action>[0]["context"];

async function post(fields: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = (await action({
    context: ctx,
    request: new Request("https://foxhoundapp.test/settings/email", { method: "POST", body: form }),
    params: {},
  } as never)) as unknown as { data: Record<string, unknown>; init?: { status?: number } };
  return { status: res.init?.status ?? 200, body: res.data };
}

describe("PLANT 1: the save writes sender_name and nothing else", () => {

  it("refuses a connection on ANOTHER account and writes nothing", async () => {
    seedConnection({ id: "c_theirs", accountId: OTHER, senderName: "Theirs" });
    const res = await post({ _action: "sender", connectionId: "c_theirs", senderName: "Hijacked" });
    // CHANGED IN SESSION 79, and the assertion now matches this test's own name.
    // It asserted 200: the WHERE pinned account_id so a foreign id matched zero
    // rows and the write silently no-opped into a SUCCESS. A save that reports
    // success for a change it did not make is the class this campaign keeps
    // fixing, and it mattered more once an MCP tool could pass the id as an
    // argument rather than getting it from the page's own loader. The shared
    // apply layer now verifies ownership and refuses.
    expect(res.status).toBe(400);
    expect(connectionRow("c_theirs").senderName).toBe("Theirs");
  });
});

describe("PLANT 2: sender_name is required and bounded", () => {

  it("400 when the account has no live primary connection", async () => {
    const res = await post({ _action: "sender", senderName: "Alex" });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("Connect Stripe");
  });
});

describe("PLANT 3: the saved name becomes the From header", () => {
  const row = {
    stepId: "s1",
    stepType: "email",
    stepNumber: 1,
    accountId: ACCOUNT,
    failedPaymentId: "fp1",
    scheduledAt: new Date(0),
    nextRetryAt: null,
    attemptCount: 0,
    customBody: null,
    aiSubject: null,
    aiBodyHtml: null,
    invoiceId: "in_1",
    amountCents: 9900,
    currency: "usd",
    customerEmail: "c@acme.test",
    declineCategory: "soft",
    connectionAccessToken: "tok",
    merchantName: null as string | null,
    brandVoice: null,
  };

  function fromHeaderFor(senderName: string | null): string {
    const ctxOut = toEmailContext({ ...row, merchantName: senderName } as never);
    const job = buildRecoveryEmailJob(
      ctxOut,
      { subject: "s", bodyHtml: "<p>b</p>" },
      {
        unsubscribeToken: "tok",
        physicalAddress: "1 Test Way",
        openUrl: "https://x/o",
        honeypotUrl: "https://x/h",
      },
    );
    return buildEmailMessage(job, "https://foxhoundapp.test").from;
  }

  it("THE DEFECT: the copy fallback never reaches the From header again", async () => {
    // With sender_name unset, `merchantName` is still "your subscription" for
    // the BODY copy, which is what that phrase is for. The From header must not
    // see it.
    const ctxOut = toEmailContext({ ...row, merchantName: null } as never);
    expect(ctxOut.merchantName).toBe("your subscription");
    expect(fromHeaderFor(null)).not.toContain("your subscription");
  });
});

describe("PLANT 4: the test email is a real send", () => {
  it("sends exactly one message to the SESSION user and logs an email_sends row", async () => {
    seedConnection({ id: "c1", senderName: "Alex from Acme" });

    const res = await post({ _action: "test-email" });

    expect(res.body.ok).toBe(true);
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0].to).toBe(USER_EMAIL);
    // The point of the control: the From line is the merchant's saved name.
    expect(harness.sent[0].from.startsWith("Alex from Acme <")).toBe(true);
    expect(harness.sent[0].subject.startsWith("[PREVIEW] ")).toBe(true);

    const rows = sqlite
      .prepare("SELECT status FROM email_sends WHERE account_id = ?")
      .all(ACCOUNT) as { status: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("sent");
  });
});

describe("PLANT 7: the shared settings surfaces still stand", () => {

  it("the loader hands the form the primary LIVE connection, never a disconnected one", async () => {
    // S37 leaves is_primary SET on a disconnected row, so a reader without the
    // null check would hand this form a severed connection to write to.
    seedConnection({ id: "c_gone", senderName: "Old", disconnectedAt: 500 });
    const loaded = (await loader({
      context: ctx,
      request: new Request("https://x/settings/email"),
      params: {},
    } as never)) as { connectionId: string | null; senderName: string };
    expect(loaded.connectionId).toBeNull();
    expect(loaded.senderName).toBe("");
  });
});
