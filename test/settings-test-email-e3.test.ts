import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// E3 (parity/ROWS-E.md, job J84): the Send test email control on
// /settings/email delivers Recova's preview.
//
// Recova is the spec: app/(app)/settings/test-email/route.ts (blob dcc3a06f,
// 11006 bytes), read whole. On every click it sends one mail, with no toggle,
// to the signed-in user's own address:
//   From     `${sender_name || 'Support'} <recovery@...>`
//   Reply-To the primary connection's reply_to_email, when set
//   Subject  `[PREVIEW] ${subject}`
//   Body     a preview banner, the sample, and the footer "This is a preview
//            email sent from Recova. Your real recovery emails will look like
//            this."
//   No unsubscribe link, no postal address, no tracking.
//
// Foxhound previews its deterministic template while generation cannot run
// (no Anthropic credit, core.md launch blockers), and the sample is the real
// first recovery email: Recova's own email_day1 words (FALLBACK_TEMPLATES,
// lib/recovery-execution.ts blob 3a8f8768) with Recova's sample customer,
// Alex. Every assertion reads the message as it reaches env.EMAIL.send.

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
  sent: [] as SentMessage[],
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { action, loader } = await import("~/routes/app/settings/email");
const { sendTestEmail } = await import("~/lib/settings/test-email.server");
const { EMAIL_FROM_ADDRESS } = await import("~/lib/constants");

const BASE = "https://foxhoundapp.test";
const ADDRESS = "1 Test Way, Austin TX";
const ACCOUNT = "acct_1";
const USER_EMAIL = "owner@acme.test";
const REPLY = "help@acme.test";
const SENDER = "Alex from Acme";
// Capsomer's teal family, light theme, body text: the same frame every
// Foxhound mail, the real recovery email included, is drawn in (J02).

function makeEnv(over: Record<string, unknown> = {}): Env {
  return {
    ENCRYPTION_KEY: "ab".repeat(32),
    BETTER_AUTH_URL: BASE,
    PHYSICAL_ADDRESS: ADDRESS,
    EMAIL: {
      send: async (m: SentMessage) => {
        harness.sent.push(m);
        return { id: "msg_1" };
      },
    },
    ...over,
  } as unknown as Env;
}

let env = makeEnv();
let sqlite: Database.Database;

beforeEach(() => {
  let db: ReturnType<typeof createInMemoryDb>["db"];
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.sent = [];
  env = makeEnv();
  // Live sends OFF, the default for every account: Recova's control has no
  // such switch, so the preview must not depend on it.
  sqlite
    .prepare("INSERT INTO accounts (id, name, created_at, live_sends_enabled) VALUES (?, 'Acme', 1000, 0)")
    .run(ACCOUNT);
});

function seedConnection(opts: { senderName?: string | null; replyTo?: string | null } = {}): void {
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, sender_name, reply_to_email, connected_at, created_at) VALUES ('c1', ?, 'acct_s_1', 1, ?, ?, 1000, 1000)",
    )
    .run(ACCOUNT, opts.senderName === undefined ? SENDER : opts.senderName, opts.replyTo === undefined ? REPLY : opts.replyTo);
}

