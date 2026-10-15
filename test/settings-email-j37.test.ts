import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { SENDER_NAME_MAX_LENGTH } from "~/lib/settings/sender-name";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J37 (job_49a1f499ce53), row S33, under Dustin's Q10 and Q11 rulings of
// 2026-10-14: /settings/email is Recova's page (app/(app)/settings/email/
// page.tsx at blob 62de18af, EmailSectionForm.tsx at blob 57b2fb09,
// settings/components/EmailSection.tsx at blob 3c89ca41 and the SaveBar at
// settings/SaveBar.tsx blob f1d6eb23) built from Capsomer 0.9.0's components,
// teal throughout. Recova stays the spec for every field, label and control
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

const SOURCE = readFileSync(new URL("../app/routes/app/settings/email.tsx", import.meta.url), "utf8");
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

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

function input(html: string, name: string): string {
  return html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0] ?? "";
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

const SENDER_HELP = "Name that appears in the From field of recovery emails";
const REPLY_HELP = "Customer replies go here. Use your support inbox.";
const SAVE_FAILED = "Failed to save. Please try again.";
const TEST_SENT = "Sent! Check your inbox";
const TEST_FAILED = "Failed. Try again.";
const TEST_SUPPRESSED = "Not sent. Your address is blocked after an unsubscribe, bounce or complaint.";

