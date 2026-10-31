import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { SIGN_IN_EXPIRES_IN_WORDS } from "@dustinedwards/site-runtime/sign-in";
import { magicLink, renderEmail } from "capsomer/email";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cloudflareContext } from "~/lib/cloudflare-context";
import { EMAIL_AUTH_SENDER_ADDRESS } from "~/lib/constants";

import { createInMemoryDb } from "./helpers/inmemory-db";
import { makeRateLimiterNamespace } from "./helpers/rate-limiter";

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

const { requestSignInLink, signInWithCode } = await import("~/lib/auth/sign-in-link.server");
const { sendSignInLinkEmail } = await import("~/lib/auth/send-auth-email");

const BASE = "https://foxhoundapp.com";
const TO = "jane@example.com";
const TOKEN = "EXAMPLE-NOT-A-TOKEN";
const URL_FIXTURE = `${BASE}/api/auth/magic-link/verify?token=${TOKEN}&callbackURL=%2Fconsole`;
const CODE = "000000";

function expectedRender(to: string, url: string, code: string) {
  return renderEmail(magicLink, { brand: { name: "Foxhound", family: "amber" }, to, url, code, expiresIn: SIGN_IN_EXPIRES_IN_WORDS });
}

let sqlite: Database.Database;
let sent: SentMessage[];

function makeEnv(email: unknown = { send: async (m: SentMessage) => (sent.push(m), { id: "msg_1" }) }): Env {
  return {
    BETTER_AUTH_URL: BASE,
    BETTER_AUTH_SECRET: "test-secret-not-real-0123456789abcdef",
    // site-runtime's sign-in fails closed without both Turnstile keys, as production has them. Cloudflare's
    // always-pass test keys; siteverify itself is stubbed below.
    TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
    TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
    // The per-address code limiter refuses without its Durable Object (site-runtime 0.51).
    AUTH_RATE_LIMITER: makeRateLimiterNamespace(),
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
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    String(input instanceof Request ? input.url : input).startsWith("https://challenges.cloudflare.com/")
      ? Promise.resolve(Response.json({ success: true }))
      : realFetch(input, init),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** What /login sends: the page's own path to Better Auth's handler. */
function ask(env: Env, email = TO) {
  return requestSignInLink(env, new Request(`${BASE}/login`, { method: "POST", headers: { origin: BASE } }), {
    email,
    captchaToken: "XXXX.DUMMY.TOKEN.XXXX",
    next: "/console",
    newUserNext: "/console",
  });
}

/** The six-digit code the mail's text part carries on its own line. */
function codeIn(m: SentMessage): string {
  const found = /\n {4}(\d{6})\n/.exec(m.text ?? "");
  if (!found) throw new Error("no code in the mail");
  return found[1];
}

/** A typed code from `ip` (Better Auth limits a code to three tries a minute
 *  from one address, beside the code's own three). */
function typeCode(env: Env, code: string, ip = "203.0.113.1") {
  const headers = { origin: BASE, "cf-connecting-ip": ip };
  return signInWithCode(env, new Request(`${BASE}/login?code`, { method: "POST", headers }), { email: TO, code });
}

function linkTokens(): string[] {
  return (
    sqlite.prepare("SELECT identifier FROM verification WHERE identifier LIKE 'magic-link:%'").all() as {
      identifier: string;
    }[]
  ).map((r) => r.identifier.slice("magic-link:".length));
}

describe("E1: the sign-in link is sent when a page asks for one", () => {
  it("one mail to the address, rendered by Capsomer's magic-link template, carrying the confirm page's link", async () => {
    expect(await ask(makeEnv())).toBe("sent");

    expect(sent).toHaveLength(1);
    const m = sent[0];
    expect(m.to).toBe(TO);
    const hrefs = [...m.html.matchAll(/<a\b[^>]*href="([^"]*)"/g)].map((x) => x[1]);
    expect(hrefs).toHaveLength(1);
    const raw = hrefs[0].replace(/&amp;/g, "&");
    const href = new URL(raw);
    // The link opens the confirm page, whose button signs in (site-runtime
    // ./sign-in). Better Auth stores the token hashed (SHA-256, base64url), and
    // the link lands on the passkey offer, which goes on to /console.
    expect(href.origin + href.pathname).toBe(`${BASE}/sign-in/confirm`);
    const token = href.searchParams.get("token") ?? "";
    expect(linkTokens()).toEqual([createHash("sha256").update(token).digest("base64url")]);
    expect(href.searchParams.get("callbackURL")).toBe(`${BASE}/passkey?next=%2Fconsole`);
    expect(href.searchParams.get("errorCallbackURL")).toBe(`${BASE}/sign-in/confirm`);

    const want = expectedRender(TO, raw, codeIn(m));
    expect(m.subject).toBe(want.subject);
    expect(m.html).toBe(want.html);
    expect(m.text).toBe(want.text);
  });
});

describe("the mailed link opens /sign-in/confirm, and only its button signs in", () => {
  it("the page's POST to the mailed URL makes the session and goes on to the passkey offer; the token works once", async () => {
    const env = makeEnv();
    await ask(env);
    const link = sent[0].html.match(/<a\b[^>]*href="([^"]*)"/)![1].replace(/&amp;/g, "&");
    const { action } = await import("~/routes/auth/sign-in-confirm");
    const context = { get: (key: unknown) => (key === cloudflareContext ? { env } : undefined) };
    // Better Auth's redirect is a Response; only its 429 comes back as data.
    const press = async () =>
      (await action({
        request: new Request(link, { method: "POST" }),
        context,
      } as unknown as Parameters<typeof action>[0])) as Response;

    const first = await press();
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe(`${BASE}/passkey?next=%2Fconsole`);
    expect(first.headers.getSetCookie().join(";")).toContain("session_token");
    const again = await press();
    expect(again.headers.get("location")).toContain("error=");
    expect(again.headers.getSetCookie().join(";")).not.toContain("session_token=");
  });
});

describe("E1: what the sign-in link mail says and carries", () => {

  it("comes from Foxhound at the auth sender, with no Reply-To, footer, unsubscribe or tracking", async () => {
    await sendSignInLinkEmail(makeEnv(), { to: TO, url: URL_FIXTURE, token: TOKEN, code: CODE });
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
    const outcome = await sendSignInLinkEmail(makeEnv(null), { to: TO, url: URL_FIXTURE, token: TOKEN, code: CODE });
    expect(outcome).toEqual({ status: "failed", reason: "email_binding_missing", error: null });
    expect(logged()).not.toContain("EXAMPLE-NOT-A-TOKEN");
  });

  it("the binding throws: provider_error, with the link, token and recipient scrubbed from the error", async () => {
    const logged = consoleSpies();
    const env = makeEnv({
      send: async () => {
        throw new Error(`rejected message to ${TO} with link ${URL_FIXTURE}, token ${TOKEN} and code ${CODE}`);
      },
    });
    const outcome = await sendSignInLinkEmail(env, { to: TO, url: URL_FIXTURE, token: TOKEN, code: CODE });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.reason).toBe("provider_error");
    expect(outcome.error).toContain("rejected message to");
    expect(outcome.error).not.toContain("EXAMPLE-NOT-A-TOKEN");
    expect(outcome.error).not.toContain(TO);
    expect(outcome.error).not.toContain(CODE);
    expect(logged()).not.toContain("EXAMPLE-NOT-A-TOKEN");
  });

  it("a link Capsomer refuses (not https): link_refused, nothing sent", async () => {
    const outcome = await sendSignInLinkEmail(makeEnv(), {
      to: TO,
      url: "http://localhost:5173/api/auth/magic-link/verify?token=EXAMPLE-NOT-A-TOKEN",
      token: TOKEN,
      code: CODE,
    });
    expect(outcome).toEqual({ status: "failed", reason: "link_refused", error: null });
    expect(sent).toHaveLength(0);
  });

  it("an https link whose render throws: render_failed, nothing sent, nothing thrown", async () => {
    harness.renderThrows = true;
    const outcome = await sendSignInLinkEmail(makeEnv(), { to: TO, url: URL_FIXTURE, token: TOKEN, code: CODE });
    expect(outcome).toEqual({ status: "failed", reason: "render_failed", error: null });
    expect(sent).toHaveLength(0);
  });

  it("through the page, a refused send is surfaced by name and the link never reaches a log", async () => {
    const logged = consoleSpies();
    let token = "";
    const env = makeEnv({
      send: async (m: SentMessage) => {
        token = /token=([^&\s]+)/.exec(m.text ?? "")?.[1] ?? "";
        throw new Error(`provider echoed ${m.text}`);
      },
    });
    expect(await ask(env)).toBe("failed");

    expect(token).not.toBe("");
    const out = logged();
    expect(out).toContain("sign-in link email not sent: provider_error");
    expect(out).not.toContain(token);
  });
});

