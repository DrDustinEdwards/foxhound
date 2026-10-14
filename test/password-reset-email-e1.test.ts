import type Database from "better-sqlite3";
import { reset, renderEmail } from "capsomer/email";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EMAIL_AUTH_SENDER_ADDRESS } from "~/lib/constants";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J82, parity row E1: the password reset email. Recova's reset mail was a
// Supabase dashboard template, not in its repo, so its words are unknown; this
// test claims nothing about parity. It pins three things: the mail is
// Capsomer's `reset` template (capsomer/email, v0.9.0) carrying Foxhound's
// current words, it is sent on Better Auth's reset hook and nowhere else, and
// every refused send comes back as a named outcome, with the link never logged.
// Every assertion on content reads the message as it reaches env.EMAIL.send.

interface SentMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

const harness = vi.hoisted(() => ({ db: null as unknown }));

// auth.server.ts builds its Drizzle adapter from getDb(env); hand it the real
// schema in memory instead of a D1 binding.
vi.mock("~/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db/client")>()),
  getDb: () => harness.db,
}));

const { getAuth } = await import("~/lib/auth/auth.server");
const { sendPasswordResetEmail } = await import("~/lib/auth/send-auth-email");

const BASE = "https://foxhoundapp.com";
const TO = "jane@example.com";
const URL_FIXTURE = `${BASE}/api/auth/reset-password/EXAMPLE-NOT-A-TOKEN?callbackURL=%2Freset-password`;

// Foxhound's words, as they were before J82. Written out here, not imported, so
// a change to the copy in the app has to change this file too.
const WORDS = {
  subject: "Reset your password",
  heading: "Reset your password",
  intro: "We received a request to reset your Foxhound password.",
  button: "Reset password",
  ignore: "If this was not you, you can ignore this email.",
};
// Capsomer's reset template has no override for this line; Better Auth's reset
// token is single use and lives 3600 seconds (asserted below).
const EXPIRY_LINE = "The link works once and expires in 1 hour.";

function expectedRender(to: string, url: string) {
  return renderEmail(reset, {
    brand: { name: "Foxhound", family: "teal" },
    to,
    url,
    expiresIn: "1 hour",
    copy: WORDS,
  });
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
  sent = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function signUp(auth: ReturnType<typeof getAuth>, email = TO) {
  await auth.api.signUpEmail({
    body: { name: "Jane Example", email, password: "Example-password-2026!" },
    asResponse: true,
  });
}

function resetTokens(): { identifier: string; expires_at: number; created_at: number }[] {
  return sqlite
    .prepare("SELECT identifier, expires_at, created_at FROM verification WHERE identifier LIKE 'reset-password:%'")
    .all() as { identifier: string; expires_at: number; created_at: number }[];
}

describe("E1: the reset mail is sent on Better Auth's reset hook, and only there", () => {
  it("a reset request sends one mail to the user's address, rendered by Capsomer's reset template", async () => {
    const auth = getAuth(makeEnv());
    await signUp(auth);
    const before = sent.length;

    await auth.api.requestPasswordReset({ body: { email: TO, redirectTo: "/reset-password" } });

    expect(sent.length - before).toBe(1);
    const m = sent[sent.length - 1];
    expect(m.to).toBe(TO);

    // The button carries Better Auth's url untouched: its token is the one
    // Better Auth stored, and the callback is the forgot-password page's.
    const hrefs = [...m.html.matchAll(/<a\b[^>]*href="([^"]*)"/g)].map((x) => x[1]);
    expect(hrefs).toHaveLength(1);
    const href = hrefs[0].replace(/&amp;/g, "&");
    const shape = /^https:\/\/foxhoundapp\.com\/api\/auth\/reset-password\/([^?]+)\?callbackURL=%2Freset-password$/;
    expect(href).toMatch(shape);
    const tokens = resetTokens();
    expect(tokens.map((t) => t.identifier)).toEqual([`reset-password:${href.match(shape)![1]}`]);

    const want = expectedRender(TO, href);
    expect(m.subject).toBe(want.subject);
    expect(m.html).toBe(want.html);
    expect(m.text).toBe(want.text);
  });

  it("the link lives one hour, which is what the mail says", async () => {
    const auth = getAuth(makeEnv());
    await signUp(auth);
    await auth.api.requestPasswordReset({ body: { email: TO, redirectTo: "/reset-password" } });
    const [row] = resetTokens();
    const lifetimeSeconds = Math.round((Number(row.expires_at) - Number(row.created_at)) / 1000);
    expect(lifetimeSeconds).toBe(3600);
    expect(sent[sent.length - 1].text).toContain(EXPIRY_LINE);
  });

  it("the link works once: a second reset with the same token is refused", async () => {
    const auth = getAuth(makeEnv());
    await signUp(auth);
    await auth.api.requestPasswordReset({ body: { email: TO, redirectTo: "/reset-password" } });
    const token = resetTokens()[0].identifier.slice("reset-password:".length);

    await auth.api.resetPassword({ body: { token, newPassword: "Another-password-2026!" } });
    await expect(
      auth.api.resetPassword({ body: { token, newPassword: "Third-password-2026!!" } }),
    ).rejects.toThrow();
  });

  it("signing up sends the verification mail, not the reset mail", async () => {
    const auth = getAuth(makeEnv());
    await signUp(auth);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).not.toBe(WORDS.subject);
    expect(sent[0].text).not.toContain(WORDS.intro);
    expect(sent[0].text).not.toContain(EXPIRY_LINE);
  });

  it("a reset request for an unknown address sends nothing", async () => {
    const restore = consoleSpies();
    const auth = getAuth(makeEnv());
    await auth.api.requestPasswordReset({ body: { email: "nobody@example.com", redirectTo: "/reset-password" } });
    expect(sent).toHaveLength(0);
    restore();
  });
});

