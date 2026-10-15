import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// E2 (parity/ROWS-E.md, job J83): inviting a teammate on /settings/team emails
// the invitee Recova's invite.
//
// Recova is the spec: app/api/invite/route.ts (blob 960aefc6, 3735 bytes), read
// whole with lib/email.ts (3f882729), lib/email-colors.ts (8c23bd6f),
// lib/constants.ts (a21b32b8) and lib/resend-retry.ts (adcda147). After the
// pending account_members row is written, on every invite, with no toggle, it
// sends one mail to the address the owner entered:
//   From     FROM_RECOVERY, "Recova <recovery@recovamrr.com>"; no Reply-To
//   Subject  "You've been invited to join Recova"
//   Body     "You've been invited to join <strong>{account name || 'a team'}
//            </strong> on Recova.", an "Accept Invite" button to the invite
//            link, then "This invite expires in 7 days." in muted small type
//   No unsubscribe link, no postal address, no tracking, no text part.
// A failed send is logged and the route still answers success.
//
// Foxhound sends the same words with Foxhound's name, on Capsomer's email
// component in teal, with a text part, to the approved /invite/:token link, and
// says so on the page when the email did not go (RULES.md 3.16). Every
// assertion reads the message as it reaches env.EMAIL.send.

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

const { action, loader } = await import("~/routes/app/settings/team");
const { EMAIL_FROM_ADDRESS } = await import("~/lib/constants");
const { INVITE_TTL_MS } = await import("~/lib/auth/roles");
const { hashRecipient } = await import("~/lib/email/dispatch");

const BASE = "https://foxhoundapp.test";
const ADDRESS = "1 Test Way, Austin TX";
const ACCOUNT = "acct_1";
const OWNER = "user_owner";
const INVITEE = "new.person@example.com";
// Capsomer's teal family, light theme, body text: the frame every Foxhound
// mail is drawn in (J02).
const TEAL_TEXT = "#071f20";

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
let accountName = "Acme";

beforeEach(() => {
  let db: ReturnType<typeof createInMemoryDb>["db"];
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.sent = [];
  env = makeEnv();
  accountName = "Acme";
  sqlite
    .prepare("INSERT INTO user (id, name, email, email_verified, updated_at) VALUES (?, 'Owner', 'owner@acme.test', 0, 0)")
    .run(OWNER);
  // Live sends OFF, the default for every account: Recova's invite has no such
  // switch, so the invite must not depend on it.
  sqlite
    .prepare("INSERT INTO accounts (id, name, created_at, live_sends_enabled) VALUES (?, 'Acme', 1000, 0)")
    .run(ACCOUNT);
  sqlite
    .prepare(
      "INSERT INTO account_members (id, account_id, user_id, role, status, created_at) VALUES ('m_owner', ?, ?, 'owner', 'active', 1000)",
    )
    .run(ACCOUNT, OWNER);
});

function ctxFor(role = "owner") {
  return {
    get(key: unknown) {
      if (key === cloudflareContext) return { env, ctx: {} as ExecutionContext, nonce: "n" };
      if (key === authContext) {
        const membership = { memberId: "m_owner", accountId: ACCOUNT, accountName, role };
        return {
          userId: OWNER,
          userName: "Owner",
          email: "owner@acme.test",
          membership,
          memberships: [membership],
          activeAccountId: ACCOUNT,
          isAdmin: false,
          isDemo: false,
          demoSignedIn: false,
        };
      }
      throw new Error("unexpected context key");
    },
  } as unknown as Parameters<typeof action>[0]["context"];
}

async function post(
  fields: Record<string, string>,
  role = "owner",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = (await action({
    context: ctxFor(role),
    request: new Request(`${BASE}/settings/team`, { method: "POST", body: form }),
    params: {},
  } as never)) as unknown as { data: Record<string, unknown>; init?: { status?: number } };
  return { status: res.init?.status ?? 200, body: res.data };
}

const invite = (email = INVITEE) => post({ email });

function only(): SentMessage {
  expect(harness.sent).toHaveLength(1);
  return harness.sent[0];
}

function inviteToken(): string {
  const row = sqlite
    .prepare("SELECT invite_token AS t FROM account_members WHERE status = 'pending'")
    .get() as { t: string };
  return row.t;
}

/** The words appear in this order in the part. */
function expectInOrder(part: string, words: string[]): void {
  let at = -1;
  for (const w of words) {
    const next = part.indexOf(w, at + 1);
    expect(next, `"${w}" after position ${at}`).toBeGreaterThan(at);
    at = next;
  }
}

/** The HTML part's text with its entities read back, for word checks. */
function htmlWords(html: string): string {
  return html.replaceAll("&#39;", "'").replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}

