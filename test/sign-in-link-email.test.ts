import type Database from "better-sqlite3";
import { magicLink, renderEmail } from "capsomer/email";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EMAIL_AUTH_SENDER_ADDRESS } from "~/lib/constants";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J82, parity row E1, now the sign-in link (the family sign-in has no
// passwords, so the reset mail is gone; APPROVED-DIFFERENCES, "Sign-in and
// invites", 2026-10-24). Recova's auth mail was a Supabase dashboard template,
// not in its repo, so this claims nothing about parity. It pins three things:
// the mail is Capsomer's `magicLink` template carrying Better Auth's link, it is
// sent when /login or /signup asks for a link, and every refused send comes
// back as a named outcome, with the link never logged. Every assertion on
// content reads the message as it reaches env.EMAIL.send.

interface SentMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

const harness = vi.hoisted(() => ({ db: null as unknown, renderThrows: false }));

// Lets one test make the render throw, to prove the send still answers by name
// instead of throwing. Off everywhere else, so the real render runs.
vi.mock("~/lib/email/templates", async (importOriginal) => {
  const real = await importOriginal<typeof import("~/lib/email/templates")>();
  return {
    ...real,
    renderFoxhoundSignInLinkEmail: (input: Parameters<typeof real.renderFoxhoundSignInLinkEmail>[0]) => {
      if (harness.renderThrows) throw new Error(`render broke on ${input.url}`);
      return real.renderFoxhoundSignInLinkEmail(input);
    },
  };
});

// auth.server.ts builds its Drizzle adapter from getDb(env); hand it the real
// schema in memory instead of a D1 binding.
vi.mock("~/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db/client")>()),
  getDb: () => harness.db,
}));

const { requestSignInLink } = await import("~/lib/auth/sign-in-link.server");
const { sendSignInLinkEmail } = await import("~/lib/auth/send-auth-email");

const BASE = "https://foxhoundapp.com";
const TO = "jane@example.com";
const TOKEN = "EXAMPLE-NOT-A-TOKEN";
const URL_FIXTURE = `${BASE}/api/auth/magic-link/verify?token=${TOKEN}&callbackURL=%2Fconsole`;

function expectedRender(to: string, url: string) {
  return renderEmail(magicLink, { brand: { name: "Foxhound", family: "amber" }, to, url, expiresIn: "5 minutes" });
}

let sqlite: Database.Database;
let sent: SentMessage[];

function makeEnv(email: unknown = { send: async (m: SentMessage) => (sent.push(m), { id: "msg_1" }) }): Env {
  return {
    BETTER_AUTH_URL: BASE,
    BETTER_AUTH_SECRET: "test-secret-not-real-0123456789abcdef",
    DB: {},
    EMAIL: email,
  } as unknown as Env;
}

/** Every string any console method was called with, errors included. */
function consoleSpies() {
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
  return () =>
    spies
      .flatMap((s) => s.mock.calls.flat())
      .map((a) => (a instanceof Error ? `${a.name} ${a.message} ${a.stack ?? ""}` : String(a)))
      .join("\n");
}

