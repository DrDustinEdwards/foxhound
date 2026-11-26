import type Database from "better-sqlite3";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { SENDER_NAME_MAX_LENGTH } from "~/lib/settings/sender-name";
import { EXPIRING_CARD_DAYS_AHEAD } from "~/lib/constants";

import { createInMemoryDb } from "./helpers/inmemory-db";

interface SentMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
}

const harness = vi.hoisted(() => ({ db: null as unknown, sent: [] as SentMessage[] }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const emailRoute = await import("~/routes/app/settings/email");
const { action, loader } = emailRoute;
const { buildEmailMessage } = await import("~/lib/email/send");
const { toEmailContext } = await import("~/lib/cron/due-steps");
const { buildRecoveryEmailJob } = await import("~/lib/engine/execute-step");
const { EMAIL_FROM_ADDRESS } = await import("~/lib/email/constants");

const BASE = "https://foxhoundapp.test";
const ACCOUNT = "acct_1";
const OTHER = "acct_other";
const USER_EMAIL = "owner@acme.test";

let sqlite: Database.Database;
let env: Env;

function makeEnv(over: Record<string, unknown> = {}): Env {
  return {
    ENCRYPTION_KEY: "ab".repeat(32),
    BETTER_AUTH_URL: BASE,
    PHYSICAL_ADDRESS: "1 Test Way, Austin TX",
    EMAIL: {
      send: async (m: SentMessage) => {
        harness.sent.push(m);
        return { id: "msg_1" };
      },
    },
    ...over,
  } as unknown as Env;
}

beforeEach(() => {
  const made = createInMemoryDb();
  sqlite = made.sqlite;
  harness.db = made.db;
  harness.sent = [];
  env = makeEnv();
  // Live sends are off, the default: the preview must not depend on them.
  for (const [id, name] of [
    [ACCOUNT, "Acme"],
    [OTHER, "Someone else"],
  ]) {
    sqlite
      .prepare(
        "INSERT INTO accounts (id, name, created_at, live_sends_enabled) VALUES (?, ?, 1000, 0)",
      )
      .run(id, name);
  }
});

function seedConnection(opts: {
  id: string;
  accountId?: string;
  senderName?: string | null;
  replyTo?: string | null;
  disconnectedAt?: number | null;
}): void {
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, sender_name, reply_to_email, connected_at, disconnected_at, created_at) VALUES (?, ?, ?, 1, ?, ?, 1000, ?, 1000)",
    )
    .run(
      opts.id,
      opts.accountId ?? ACCOUNT,
      "acct_stripe_" + opts.id,
      opts.senderName ?? null,
      opts.replyTo ?? null,
      opts.disconnectedAt ?? null,
    );
}

function connectionRow(id: string) {
  return sqlite
    .prepare(
      "SELECT sender_name AS senderName, reply_to_email AS replyTo FROM stripe_connections WHERE id = ?",
    )
    .get(id) as { senderName: string | null; replyTo: string | null };
}

