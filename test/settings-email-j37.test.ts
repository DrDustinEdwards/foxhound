import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { SENDER_NAME_MAX_LENGTH } from "~/lib/settings/sender-name";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J37, row S33, under Dustin's Q10 and Q11 rulings of
// 2026-10-14: /settings/email is Recova's page (app/(app)/settings/email/
// page.tsx at blob 62de18af, EmailSectionForm.tsx at blob 57b2fb09,
// settings/components/EmailSection.tsx at blob 3c89ca41 and the SaveBar at
// settings/SaveBar.tsx blob f1d6eb23) built from Capsomer 0.9.0's components,
// amber throughout. Recova stays the spec for every field, label and control
// and their order: the phone-only back link, the title and its line, one card
// holding Sender name, Reply-to email and the Send test email button (sender
// domain is not built, RULES.md 5.6), and under the card, right-aligned, Saved
// or the failure sentence beside Save changes.
//
// The writes, the bound, the From header and the preview itself stay pinned in
// settings-email-s33 and settings-test-email-e3. Every assertion here was seen
// failing before the rebuild.

interface SentMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
}

const harness = vi.hoisted(() => ({ db: null as unknown, sent: [] as SentMessage[] }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const route = await import("~/routes/app/settings/email");


const Page = route.default as unknown as (props: {
  loaderData: Record<string, unknown>;
  actionData?: Record<string, unknown>;
}) => ReactElement;

const LOADED = {
  connectionId: "c1",
  senderName: "Alex from Acme",
  replyToEmail: "help@acme.test",
};

function render(opts: { loaderData?: Record<string, unknown>; actionData?: Record<string, unknown> } = {}): string {
  const loaderData = { ...LOADED, ...(opts.loaderData ?? {}) };
  const Stub = createRoutesStub([
    {
      path: "/settings/email",
      Component: () => createElement(Page, { loaderData, actionData: opts.actionData }),
    },
  ]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/settings/email"] }));
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}


function attr(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
}

/** The one panel's markup. */
function card(html: string): string {
  return html.slice(html.indexOf('<section class="cap-panel">'), html.indexOf("</section>"));
}

/** The Send test email button, whatever its label. */
function testButton(html: string): string {
  return card(html).match(/<button[^>]*form="[^"]*"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";
}

const SAVE_FAILED = "Failed to save. Please try again.";
const TEST_SENT = "Sent! Check your inbox";
const TEST_FAILED = "Failed. Try again.";
const TEST_SUPPRESSED = "Not sent. Your address is blocked after an unsubscribe, bounce or complaint.";

describe("J37 email: the card", () => {

  it("posts the test email through its own form, so Enter in a field never sends one", () => {
    const html = render();
    const button = testButton(html);
    expect(attr(button, "type")).toBe("submit");
    const formId = attr(button, "form") ?? "";
    expect(formId).not.toBe("");
    // That form carries the test-email intent and nothing typed: the address is
    // the session user's.
    const form = html.match(new RegExp(`<form[^>]*id="${formId}"[^>]*>[\\s\\S]*?</form>`))?.[0] ?? "";
    expect(form).toContain('name="_action" value="test-email"');
    expect(form).not.toMatch(/name="(to|email|recipient)"/);
    // The main form's only submit button is Save changes, so it is the one an
    // Enter key presses.
    const main = html.match(/<form[^>]*>[\s\S]*?<\/form>/)?.[0] ?? "";
    const mainSubmits = [...main.matchAll(/<button[^>]*type="submit"[^>]*>/g)].filter((m) => !m[0].includes(' form="'));
    expect(mainSubmits).toHaveLength(1);
    expect(main).toContain('name="_action" value="sender"');
  });
});

// ---------------------------------------------------------------------------
// The action, driven for real, and the page rendering what it returned.
// ---------------------------------------------------------------------------

const ACCOUNT = "acct_1";
const USER_EMAIL = "owner@acme.test";
let sqlite: Database.Database;
let env: Env;

function makeEnv(over: Record<string, unknown> = {}): Env {
  return {
    ENCRYPTION_KEY: "ab".repeat(32),
    BETTER_AUTH_URL: "https://foxhoundapp.test",
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

function ctx() {
  return {
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
  } as never;
}

async function post(fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return (await route.action({
    context: ctx(),
    request: new Request("https://foxhoundapp.test/settings/email", { method: "POST", body: form }),
    params: {},
  } as never)) as unknown as { data: Record<string, unknown>; init?: { status?: number } };
}

const THROWING_DB = new Proxy(
  {},
  {
    get() {
      throw new Error("D1 unavailable");
    },
  },
);

describe("J37 email: the loader and the action", () => {
  beforeEach(() => {
    const made = createInMemoryDb();
    sqlite = made.sqlite;
    harness.db = made.db;
    harness.sent = [];
    env = makeEnv();
    sqlite
      .prepare("INSERT INTO accounts (id, name, created_at, live_sends_enabled) VALUES (?, 'Acme', 1000, 0)")
      .run(ACCOUNT);
    sqlite
      .prepare(
        "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, sender_name, reply_to_email, connected_at, created_at) VALUES ('c1', ?, 'acct_s_1', 1, 'Alex from Acme', NULL, 1000, 1000)",
      )
      .run(ACCOUNT);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers a failed sender write with Recova's failure line, logging the whole error", async () => {
    harness.db = THROWING_DB;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({ _action: "sender", connectionId: "c1", senderName: "Acme" });
    expect(res.init?.status).toBe(500);
    expect(res.data).toEqual({ action: "sender", ok: false, failed: true });
    const err = logged.mock.calls[0]?.[1];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("D1 unavailable");
    // What the real action returned is what the page says.
    const bar = render({ actionData: res.data }).split("</section>")[1] ?? "";
    expect(bar).toMatch(new RegExp(`class="cap-status" data-tone="crit"[\\s\\S]*${SAVE_FAILED}`));
  });

  it("answers a test email that throws with the button's failure line, logging the whole error", async () => {
    harness.db = THROWING_DB;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({ _action: "test-email" });
    expect(res.init?.status).toBe(500);
    expect(res.data).toEqual({ action: "test-email", ok: false, status: "failed" });
    const err = logged.mock.calls[0]?.[1];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("D1 unavailable");
    expect(text(testButton(render({ actionData: res.data })))).toBe(TEST_FAILED);
  });

  it("a suppressed address shows the suppressed sentence", async () => {
    sqlite
      .prepare("INSERT INTO email_suppressions (id, email, token, reason, suppressed_at) VALUES ('s1', ?, 't', 'bounce', 2000)")
      .run(USER_EMAIL);
    const res = await post({ _action: "test-email" });
    expect(res.data).toMatchObject({ action: "test-email", ok: false, status: "suppressed" });
    expect(text(testButton(render({ actionData: res.data })))).toBe(TEST_SUPPRESSED);
  });

  it("a sent preview shows Recova's sent line and went to the signed-in user", async () => {
    const res = await post({ _action: "test-email" });
    expect(res.data).toEqual({ action: "test-email", ok: true, status: "sent" });
    expect(harness.sent.map((m) => m.to)).toEqual([USER_EMAIL]);
    expect(text(testButton(render({ actionData: res.data })))).toBe(TEST_SENT);
  });

  it("names the sender name field on its refusal, so the page puts it beside that field", async () => {
    const res = await post({ _action: "sender", connectionId: "c1", senderName: "x".repeat(SENDER_NAME_MAX_LENGTH + 1) });
    expect(res.init?.status).toBe(400);
    expect(res.data).toMatchObject({ action: "sender", ok: false, field: "senderName" });
  });

  it("names the reply-to field on its refusal", async () => {
    const res = await post({ _action: "sender", connectionId: "c1", senderName: "Acme", replyToEmail: "not an address" });
    expect(res.init?.status).toBe(400);
    expect(res.data).toMatchObject({ action: "sender", ok: false, field: "replyToEmail" });
  });

  it("says a missing Stripe connection in the save bar, since it belongs to no field", async () => {
    const res = await post({ _action: "sender", connectionId: "", senderName: "Acme" });
    expect(res.init?.status).toBe(400);
    expect(res.data.field).toBeUndefined();
    const bar = render({ actionData: res.data }).split("</section>")[1] ?? "";
    expect(text(bar)).toContain("Connect Stripe before setting a sender name.");
  });

  it("a saved name shows Saved", async () => {
    const res = await post({ _action: "sender", connectionId: "c1", senderName: "Acme" });
    expect(res.data).toEqual({ action: "sender", ok: true });
    const bar = render({ actionData: res.data }).split("</section>")[1] ?? "";
    expect(text(bar)).toContain("Saved");
  });
});
