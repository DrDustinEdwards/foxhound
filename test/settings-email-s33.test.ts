import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
const { toEmailContext } = await import("~/lib/cron/recovery-tick");
const { buildRecoveryEmailJob } = await import("~/lib/engine/execute-step");
const { SENDER_NAME_MAX_LENGTH } = await import("~/lib/settings/persist.server");
const { LIVE_SENDS_DISABLED_ERROR } = await import("~/lib/email/dispatch");

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
  it("saves the name on the primary connection", async () => {
    seedConnection({ id: "c1", senderName: null });
    const res = await post({ _action: "sender", connectionId: "c1", senderName: "Alex from Acme" });
    expect(res.status).toBe(200);
    expect(connectionRow("c1").senderName).toBe("Alex from Acme");
  });

  it("a form posting EXTRA column names writes none of them", async () => {
    // Legacy's own handler is an allowlist for exactly this reason: its comment
    // records that the unconditional version clobbered every other section's
    // columns to null. The builder names one column, so these ride along and
    // land nowhere.
    seedConnection({ id: "c1", senderName: null, brandVoice: "warm and direct" });

    const res = await post({
      _action: "sender",
      connectionId: "c1",
      senderName: "Alex from Acme",
      brandVoice: "HIJACKED",
      brand_voice: "HIJACKED",
      senderDomain: "evil.test",
      sender_domain: "evil.test",
      isPrimary: "false",
      is_primary: "false",
    });

    expect(res.status).toBe(200);
    const row = connectionRow("c1");
    expect(row.senderName).toBe("Alex from Acme");
    expect(row.brandVoice).toBe("warm and direct");
    const raw = sqlite
      .prepare("SELECT sender_domain AS d, is_primary AS p FROM stripe_connections WHERE id = ?")
      .get("c1") as { d: string | null; p: number };
    expect(raw.d).toBeNull();
    expect(raw.p).toBe(1);
  });

  it("refuses a connection on ANOTHER account and writes nothing", async () => {
    seedConnection({ id: "c_theirs", accountId: OTHER, senderName: "Theirs" });
    const res = await post({ _action: "sender", connectionId: "c_theirs", senderName: "Hijacked" });
    // The WHERE pins account_id, so a foreign id matches zero rows.
    expect(res.status).toBe(200);
    expect(connectionRow("c_theirs").senderName).toBe("Theirs");
  });
});