const ctx = {
  get(key: unknown) {
    if (key === cloudflareContext) return { env, ctx: {} as ExecutionContext };
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

async function post(
  fields: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = (await action({
    context: ctx,
    request: new Request(`${BASE}/settings/email`, { method: "POST", body: form }),
    params: {},
  } as never)) as unknown as { data: Record<string, unknown>; init?: { status?: number } };
  return { status: res.init?.status ?? 200, body: res.data };
}

describe("sender settings", () => {
  beforeEach(() => seedConnection({ id: "c1" }));

  it("saves the sender name and reply-to on the connection", async () => {
    const res = await post({
      _action: "sender",
      connectionId: "c1",
      senderName: "Acme",
      replyToEmail: "help@acme.test",
    });
    expect(res.body).toEqual({ action: "sender", ok: true });
    expect(connectionRow("c1")).toEqual({ senderName: "Acme", replyTo: "help@acme.test" });
  });

  it("refuses a connection on another account and writes nothing", async () => {
    seedConnection({ id: "c_theirs", accountId: OTHER, senderName: "Theirs" });
    const res = await post({ _action: "sender", connectionId: "c_theirs", senderName: "Hijacked" });
    expect(res.status).toBe(400);
    expect(connectionRow("c_theirs").senderName).toBe("Theirs");
  });

  it("names the refused field: a too-long name, a bad reply-to, or a missing connection", async () => {
    const long = await post({
      _action: "sender",
      connectionId: "c1",
      senderName: "x".repeat(SENDER_NAME_MAX_LENGTH + 1),
    });
    expect(long.status).toBe(400);
    expect(long.body).toMatchObject({ field: "senderName" });

    const reply = await post({
      _action: "sender",
      connectionId: "c1",
      senderName: "Acme",
      replyToEmail: "not an address",
    });
    expect(reply.status).toBe(400);
    expect(reply.body).toMatchObject({ field: "replyToEmail" });

    const none = await post({ _action: "sender", connectionId: "", senderName: "Acme" });
    expect(none.status).toBe(400);
    expect(none.body.field).toBeUndefined();
    expect(String(none.body.error)).toContain("Connect Stripe");
    expect(connectionRow("c1")).toEqual({ senderName: null, replyTo: null });
  });

  it("the loader hands the form the primary live connection, never a disconnected one", async () => {
    sqlite.prepare("DELETE FROM stripe_connections").run();
    // Disconnecting leaves is_primary set; the loader must not hand back a severed connection.
    seedConnection({ id: "c_gone", senderName: "Old", disconnectedAt: 500 });
    const loaded = (await loader({
      context: ctx,
      request: new Request(`${BASE}/settings/email`),
      params: {},
    } as never)) as { connectionId: string | null; senderName: string };
    expect(loaded.connectionId).toBeNull();
    expect(loaded.senderName).toBe("");
  });

  it("the saved name becomes the From header, and the 'your subscription' body fallback never does", () => {
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
    const fromHeaderFor = (merchantName: string | null) => {
      const job = buildRecoveryEmailJob(
        toEmailContext({ ...row, merchantName } as never),
        { subject: "s", bodyHtml: "<p>b</p>" },
        {
          unsubscribeToken: "tok",
          physicalAddress: "1 Test Way",
          openUrl: "https://x/o",
          honeypotUrl: "https://x/h",
        },
      );
      return buildEmailMessage(job, BASE).from;
    };
    expect(toEmailContext({ ...row } as never).merchantName).toBe("your subscription");
    expect(fromHeaderFor(null)).not.toContain("your subscription");
    expect(fromHeaderFor("Alex from Acme")).toContain("Alex from Acme");
  });
});

describe("send test email", () => {
  beforeEach(() =>
    seedConnection({ id: "c1", senderName: "Alex from Acme", replyTo: "help@acme.test" }),
  );

  it("sends one preview to the session user, from the saved sender name, and logs it", async () => {
    const res = await post({ _action: "test-email" });

    expect(res.body).toEqual({ action: "test-email", ok: true, status: "sent" });
    expect(harness.sent).toHaveLength(1);
    const m = harness.sent[0];
    expect(m.to).toBe(USER_EMAIL);
    expect(m.from).toBe(`Alex from Acme <${EMAIL_FROM_ADDRESS}>`);
    expect(m.replyTo).toBe("help@acme.test");
    expect(m.subject.startsWith("[PREVIEW] ")).toBe(true);
    const rows = sqlite.prepare("SELECT status FROM email_sends WHERE account_id = ?").all(ACCOUNT);
    expect(rows).toEqual([{ status: "sent" }]);
  });

  it("a suppressed address sends nothing and says so", async () => {
    sqlite
      .prepare(
        "INSERT INTO email_suppressions (id, email, token, reason, suppressed_at) VALUES ('s1', ?, 't', 'bounce', 2000)",
      )
      .run(USER_EMAIL);
    const out = await post({ _action: "test-email" });
    expect(out.body).toMatchObject({ ok: false, status: "suppressed" });
    expect(harness.sent).toHaveLength(0);
  });
});

describe("the expiring-card toggle", () => {
  it("names what it stops: Foxhound's own email, sent the lead days before expiry", async () => {
    const Page = emailRoute.default as unknown as (props: {
      loaderData: Awaited<ReturnType<typeof loader>>;
      actionData: undefined;
    }) => ReactElement;
    const loaderData = await loader({
      context: ctx,
      request: new Request(`${BASE}/settings/email`),
      params: {},
    } as never);
    const Stub = createRoutesStub([
      {
        path: "/settings/email",
        Component: () => createElement(Page, { loaderData, actionData: undefined }),
      },
    ]);
    const html = renderToStaticMarkup(createElement(Stub, { initialEntries: ["/settings/email"] }));
    expect(html).toContain(
      `Email customers ${EXPIRING_CARD_DAYS_AHEAD} days before their card expires`,
    );
    expect(html).not.toContain("Expiring card alerts");
  });
});