describe("E1: what the reset mail says and carries", () => {
  it("is Capsomer's reset template, byte for byte, with Foxhound's words", async () => {
    const outcome = await sendPasswordResetEmail(makeEnv(), TO, URL_FIXTURE);
    expect(outcome).toEqual({ status: "sent", providerMessageId: "msg_1" });
    expect(sent).toHaveLength(1);
    const m = sent[0];
    const want = expectedRender(TO, URL_FIXTURE);
    expect(m.subject).toBe(want.subject);
    expect(m.html).toBe(want.html);
    expect(m.text).toBe(want.text);
  });

  it("every line of the text part, in order", async () => {
    await sendPasswordResetEmail(makeEnv(), TO, URL_FIXTURE);
    expect(sent[0].subject).toBe("Reset your password");
    expect(sent[0].text).toBe(
      [
        "Foxhound",
        "",
        "Reset your password",
        "",
        "We received a request to reset your Foxhound password.",
        "",
        "Reset password:",
        URL_FIXTURE,
        "",
        "The link works once and expires in 1 hour.",
        "",
        "If this was not you, you can ignore this email.",
        "",
        "--",
        "This message was sent to jane@example.com.",
        "",
      ].join("\n"),
    );
  });

  it("the HTML part carries the same words, one h1 and one button", async () => {
    await sendPasswordResetEmail(makeEnv(), TO, URL_FIXTURE);
    const { html } = sent[0];
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<title>Reset your password</title>");
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain(">Reset your password</h1>");
    for (const line of [WORDS.intro, EXPIRY_LINE, WORDS.ignore, "This message was sent to jane@example.com."]) {
      expect(html).toContain(line);
    }
    const anchors = [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)];
    expect(anchors).toHaveLength(1);
    expect(anchors[0][1].replace(/&amp;/g, "&")).toBe(URL_FIXTURE);
    expect(anchors[0][2]).toBe("Reset password");
  });

  it("comes from Foxhound at the auth sender, with no Reply-To, footer, unsubscribe or tracking", async () => {
    await sendPasswordResetEmail(makeEnv(), TO, URL_FIXTURE);
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
    // One link only, in each part: the reset link.
    expect([...m.html.matchAll(/https?:\/\//g)]).toHaveLength(1);
    expect([...(m.text ?? "").matchAll(/https?:\/\//g)]).toHaveLength(1);
  });
});

describe("E1: a refused send comes back named, and the link is never logged", () => {
  it("no EMAIL binding: email_binding_missing", async () => {
    const logged = consoleSpies();
    const outcome = await sendPasswordResetEmail(makeEnv(null), TO, URL_FIXTURE);
    expect(outcome).toEqual({ status: "failed", reason: "email_binding_missing", error: null });
    expect(logged()).not.toContain("EXAMPLE-NOT-A-TOKEN");
  });

  it("the binding throws: provider_error, with the link scrubbed from the error", async () => {
    const logged = consoleSpies();
    const env = makeEnv({
      send: async () => {
        throw new Error(`rejected message with link ${URL_FIXTURE}`);
      },
    });
    const outcome = await sendPasswordResetEmail(env, TO, URL_FIXTURE);
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.reason).toBe("provider_error");
    expect(outcome.error).toContain("rejected message with link");
    expect(outcome.error).not.toContain("EXAMPLE-NOT-A-TOKEN");
    expect(logged()).not.toContain("EXAMPLE-NOT-A-TOKEN");
  });

  it("a link Capsomer refuses (not https): link_refused, nothing sent", async () => {
    const outcome = await sendPasswordResetEmail(
      makeEnv(),
      TO,
      "http://localhost:5173/reset-password/EXAMPLE-NOT-A-TOKEN?callbackURL=%2Freset-password",
    );
    expect(outcome).toEqual({ status: "failed", reason: "link_refused", error: null });
    expect(sent).toHaveLength(0);
  });

  it("through the hook, a refused send is surfaced by name and the link never reaches a log", async () => {
    const logged = consoleSpies();
    const env = makeEnv({
      send: async (m: SentMessage) => {
        if (m.subject === WORDS.subject) throw new Error(`provider echoed ${m.text}`);
        sent.push(m);
        return { id: "msg_1" };
      },
    });
    const auth = getAuth(env);
    await signUp(auth);
    await auth.api.requestPasswordReset({ body: { email: TO, redirectTo: "/reset-password" } });

    const token = resetTokens()[0].identifier.slice("reset-password:".length);
    const out = logged();
    expect(out).toContain("password reset email not sent: provider_error");
    expect(out).not.toContain(token);
  });
});
