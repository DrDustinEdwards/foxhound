import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// E23 (job J95, job_c42d1a6d1869): the weekly digest on Capsomer's email
// component, with Recova's words, From, footer, unsubscribe and suppression.
//
// Recova is the spec, read whole at the blobs parity/ROWS-E.md names:
//   app/api/cron/weekly-digest/route.ts  blob b6ff2a8c, 22,247 bytes
//   lib/email.ts                         blob 3f882729,  2,035 bytes (wrapEmailHtml)
//   lib/email-utils.ts                   blob 9f0e7a8c,  3,775 bytes (checkAndRegisterUnsubscribe)
//   lib/email-colors.ts                  blob 8c23bd6f,  1,581 bytes
//   lib/constants.ts                     blob a21b32b8, 14,977 bytes (FROM_HELLO, APP_URL)
//
// The schedule, the claim and the numbers are parity/ENGINE-DIGEST.md's and
// stay as weekly-digest.test.ts proves them; this file is about what the mail
// says and carries, read as it reaches env.EMAIL.send wherever it can be.

interface SentMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

const harness = vi.hoisted(() => ({
  db: null as unknown,
  sent: [] as SentMessage[],
  intelligenceEntitled: false,
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/intelligence/views.server", () => ({
  isIntelligenceEntitled: async () => harness.intelligenceEntitled,
}));

const digestEmail = await import("~/lib/recovery/digest-email");
const { runWeeklyDigest } = await import("~/lib/cron/digest");
const { buildEmailMessage } = await import("~/lib/email/send");
const { verifyUnsubscribeToken } = await import("~/lib/email/unsubscribe-token");
const { findAdminEmailType, prepareAdminEmail, previewAdminEmail } = await import(
  "~/lib/admin/email-send.server"
);

const BASE = "https://foxhoundapp.test";
const ADDRESS = "1 Test Way, Austin TX";
const ACCOUNT = "acct_1";
const OWNER = "owner@acme.test";
// A Monday at 08:00 UTC, when the cron fires.
const NOW = new Date("2026-11-02T08:00:00Z");
const INSIDE = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);
const YEAR = new Date().getUTCFullYear();

const env = {
  ENCRYPTION_KEY: "ab".repeat(32),
  BETTER_AUTH_URL: BASE,
  PHYSICAL_ADDRESS: ADDRESS,
  EMAIL: {
    send: async (m: SentMessage) => {
      harness.sent.push(m);
      return { id: "msg_1" };
    },
  },
} as unknown as Env;

let sqlite: Database.Database;

beforeEach(() => {
  let db: ReturnType<typeof createInMemoryDb>["db"];
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.sent = [];
  harness.intelligenceEntitled = false;
});

function seedAccount(senderName: string | null = "Teamflow"): void {
  sqlite
    .prepare(
      "INSERT INTO accounts (id, name, created_at, digest_enabled, notification_email, processing_paused, live_sends_enabled) VALUES (?, 'Acme', 1000, 1, ?, 0, 1)",
    )
    .run(ACCOUNT, OWNER);
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, stripe_access_token, sender_name, reply_to_email, connected_at, created_at) VALUES ('c_1', ?, 'acct_s_1', 1, 'cipher', ?, 'billing@acme.test', 1000, 1000)",
    )
    .run(ACCOUNT, senderName);
}

function seedFailed(id: string, cents: number, status = "active"): void {
  sqlite
    .prepare(
      "INSERT INTO failed_payments (id, account_id, stripe_event_id, stripe_invoice_id, stripe_customer_id, customer_email, amount_cents, currency, decline_category, status, detected_at) VALUES (?, ?, ?, ?, 'cus_1', 'b@a.test', ?, 'usd', 'soft', ?, ?)",
    )
    .run(id, ACCOUNT, `evt_${id}`, `in_${id}`, cents, status, INSIDE.getTime());
}

function seedRecovered(id: string, cents: number): void {
  seedFailed(`fp_${id}`, cents, "recovered");
  sqlite
    .prepare(
      "INSERT INTO recovered_payments (id, account_id, failed_payment_id, amount_cents, currency, recovery_method, recovered_at) VALUES (?, ?, ?, ?, 'usd', 'stripe_retry', ?)",
    )
    .run(id, ACCOUNT, `fp_${id}`, cents, INSIDE.getTime());
}

function suppress(email: string): void {
  sqlite
    .prepare(
      "INSERT INTO email_suppressions (id, email, token, reason, suppressed_at) VALUES ('s1', ?, 't', 'unsubscribe', ?)",
    )
    .run(email, 1000);
}

/** Every input at a value that makes every conditional part render. */
function fullInput(over: Partial<Parameters<typeof digestEmail.digestContent>[0]> = {}) {
  return {
    totalFailed: 4,
    totalRecovered: 1,
    recoveredRevenueCents: 5000,
    atRiskRevenueCents: 20000,
    activeCount: 3,
    emailsSent: 7,
    winBackCount: 2,
    expiringCardCount: 2,
    openDisputeCount: 1,
    openDisputeCents: 9900,
    currency: "usd",
    senderName: "Teamflow",
    disputesActive: true,
    intelligenceActive: true,
    highRiskCustomers: [
      { name: "Acme Co", mrrCents: 19900 },
      { name: "(unnamed)", mrrCents: null },
    ],
    now: NOW,
    baseUrl: BASE,
    ...over,
  };
}