beforeEach(() => {
  let db: ReturnType<typeof createInMemoryDb>["db"];
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.renderThrows = false;
  sent = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** What /login sends: the page's own path to Better Auth's handler. */
function ask(env: Env, email = TO) {
  return requestSignInLink(env, new Request(`${BASE}/login`, { method: "POST", headers: { origin: BASE } }), {
    email,
    captchaToken: "",
    next: "/console",
    newUserNext: "/console",
  });
}

function linkTokens(): string[] {
  return (
    sqlite.prepare("SELECT identifier FROM verification WHERE identifier LIKE 'magic-link:%'").all() as {
      identifier: string;
    }[]
  ).map((r) => r.identifier.slice("magic-link:".length));
}

describe("E1: the sign-in link is sent when a page asks for one", () => {
  it("one mail to the address, rendered by Capsomer's magic-link template, carrying Better Auth's link", async () => {
    expect(await ask(makeEnv())).toBe("sent");

    expect(sent).toHaveLength(1);
    const m = sent[0];
    expect(m.to).toBe(TO);
    const hrefs = [...m.html.matchAll(/<a\b[^>]*href="([^"]*)"/g)].map((x) => x[1]);
    expect(hrefs).toHaveLength(1);
    const raw = hrefs[0].replace(/&amp;/g, "&");
    const href = new URL(raw);
    expect(href.origin + href.pathname).toBe(`${BASE}/api/auth/magic-link/verify`);
    // The token is the one Better Auth stored, and the link lands on the
    // passkey offer, which goes on to /console.
    expect(linkTokens()).toEqual([href.searchParams.get("token")]);
    expect(href.searchParams.get("callbackURL")).toBe(`${BASE}/passkey?next=%2Fconsole`);
    expect(href.searchParams.get("errorCallbackURL")).toBe(`${BASE}/login`);

    const want = expectedRender(TO, raw);
    expect(m.subject).toBe(want.subject);
    expect(m.html).toBe(want.html);
    expect(m.text).toBe(want.text);
  });
});

describe("E1: what the sign-in link mail says and carries", () => {

  it("comes from Foxhound at the auth sender, with no Reply-To, footer, unsubscribe or tracking", async () => {
    await sendSignInLinkEmail(makeEnv(), { to: TO, url: URL_FIXTURE, token: TOKEN });
    const m = sent[0];
    expect(m.from).toBe(`Foxhound <${EMAIL_AUTH_SENDER_ADDRESS}>`);
    expect(m.to).toBe(TO);
    expect(Object.keys(m).sort()).toEqual(["from", "html", "subject", "text", "to"]);
    expect(m.headers).toBeUndefined();
    for (const part of [m.html, m.text ?? ""]) {
      expect(part).not.toMatch(/unsubscribe/i);
      expect(part).not.toContain("/u/");
      expect(part).not.toContain("/t/");
      expect(part).not.toMatch(/<img\b/i);
    }
    // One link only, in each part: the sign-in link.
    expect([...m.html.matchAll(/https?:\/\//g)]).toHaveLength(1);
    expect([...(m.text ?? "").matchAll(/https?:\/\//g)]).toHaveLength(1);
  });
});

describe("E1: a refused send comes back named, and the link is never logged", () => {
  it("no EMAIL binding: email_binding_missing", async () => {
    const logged = consoleSpies();
    const outcome = await sendSignInLinkEmail(makeEnv(null), { to: TO, url: URL_FIXTURE, token: TOKEN });
    expect(outcome).toEqual({ status: "failed", reason: "email_binding_missing", error: null });
    expect(logged()).not.toContain("EXAMPLE-NOT-A-TOKEN");
  });

  it("the binding throws: provider_error, with the link, token and recipient scrubbed from the error", async () => {
    const logged = consoleSpies();
    const env = makeEnv({
      send: async () => {
        throw new Error(`rejected message to ${TO} with link ${URL_FIXTURE} and token ${TOKEN}`);
      },
    });
    const outcome = await sendSignInLinkEmail(env, { to: TO, url: URL_FIXTURE, token: TOKEN });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.reason).toBe("provider_error");
    expect(outcome.error).toContain("rejected message to");
    expect(outcome.error).not.toContain("EXAMPLE-NOT-A-TOKEN");
    expect(outcome.error).not.toContain(TO);
    expect(logged()).not.toContain("EXAMPLE-NOT-A-TOKEN");
  });

  it("a link Capsomer refuses (not https): link_refused, nothing sent", async () => {
    const outcome = await sendSignInLinkEmail(makeEnv(), {
      to: TO,
      url: "http://localhost:5173/api/auth/magic-link/verify?token=EXAMPLE-NOT-A-TOKEN",
      token: TOKEN,
    });
    expect(outcome).toEqual({ status: "failed", reason: "link_refused", error: null });
    expect(sent).toHaveLength(0);
  });

  it("an https link whose render throws: render_failed, nothing sent, nothing thrown", async () => {
    harness.renderThrows = true;
    const outcome = await sendSignInLinkEmail(makeEnv(), { to: TO, url: URL_FIXTURE, token: TOKEN });
    expect(outcome).toEqual({ status: "failed", reason: "render_failed", error: null });
    expect(sent).toHaveLength(0);
  });

  it("through the page, a refused send is surfaced by name and the link never reaches a log", async () => {
    const logged = consoleSpies();
    const env = makeEnv({
      send: async (m: SentMessage) => {
        throw new Error(`provider echoed ${m.text}`);
      },
    });
    expect(await ask(env)).toBe("failed");

    const [token] = linkTokens();
    const out = logged();
    expect(out).toContain("sign-in link email not sent: provider_error");
    expect(out).not.toContain(token);
  });
});