describe("PLANT 2: sender_name is required and bounded", () => {
  it("400 and no write when the field is empty", async () => {
    seedConnection({ id: "c1", senderName: "Existing" });
    const res = await post({ _action: "sender", connectionId: "c1", senderName: "   " });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toBe("Sender name is required.");
    expect(connectionRow("c1").senderName).toBe("Existing");
  });

  it("400 and no write one character over the bound, and 200 exactly at it", async () => {
    seedConnection({ id: "c1", senderName: "Existing" });

    const over = "x".repeat(SENDER_NAME_MAX_LENGTH + 1);
    const tooLong = await post({ _action: "sender", connectionId: "c1", senderName: over });
    expect(tooLong.status).toBe(400);
    expect(String(tooLong.body.error)).toContain(String(SENDER_NAME_MAX_LENGTH));
    expect(connectionRow("c1").senderName).toBe("Existing");

    const exact = "y".repeat(SENDER_NAME_MAX_LENGTH);
    const atBound = await post({ _action: "sender", connectionId: "c1", senderName: exact });
    expect(atBound.status).toBe(200);
    expect(connectionRow("c1").senderName).toBe(exact);
  });

  it("400 when the account has no live primary connection", async () => {
    const res = await post({ _action: "sender", senderName: "Alex" });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("Connect Stripe");
  });

  it("the error strings carry no wide dashes", async () => {
    seedConnection({ id: "c1" });
    const wide = new RegExp("[" + String.fromCharCode(0x2014, 0x2013) + "]");
    const empty = await post({ _action: "sender", connectionId: "c1", senderName: "" });
    expect(String(empty.body.error)).not.toMatch(wide);
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
      { unsubscribeToken: "tok", physicalAddress: "1 Test Way", openUrl: "https://x/o" },
    );
    return buildEmailMessage(job, "https://foxhoundapp.test").from;
  }

  it("equals the saved sender name in legacy's shape, Name <addr>", async () => {
    seedConnection({ id: "c1", senderName: null });
    await post({ _action: "sender", connectionId: "c1", senderName: "Alex from Acme" });
    const saved = connectionRow("c1").senderName;

    const from = fromHeaderFor(saved);
    expect(from).toMatch(/^Alex from Acme <[^ >]+@[^ >]+>$/);
    expect(from.startsWith(saved + " <")).toBe(true);
  });

  it("THE DEFECT: the copy fallback never reaches the From header again", async () => {
    // With sender_name unset, `merchantName` is still "your subscription" for
    // the BODY copy, which is what that phrase is for. The From header must not
    // see it.
    const ctxOut = toEmailContext({ ...row, merchantName: null } as never);
    expect(ctxOut.merchantName).toBe("your subscription");
    expect(fromHeaderFor(null)).not.toContain("your subscription");
  });

  it("falls back to legacy's 'Support', which is what legacy sends", async () => {
    // lib/recovery-execution.ts:197: `merchant.sender_name || 'Support'`.
    expect(fromHeaderFor(null)).toMatch(/^Support </);
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

  it("the recipient is never taken from the form", async () => {
    seedConnection({ id: "c1", senderName: "Alex" });
    await post({ _action: "test-email", to: "attacker@evil.test", email: "attacker@evil.test" });
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0].to).toBe(USER_EMAIL);
  });

  it("an account without live sends is REFUSED, and the refusal is logged not silent", async () => {
    // The demo account and every un-switched-on account read false here. This
    // is the real refusal at this layer; the demo firewall's own 405 is
    // appShellMiddleware's and is untouched by this session.
    sqlite.prepare("UPDATE accounts SET live_sends_enabled = 0 WHERE id = ?").run(ACCOUNT);
    seedConnection({ id: "c1", senderName: "Alex" });

    const res = await post({ _action: "test-email" });

    expect(res.body.ok).toBe(false);
    expect(harness.sent).toHaveLength(0);
    const rows = sqlite
      .prepare("SELECT status, error FROM email_sends WHERE account_id = ?")
      .all(ACCOUNT) as { status: string; error: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("blocked");
    expect(rows[0].error).toBe(LIVE_SENDS_DISABLED_ERROR);
  });
});

describe("PLANT 5: fields with no reader do not render", () => {
  const SOURCE = readFileSync(
    fileURLToPath(new URL("../app/routes/app/settings/email.tsx", import.meta.url)),
    "utf8",
  );
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("renders sender name and NOT sender domain or reply-to", () => {
    expect(code).toContain('name="senderName"');
    // Both write columns nothing reads. A field that writes a column nothing
    // reads is a false promise, so they wait for their readers.
    expect(code).not.toContain('name="senderDomain"');
    expect(code).not.toContain('name="sender_domain"');
    expect(code).not.toContain('name="replyTo"');
    expect(code).not.toContain('name="reply_to_email"');
  });

  it("the readers genuinely do not exist, which is what licenses their absence", () => {
    // If this ever goes red, the field should be BUILT, not this assertion
    // relaxed. That is the whole shape of the plant.
    const send = readFileSync(
      fileURLToPath(new URL("../app/lib/email/send.ts", import.meta.url)),
      "utf8",
    );
    expect(send).not.toContain("Reply-To");
    expect(send).not.toContain("replyTo");
    expect(send).not.toContain("senderDomain");
  });

  it("both controls render inside DemoGuardedForm, like every other settings write", () => {
    expect(code).toContain('<DemoGuardedForm method="post"');
    expect(code).not.toContain('<Form method="post"');
    expect(code).not.toContain("DEMO_ACCOUNT_ID");
  });
});

describe("PLANT 6: the docs describe the fields that were built", () => {
  const DOCS = readFileSync(
    fileURLToPath(new URL("../app/lib/marketing/docs-content.ts", import.meta.url)),
    "utf8",
  );

  it("names the sender name, its default, and the test-email control", () => {
    expect(DOCS).toContain("Settings and Email holds the sender name");
    expect(DOCS).toContain("From line");
    // The default is stated because a merchant who never sets it still sends.
    expect(DOCS).toContain('recovery mail goes out from \\"Support\\"');
    expect(DOCS).toContain("Send test email");
  });

  it("promises NOTHING the page does not render", () => {
    const platform = DOCS.slice(0, DOCS.indexOf('slug: "audit"'));
    expect(platform).not.toContain("sender domain");
    expect(platform).not.toContain("Sender domain");
    expect(platform).not.toContain("Reply-to");
  });
});

describe("PLANT 7: the shared settings surfaces still stand", () => {
  it("S37's route keeps both its intents and its own guards", () => {
    // This row adds a settings ROUTE beside /settings; the regression that
    // matters is the S37 controls on the index route, which share the surface.
    const s37 = readFileSync(
      fileURLToPath(new URL("../app/routes/app/settings/index.tsx", import.meta.url)),
      "utf8",
    );
    expect(s37).toContain('value="disconnect-stripe"');
    expect(s37).toContain('value="cancel-account"');
    expect(s37).toContain('name="connectionId" value={conn.id}');
  });

  it("the email route is registered and reachable from the nav", () => {
    const routes = readFileSync(
      fileURLToPath(new URL("../app/routes.ts", import.meta.url)),
      "utf8",
    );
    expect(routes).toContain('route("email", "./routes/app/settings/email.tsx")');
    const manifest = readFileSync(
      fileURLToPath(new URL("../app/lib/nav/manifest.ts", import.meta.url)),
      "utf8",
    );
    expect(manifest).toContain('to: "/settings/email"');
  });

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