describe("the code in the same mail signs in the tab that asked", () => {
  // Dustin's live signup, 2026-10-29: the link opened in his regular browser,
  // so the private window that asked never signed in.
  it("the code signs in and makes the session; it works once", async () => {
    const env = makeEnv();
    expect(await ask(env)).toBe("sent");
    const code = codeIn(sent[0]);

    const result = await typeCode(env, code);
    expect(result.status).toBe("signed_in");
    if (result.status !== "signed_in") return;
    expect(result.headers.get("Set-Cookie")).toContain("better-auth.session_token=");
    expect(sqlite.prepare("SELECT count(*) AS n FROM session").get()).toEqual({ n: 1 });

    expect((await typeCode(env, code)).status).not.toBe("signed_in");
  });

  it("a wrong code counts; after three the address is held, and the link still works", async () => {
    const env = makeEnv();
    await ask(env);
    const code = codeIn(sent[0]);
    const wrong = code === "111111" ? "222222" : "111111";

    // From three addresses, so no per-IP limit stops the fourth: site-runtime's per-address code limit
    // (three wrong codes an hour, across links) holds it, even with the right code.
    for (const ip of ["203.0.113.2", "203.0.113.3", "203.0.113.4"]) {
      expect((await typeCode(env, wrong, ip)).status).toBe("wrong");
    }
    expect((await typeCode(env, code, "203.0.113.5")).status).toBe("email_limited");
    expect(linkTokens()).toHaveLength(1);
  });

  it("a new mail's code replaces the last one's", async () => {
    const env = makeEnv();
    await ask(env);
    await ask(env);
    const [first, second] = sent.map(codeIn);
    if (first !== second) expect((await typeCode(env, first)).status).toBe("wrong");
    expect((await typeCode(env, second)).status).toBe("signed_in");
  });

  it("the code is never logged", async () => {
    const logged = consoleSpies();
    const env = makeEnv();
    await ask(env);
    await typeCode(env, codeIn(sent[0]));
    expect(logged()).not.toContain(codeIn(sent[0]));
  });
});