const ctx = {
  get(key: unknown) {
    if (key === cloudflareContext) return { env, ctx: {} as ExecutionContext, nonce: "n" };
    if (key === authContext) {
      return {
        userId: "user_1",
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

async function post(fields: Record<string, string>): Promise<Record<string, unknown>> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = (await action({
    context: ctx,
    request: new Request(`${BASE}/settings/email`, { method: "POST", body: form }),
    params: {},
  } as never)) as unknown as { data: Record<string, unknown> };
  return res.data;
}

function only(): SentMessage {
  expect(harness.sent).toHaveLength(1);
  return harness.sent[0];
}



describe("when it sends: Recova's trigger and not otherwise", () => {
  it("the Send test email control sends one preview to the signed-in user", async () => {
    seedConnection();
    const out = await post({ _action: "test-email" });
    expect(out.ok).toBe(true);
    expect(only().to).toBe(USER_EMAIL);
  });

  it("sends with live sends off, because Recova's control has no such switch", async () => {
    seedConnection();
    const { result } = await sendTestEmail(env, ACCOUNT, USER_EMAIL);
    expect(result.status).toBe("sent");
    expect(harness.sent).toHaveLength(1);
  });

  it("every click sends, as every POST to Recova's route does", async () => {
    seedConnection();
    await post({ _action: "test-email" });
    await post({ _action: "test-email" });
    expect(harness.sent).toHaveLength(2);
  });

  it("saving the sender settings, loading the page, or an unknown action sends nothing", async () => {
    seedConnection();
    await post({ _action: "sender", connectionId: "c1", senderName: "Acme" });
    await post({ _action: "nope" });
    await loader({ context: ctx, request: new Request(`${BASE}/settings/email`), params: {} } as never);
    expect(harness.sent).toHaveLength(0);
  });
});

describe("what it carries", () => {
  it("From the merchant's sender name at Foxhound's recovery sender, Reply-To the saved reply address", async () => {
    seedConnection();
    await sendTestEmail(env, ACCOUNT, USER_EMAIL);
    const m = only();
    expect(m.from).toBe(`${SENDER} <${EMAIL_FROM_ADDRESS}>`);
    expect(EMAIL_FROM_ADDRESS).toMatch(/^recovery@/);
    expect(m.replyTo).toBe(REPLY);
  });

  it("From 'Support' and no Reply-To when neither is saved, as Recova's fallbacks", async () => {
    seedConnection({ senderName: null, replyTo: null });
    await sendTestEmail(env, ACCOUNT, USER_EMAIL);
    const m = only();
    expect(m.from).toMatch(/^Support </);
    expect(m.replyTo).toBeUndefined();
  });

  it("no unsubscribe link, no postal address, no tracking: Recova's preview carries none", async () => {
    seedConnection();
    await sendTestEmail(env, ACCOUNT, USER_EMAIL);
    const m = only();
    for (const part of [m.html, m.text ?? ""]) {
      expect(part).not.toContain("Unsubscribe");
      expect(part).not.toContain(ADDRESS);
      expect(part).not.toContain(`${BASE}/u/`);
      expect(part).not.toContain(`${BASE}/e/`);
      expect(part).not.toContain(`${BASE}/p/`);
    }
    expect(m.headers?.["List-Unsubscribe"]).toBeUndefined();
  });

  it("its one link is the button, to a real Foxhound page", async () => {
    seedConnection();
    await sendTestEmail(env, ACCOUNT, USER_EMAIL);
    const m = only();
    const hrefs = [...m.html.matchAll(/href="([^"]*)"/g)].map((h) => h[1]);
    expect(hrefs).toEqual([`${BASE}/settings/email`]);
    expect(m.text).toContain(`${BASE}/settings/email`);
  });

  it("needs no postal address, since it carries none", async () => {
    seedConnection();
    env = makeEnv({ PHYSICAL_ADDRESS: undefined });
    const { result } = await sendTestEmail(env, ACCOUNT, USER_EMAIL);
    expect(result.status).toBe("sent");
    expect(harness.sent).toHaveLength(1);
  });
});

describe("a refused send returns its named outcome", () => {
  it("a suppressed address: 'suppressed', nothing sent", async () => {
    seedConnection();
    sqlite
      .prepare("INSERT INTO email_suppressions (id, email, token, reason, suppressed_at) VALUES ('s1', ?, 't', 'bounce', 2000)")
      .run(USER_EMAIL);
    const { result } = await sendTestEmail(env, ACCOUNT, USER_EMAIL);
    expect(result.status).toBe("suppressed");
    expect(harness.sent).toHaveLength(0);
    const out = await post({ _action: "test-email" });
    expect(out).toMatchObject({ ok: false, status: "suppressed" });
  });

  it("no EMAIL binding: 'failed', with the reason, and no throw", async () => {
    seedConnection();
    env = makeEnv({ EMAIL: undefined });
    const { result } = await sendTestEmail(env, ACCOUNT, USER_EMAIL);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/EMAIL binding/);
  });

  it("a provider refusal: 'failed', with the provider's words", async () => {
    seedConnection();
    env = makeEnv({
      EMAIL: {
        send: async () => {
          throw new Error("provider said no");
        },
      },
    });
    const { result } = await sendTestEmail(env, ACCOUNT, USER_EMAIL);
    expect(result).toMatchObject({ status: "failed", error: "provider said no" });
  });
});