// ============================================================================
// What it says
// ============================================================================

describe("E23 says Recova's words, in Recova's order, on Capsomer's blocks", () => {

  it("the conditional rows and both sections are absent when Recova leaves them out", () => {
    const { blocks } = digestEmail.digestContent(
      fullInput({
        expiringCardCount: 0,
        openDisputeCount: 0,
        openDisputeCents: 0,
        disputesActive: false,
        intelligenceActive: false,
      }),
    );
    const words = JSON.stringify(blocks);
    expect(words).not.toContain("Cards expiring soon");
    expect(words).not.toContain("Open disputes");
    expect(words).not.toContain("Disputes");
    expect(words).not.toContain("Intelligence");
    expect(blocks.at(-1)).toEqual({ type: "button", label: "View Dashboard", url: `${BASE}/recovery/dashboard` });
  });

  it("the Intelligence section waits for an at-risk customer, as Recova's does", () => {
    const { blocks } = digestEmail.digestContent(fullInput({ highRiskCustomers: [] }));
    expect(JSON.stringify(blocks)).not.toContain("Intelligence");
  });
});

// ============================================================================
// What it carries
// ============================================================================

describe("E23 carries Recova's From, footer, unsubscribe and postal address", () => {
  it("the platform's From name, never the merchant's sender (Recova's FROM_HELLO)", () => {
    expect(digestEmail.digestContent(fullInput()).fromName).toBe("Foxhound");
    expect(digestEmail.digestContent(fullInput({ senderName: null })).fromName).toBe("Foxhound");
  });

  it("the cron sends the digest with an unsubscribe signed for this address and account", async () => {
    seedAccount();
    seedFailed("f1", 10000);
    seedRecovered("r1", 5000);

    const result = await runWeeklyDigest(env, NOW);

    expect(result.outcomes).toEqual([{ accountId: ACCOUNT, status: "sent" }]);
    expect(harness.sent).toHaveLength(1);
    const m = harness.sent[0];
    expect(m.to).toBe(OWNER);
    expect(m.from).toMatch(/^Foxhound </);
    expect(m.subject).toBe("Your weekly recovery report: November 2");
    // No Reply-To: Recova's digest passes none, though the merchant saved one.
    expect(m.replyTo).toBeUndefined();

    const unsub = /href="(https:\/\/foxhoundapp\.test\/u\/[^"]+)"[^>]*>Unsubscribe</.exec(m.html);
    expect(unsub, m.html).not.toBeNull();
    const token = decodeURIComponent(unsub![1].slice(`${BASE}/u/`.length));
    expect(await verifyUnsubscribeToken(env, token)).toEqual({ email: OWNER, accountId: ACCOUNT, list: "digest" });
    expect(m.headers?.["List-Unsubscribe"]).toBe(`<${unsub![1]}>`);
    expect(m.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");

    // Footer: Recova's sentence, then Unsubscribe, then the postal address, in
    // both parts.
    const note = `You're receiving this from Teamflow about a recent payment. © ${YEAR}`;
    for (const [part, sentence] of [
      [m.html, note.replace("'", "&#39;")],
      [m.text, note],
    ]) {
      const at = [sentence, "Unsubscribe", ADDRESS].map((s) => part.indexOf(s));
      expect(at.every((i) => i > -1), part).toBe(true);
      expect(at[0]).toBeLessThan(at[1]);
      expect(at[1]).toBeLessThan(at[2]);
    }
    expect(m.text).toContain(`Unsubscribe: ${unsub![1]}`);
    // No "Manage email settings": that is Recova's line for mail WITHOUT a token.
    expect(m.html).not.toContain("Manage email settings");
  });

  it("a customer name carrying markup is shown as written, escaped by Capsomer", async () => {
    seedAccount();
    harness.intelligenceEntitled = true;
    sqlite
      .prepare(
        "INSERT INTO customer_context (id, account_id, stripe_customer_id, customer_name, health_score, mrr_contribution_cents, created_at, updated_at) VALUES ('cc1', ?, 'cus_9', ?, 10, 19900, 1000, 1000)",
      )
      .run(ACCOUNT, `<b>"A"&'s</b>`);

    await runWeeklyDigest(env, NOW);

    const m = harness.sent[0];
    expect(m.html).toContain("&lt;b&gt;&quot;A&quot;&amp;&#39;s&lt;/b&gt;: $199.00/mo");
    expect(m.text).toContain(`<b>"A"&'s</b>: $199.00/mo`);
  });
});

// ============================================================================
// When it sends, and when it does not
// ============================================================================