const SUBJECT = "You've been invited to join Foxhound";
const EXPIRY = "This invite expires in 7 days.";

describe("when it sends: Recova's trigger and not otherwise", () => {
  it("an owner's invite sends one email to the invited address", async () => {
    const res = await invite();
    expect(res.status).toBe(200);
    expect(only().to).toBe(INVITEE);
  });

  it("sends after the pending invite is written, and the email's link is that invite", async () => {
    await invite();
    const token = inviteToken();
    expect(only().html).toContain(`${BASE}/invite/${token}`);
  });

  it("sends with live sends off, because Recova's invite has no such switch", async () => {
    await invite();
    expect(harness.sent).toHaveLength(1);
  });

  it("every invite sends, as every POST to Recova's route does", async () => {
    await invite("a@example.com");
    await invite("b@example.com");
    expect(harness.sent.map((m) => m.to)).toEqual(["a@example.com", "b@example.com"]);
  });

  it("a non-owner, an empty address, a removal, or loading the page sends nothing", async () => {
    await post({ email: INVITEE }, "member");
    await post({ email: "" });
    await post({ _action: "remove", memberId: "nobody" });
    await loader({ context: ctxFor(), request: new Request(`${BASE}/settings/team`), params: {} } as never);
    expect(harness.sent).toHaveLength(0);
  });
});