describe("J37 email: the page head", () => {
  it("is Capsomer's PageHead with Recova's title and line", () => {
    const html = render();
    expect(html).toMatch(/<header class="cap-page-head">[\s\S]*<h1 class="cap-page-head-title">Email<\/h1>/);
    expect(html).toContain(
      '<p class="cap-page-head-lead">Configure how recovery emails appear to your customers.</p>',
    );
  });

  it("opens with Recova's phone-only back link to the settings hub", () => {
    const html = render();
    const link = html.match(/<a[^>]*href="\/settings"[^>]*>[\s\S]*?<\/a>/)?.[0] ?? "";
    expect(link).toContain("md:hidden");
    expect(text(link)).toBe("Settings");
    expect(html.indexOf('href="/settings"')).toBeLessThan(html.indexOf("cap-page-head-title"));
  });

  it("sits in the settings layout's 800px column with no width or padding of its own", () => {
    const html = render();
    expect(html).not.toContain("max-w-2xl");
    expect(html).not.toMatch(/class="mx-auto/);
  });
});

describe("J37 email: the card", () => {
  it("is ONE Capsomer panel holding Sender name, Reply-to email and Send test email, in Recova's order", () => {
    const html = render();
    expect(html.match(/<section class="cap-panel">/g)).toHaveLength(1);
    const body = card(html);
    let at = -1;
    for (const label of ["Sender name", "Reply-to email", "Send test email"]) {
      const next = body.indexOf(label);
      expect(next, label).toBeGreaterThan(at);
      at = next;
    }
  });

  it("labels the sender name as a Capsomer field with Recova's placeholder and help under it", () => {
    const html = render();
    const tag = input(html, "senderName");
    expect(attr(tag, "type")).toBe("text");
    expect(attr(tag, "class")).toBe("cap-input");
    expect(attr(tag, "value")).toBe("Alex from Acme");
    expect(attr(tag, "placeholder")).toBe("e.g. Alex from Acme");
    expect(attr(tag, "maxLength") ?? attr(tag, "maxlength")).toBe(String(SENDER_NAME_MAX_LENGTH));
    expect(html).toMatch(new RegExp(`<label class="cap-field-label" for="${attr(tag, "id")}">Sender name</label>`));
    const help = attr(tag, "aria-describedby") ?? "";
    expect(html).toContain(`<p class="cap-field-help" id="${help}">${SENDER_HELP}</p>`);
  });

  it("labels the reply-to as a Capsomer email field with Recova's placeholder and help under it", () => {
    const html = render();
    const tag = input(html, "replyToEmail");
    expect(attr(tag, "type")).toBe("email");
    expect(attr(tag, "class")).toBe("cap-input");
    expect(attr(tag, "value")).toBe("help@acme.test");
    expect(attr(tag, "placeholder")).toBe("support@yourapp.com");
    expect(html).toMatch(new RegExp(`<label class="cap-field-label" for="${attr(tag, "id")}">Reply-to email</label>`));
    const help = attr(tag, "aria-describedby") ?? "";
    expect(html).toContain(`<p class="cap-field-help" id="${help}">${REPLY_HELP}</p>`);
  });

  it("has no Test email heading or sentence of its own: Recova's card ends with the button", () => {
    const html = render();
    expect(html).not.toMatch(/<h2[^>]*>Test email<\/h2>/);
    expect(text(html)).not.toContain("Sends a sample recovery email");
  });

  it("draws Send test email as a Capsomer default button inside the card", () => {
    const button = testButton(render());
    expect(button).toContain('class="cap-btn"');
    expect(button).not.toContain("data-variant");
    expect(text(button)).toBe("Send test email");
  });

  it("posts the test email through its own form, so Enter in a field never sends one", () => {
    const html = render();
    const button = testButton(html);
    expect(attr(button, "type")).toBe("submit");
    const formId = attr(button, "form") ?? "";
    expect(formId).not.toBe("");
    // That form carries the test-email intent and nothing typed: the address is
    // the session user's (RULES.md 4.7).
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

  it("says each outcome ON the button, as Recova does, in the button's own words", () => {
    const sent = testButton(render({ actionData: { action: "test-email", ok: true, status: "sent" } }));
    expect(text(sent)).toBe(TEST_SENT);

    const failed = testButton(render({ actionData: { action: "test-email", ok: false, status: "failed" } }));
    expect(text(failed)).toBe(TEST_FAILED);
  });

  it("puts no 12px status inside the button, which measured 4.18:1 in dark", () => {
    const sent = testButton(render({ actionData: { action: "test-email", ok: true, status: "sent" } }));
    expect(sent).not.toContain("cap-status");
  });

  it("says a suppressed address truly, not Recova's 'Try again', which would not help", () => {
    const html = render({ actionData: { action: "test-email", ok: false, status: "suppressed" } });
    expect(text(testButton(html))).toBe(TEST_SUPPRESSED);
  });

  it("announces the outcome in a live region that is on the page from the start", () => {
    const idle = render();
    const region = (html: string) => card(html).match(/<span[^>]*role="status"[^>]*>([\s\S]*?)<\/span>/);
    expect(region(idle)).not.toBeNull();
    expect(region(idle)?.[1]).toBe("");
    const sent = render({ actionData: { action: "test-email", ok: true, status: "sent" } });
    expect(text(region(sent)?.[1] ?? "")).toBe(TEST_SENT);
  });

  it("a test-email result never says Saved", () => {
    const html = render({ actionData: { action: "test-email", ok: true, status: "sent" } });
    const bar = html.slice(html.indexOf("</section>"));
    expect(text(bar)).not.toContain("Saved");
  });
});

describe("J37 email: the save bar", () => {
  it("sits under the card, outside it, with Recova's Save changes as the primary button", () => {
    const html = render();
    const after = html.slice(html.indexOf("</section>"));
    const button = after.match(/<button[^>]*>Save changes<\/button>/)?.[0] ?? "";
    expect(button).toContain('type="submit"');
    expect(button).toContain('class="cap-btn"');
    expect(button).toContain('data-variant="primary"');
    expect(after).toMatch(/class="[^"]*justify-end[^"]*"/);
  });

  it("says Saved beside the button after a save, as a Capsomer ok status in a live region", () => {
    const html = render({ actionData: { action: "sender", ok: true } });
    const bar = html.slice(html.indexOf("</section>"));
    expect(bar).toMatch(/role="status"[\s\S]*class="cap-status" data-tone="ok"[\s\S]*Saved/);
    expect(bar.indexOf("Saved")).toBeLessThan(bar.indexOf("Save changes"));
    expect(html).not.toContain("cap-alert");
  });

  it("keeps the live region on the page before anything is said", () => {
    const bar = render().slice(render().indexOf("</section>"));
    expect(bar).toContain('role="status"');
    expect(text(bar)).toBe("Save changes");
  });

  it("puts a refused sender name beside its field", () => {
    const error = `Sender name must be ${SENDER_NAME_MAX_LENGTH} characters or fewer.`;
    const html = render({ actionData: { action: "sender", ok: false, error, field: "senderName" } });
    const tag = input(html, "senderName");
    expect(attr(tag, "aria-invalid")).toBe("true");
    const errorId = (attr(tag, "aria-describedby") ?? "").split(" ")[0];
    expect(html).toContain(`id="${errorId}" role="alert">${error}</p>`);
    expect(text(html.slice(html.indexOf("</section>")))).toBe("Save changes");
  });

  it("puts a refused reply-to beside its field", () => {
    const error = "Enter a valid reply-to email address.";
    const html = render({ actionData: { action: "sender", ok: false, error, field: "replyToEmail" } });
    const tag = input(html, "replyToEmail");
    expect(attr(tag, "aria-invalid")).toBe("true");
    const errorId = (attr(tag, "aria-describedby") ?? "").split(" ")[0];
    expect(html).toContain(`id="${errorId}" role="alert">${error}</p>`);
  });
});

describe("J37 email: the look comes from Capsomer and the tokens", () => {
  it("has no amber and no hand-sized text", () => {
    expect(CODE).not.toMatch(/amber/i);
    expect(CODE).not.toMatch(/text-\[/);
  });

  it("styles no Capsomer component with Foxhound classes of its own", () => {
    for (const m of CODE.matchAll(/className="(cap-[^"]*)"/g)) {
      for (const cls of m[1].split(/\s+/)) expect(cls).toMatch(/^cap-/);
    }
  });

  it("uses the shared settings back link, not a local copy", () => {
    expect(SOURCE).toContain('import { SettingsBackLink } from "~/components/settings-back-link";');
    expect(CODE).not.toMatch(/function SettingsBackLink/);
  });

  it("no longer uses the auth screens' Alert", () => {
    expect(CODE).not.toContain("~/components/auth-ui");
  });

  it("loads each Capsomer stylesheet it uses", () => {
    for (const css of ["page-head", "panel", "field", "button", "status"]) {
      expect(SOURCE).toContain(`import "capsomer/${css}.css";`);
    }
  });
});

// ---------------------------------------------------------------------------
// The suppressed sentence is true only while these are the ways an address
// gets suppressed. If another is added, this fails and the sentence changes.
// ---------------------------------------------------------------------------

describe("J37 email: the suppressed sentence matches the engine", () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

  it("an address is suppressed by an unsubscribe, a bounce or a complaint, and nothing else", () => {
    expect(read("app/lib/email/suppression.ts")).toContain('export const UNSUBSCRIBE_REASON = "unsubscribe";');
    expect(read("app/lib/email/events.ts")).toContain(
      'const SUPPRESSING_TYPES = new Set(["bounce", "hard_bounce", "complaint", "spam"]);',
    );
  });

  it("the page says so", () => {
    expect(SOURCE).toContain(TEST_SUPPRESSED);
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

  it("a send the provider refuses shows the button's failure line", async () => {
    env = makeEnv({ EMAIL: undefined });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({ _action: "test-email" });
    expect(res.data).toMatchObject({ action: "test-email", ok: false, status: "failed" });
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