describe("E23 honors suppression, as Recova's checkAndRegisterUnsubscribe does", () => {
  it("an unsubscribed notification address gets no digest, and the outcome is named", async () => {
    seedAccount();
    suppress(OWNER);

    const result = await runWeeklyDigest(env, NOW);

    expect(harness.sent).toEqual([]);
    expect(result.outcomes).toEqual([{ accountId: ACCOUNT, status: "suppressed" }]);
    expect(result).toMatchObject({ sent: 0, skipped: 1 });
  });

  it("an account already sent this week is named, not silent", async () => {
    seedAccount();
    sqlite
      .prepare(
        "INSERT INTO email_sends (id, account_id, template, status, created_at) VALUES ('es1', ?, 'weekly_digest', 'sent', ?)",
      )
      .run(ACCOUNT, INSIDE.getTime());

    const result = await runWeeklyDigest(env, NOW);

    expect(result.outcomes).toEqual([{ accountId: ACCOUNT, status: "already_sent" }]);
  });
});

// ============================================================================
// The digest only: no other merchant notice gains an unsubscribe
// ============================================================================

describe("the unsubscribe is the digest's alone (RULES.md 3.16)", () => {
  const read = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf8");
  const job = {
    accountId: ACCOUNT,
    to: OWNER,
    subject: "s",
    blocks: [{ type: "paragraph" as const, text: "x" }],
    template: "t",
    unsubscribeToken: "tok",
    physicalAddress: ADDRESS,
    idempotencyKey: "k",
    footerNote: "note",
  };

  it("digest mail carries both, and refuses to build without either", () => {
    const m = buildEmailMessage({ ...job, audience: "digest", replyTo: "billing@acme.test" }, BASE);
    expect(m.html).toContain(`href="${BASE}/u/tok"`);
    expect(m.html).toContain(ADDRESS);
    expect(m.replyTo).toBeUndefined();
    expect(() => buildEmailMessage({ ...job, audience: "digest", physicalAddress: " " }, BASE)).toThrow(
      /physical address/,
    );
    expect(() => buildEmailMessage({ ...job, audience: "digest", unsubscribeToken: "" }, BASE)).toThrow(
      /unsubscribe token/,
    );
  });

  it("only the digest's two senders ask for the digest audience, anywhere under app/", () => {
    // Every .ts and .tsx file under app/, not a chosen list (RULES.md 6.5):
    // a merchant notice switched to the digest audience would gain an
    // unsubscribe, and a list that leaves its file out would never see it.
    const root = fileURLToPath(new URL("../", import.meta.url));
    const walk = (dir: string): string[] =>
      readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(`${dir}/${e.name}`)
          : /\.tsx?$/.test(e.name)
            ? [`${dir}/${e.name}`]
            : [],
      );
    const files = walk("app");
    expect(files.length).toBeGreaterThan(300);
    expect(files).toContain("app/lib/disputes/notices.server.ts");
    const users = files.filter((f) => /audience:\s*"digest"/.test(read(f))).sort();
    expect(users).toEqual(["app/lib/admin/email-send.server.ts", "app/lib/cron/digest.ts"]);
  });
});

// ============================================================================
// Links have somewhere to go (RULES.md 2.7)
// ============================================================================

describe("View recommendations waits for its page", () => {
  const read = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf8");

  it("is live only when /intelligence/recommendations is a route", () => {
    const hasPage = /route\("recommendations"/.test(read("app/routes.ts"));
    expect(digestEmail.DIGEST_RECOMMENDATIONS_LIVE).toBe(hasPage);
  });

  it("the Intelligence section ends with the button, and every link resolves", () => {
    const { blocks } = digestEmail.digestContent(fullInput());
    const urls = blocks.flatMap((b) => (b.type === "button" ? [b.url] : []));
    const routes = read("app/routes.ts");
    expect(routes).toMatch(/prefix\("recovery", \[\s*route\("dashboard"/);
    expect(routes).toMatch(/prefix\("disputes", \[\s*route\("dashboard"/);
    expect(routes).toMatch(/prefix\("intelligence", \[[^\]]*route\("recommendations"/);
    expect(urls).toEqual([
      `${BASE}/disputes/dashboard`,
      `${BASE}/intelligence/recommendations`,
      `${BASE}/recovery/dashboard`,
    ]);
  });
});

// ============================================================================
// The admin preview is the real sender's output
// ============================================================================

describe("the admin preview of the digest is digestContent's output", () => {
  it("previews with the platform From, Recova's footer and a working unsubscribe", async () => {
    const type = findAdminEmailType("weekly_digest")!;
    const prepared = await prepareAdminEmail(env, {
      type,
      to: "admin@foxhoundapp.test",
      merchant: {
        accountId: ACCOUNT,
        name: "Acme",
        senderName: "Teamflow",
        replyTo: "billing@acme.test",
        brandVoice: { default: null, soft: null, expired: null, network: null, fraud: null },
      },
      now: NOW,
    });
    const p = previewAdminEmail(env, type, prepared);
    expect(p.from).toMatch(/^Foxhound </);
    expect(p.reply_to).toBeNull();
    expect(p.subject).toBe("Your weekly platform report: November 2");
    expect(p.html).toContain("You&#39;re receiving this from Teamflow about a recent payment.");
    expect(p.headers["List-Unsubscribe"]).toMatch(new RegExp(`^<${BASE}/u/`));
    expect(p.html).toContain(`${BASE}/recovery/dashboard`);
  });
});