describe("what it says: Recova's words, Foxhound-branded", () => {
  it("the subject is Recova's with Foxhound's name", async () => {
    await invite();
    expect(only().subject).toBe(SUBJECT);
  });

  it("the invitation naming the team, the Accept Invite button, then the expiry, in both parts", async () => {
    await invite();
    const m = only();
    for (const part of [m.text ?? "", htmlWords(m.html)]) {
      expectInOrder(part, ["You've been invited to join Acme on Foxhound.", "Accept Invite", EXPIRY]);
    }
  });

  it("says 'a team' when the account has no name, as Recova's fallback", async () => {
    accountName = "";
    await invite();
    expect(only().text).toContain("You've been invited to join a team on Foxhound.");
  });

  it("a team name is words, never markup", async () => {
    accountName = "Tom & Jerry <b>Co</b>";
    await invite();
    const m = only();
    expect(m.text).toContain("You've been invited to join Tom & Jerry <b>Co</b> on Foxhound.");
    expect(m.html).toContain("Tom &amp; Jerry &lt;b&gt;Co&lt;/b&gt;");
    expect(m.html).not.toContain("<b>Co</b>");
  });

  it("the 7 days it states is how long the invite really lasts", async () => {
    await invite();
    expect(INVITE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    const row = sqlite
      .prepare("SELECT invite_expires_at - created_at AS ttl FROM account_members WHERE status = 'pending'")
      .get() as { ttl: number };
    // Stored in seconds or milliseconds depending on the column mode; either
    // way it is seven days.
    expect([7 * 24 * 60 * 60, 7 * 24 * 60 * 60 * 1000]).toContain(row.ttl);
  });

  it("says Foxhound, never Recova", async () => {
    await invite();
    const m = only();
    for (const part of [m.subject, m.from, m.text ?? "", m.html]) expect(part).not.toMatch(/recova/i);
  });
});

describe("what it carries", () => {
  it("From Foxhound at Foxhound's recovery sender, as Recova's FROM_RECOVERY, and no Reply-To", async () => {
    await invite();
    const m = only();
    expect(m.from).toBe(`Foxhound <${EMAIL_FROM_ADDRESS}>`);
    expect(EMAIL_FROM_ADDRESS).toMatch(/^recovery@/);
    expect(m.replyTo).toBeUndefined();
  });

  it("an HTML part and a text part, in the teal frame", async () => {
    await invite();
    const m = only();
    expect(m.html.startsWith("<!doctype html>")).toBe(true);
    expect(m.html).toContain(TEAL_TEXT);
    expect((m.text ?? "").trim().length).toBeGreaterThan(0);
    expect(m.text).not.toMatch(/<\/?(p|a|br|table|td|h\d)\b/i);
  });

  it("merchant mail: no unsubscribe link, no postal address, no tracking", async () => {
    await invite();
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

  it("its one link is the Accept Invite button, the same /invite/:token link the page shows", async () => {
    const res = await invite();
    const m = only();
    const url = `${BASE}/invite/${inviteToken()}`;
    expect(res.body.inviteUrl).toBe(url);
    const hrefs = [...m.html.matchAll(/href="([^"]*)"/g)].map((h) => h[1]);
    expect(hrefs).toEqual([url]);
    expect(m.html).toMatch(new RegExp(`<a\\b[^>]*href="${url}"[^>]*>\\s*Accept Invite\\s*</a>`));
    expect(m.text).toContain(url);
  });

  it("needs no postal address, since it carries none", async () => {
    env = makeEnv({ PHYSICAL_ADDRESS: undefined });
    await invite();
    expect(harness.sent).toHaveLength(1);
  });

  it("is recorded in email_sends as a team invite, by recipient hash, sent", async () => {
    await invite();
    const rows = sqlite
      .prepare("SELECT account_id AS a, template AS t, recipient_hash AS h, status AS s FROM email_sends")
      .all();
    expect(rows).toEqual([{ a: ACCOUNT, t: "team_invite", h: await hashRecipient(INVITEE), s: "sent" }]);
  });
});

describe("accessibility of the rendered mail", () => {
  it("a language, a title, real links with visible text, and 16px body text", async () => {
    await invite();
    const { html } = only();
    expect(html).toMatch(/<html[^>]*\blang="en"/);
    expect(html).toContain(`<title>${SUBJECT.replace("'", "&#39;")}</title>`);
    for (const [, href] of html.matchAll(/<a\b[^>]*href="([^"]*)"/g)) expect(href).toMatch(/^https:\/\//);
    for (const [, label] of html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)) expect(label.trim().length).toBeGreaterThan(0);
    // One heading, and it is the invitation in Recova's words.
    expect(html.match(/<h[1-6]\b/g)).toHaveLength(1);
    expect(htmlWords(html)).toMatch(/<h1\b[^>]*>You've been invited to join Acme on Foxhound\.<\/h1>/);
    expect(html).toMatch(/font-size:\s*16px/);
  });
});

describe("a refused send returns its named outcome, and the invite still stands", () => {
  it("sent: the page says the email went, and keeps the link", async () => {
    const res = await invite();
    expect(res.body).toMatchObject({ error: null, invited: INVITEE, emailStatus: "sent", emailError: null });
    expect(String(res.body.inviteUrl)).toContain("/invite/");
  });

  it("a suppressed address: 'suppressed', nothing sent, the merchant told, the link kept", async () => {
    sqlite
      .prepare("INSERT INTO email_suppressions (id, email, token, reason, suppressed_at) VALUES ('s1', ?, 't', 'bounce', 2000)")
      .run(INVITEE);
    const res = await invite();
    expect(harness.sent).toHaveLength(0);
    expect(res.status).toBe(200);
    expect(res.body.emailStatus).toBe("suppressed");
    expect(String(res.body.emailError)).toMatch(/not emailed|could not/i);
    expect(String(res.body.inviteUrl)).toContain(`/invite/${inviteToken()}`);
  });

  it("no EMAIL binding: 'failed', the merchant told, the invite still created", async () => {
    env = makeEnv({ EMAIL: undefined });
    const res = await invite();
    expect(res.status).toBe(200);
    expect(res.body.emailStatus).toBe("failed");
    expect(String(res.body.emailError)).toMatch(/could not/i);
    expect(inviteToken()).toBeTruthy();
  });

  it("a provider refusal: 'failed', and no throw reaches the page", async () => {
    env = makeEnv({
      EMAIL: {
        send: async () => {
          throw new Error("provider said no");
        },
      },
    });
    const res = await invite();
    expect(res.status).toBe(200);
    expect(res.body.emailStatus).toBe("failed");
    expect(String(res.body.inviteUrl)).toContain("/invite/");
  });

  it("no message to the merchant carries a wide dash", async () => {
    env = makeEnv({ EMAIL: undefined });
    const wide = new RegExp("[" + String.fromCharCode(0x2014, 0x2013) + "]");
    const res = await invite();
    expect(typeof res.body.emailError).toBe("string");
    expect(String(res.body.emailError)).not.toMatch(wide);
  });
});

describe("the live-send gate still holds every other send", () => {
  it("customer mail and other merchant mail are held; only the preview and the invite are not", async () => {
    const { heldByLiveSendGate, TEAM_INVITE_TEMPLATE } = await import("~/lib/email/dispatch");
    expect(heldByLiveSendGate({ audience: undefined, template: "recovery_dunning" })).toBe(true);
    expect(heldByLiveSendGate({ audience: "customer", template: TEAM_INVITE_TEMPLATE })).toBe(true);
    expect(heldByLiveSendGate({ audience: "merchant", template: "weekly_digest" })).toBe(true);
    expect(heldByLiveSendGate({ audience: "preview", template: "settings_test" })).toBe(false);
    expect(heldByLiveSendGate({ audience: "merchant", template: TEAM_INVITE_TEMPLATE })).toBe(false);
  });
});
