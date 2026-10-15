import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DOC_GUIDES, type DocBlock, type DocInline } from "~/lib/marketing/docs-content";
import { INVITE_TTL_MS, MEMBER_ROLE } from "~/lib/auth/roles";
import { EXPIRING_CARD_DAYS_AHEAD, WINBACK_STEP1_HOURS, WINBACK_STEP2_HOURS, WINBACK_STEP3_HOURS } from "~/lib/constants";
import { CRON_JOBS } from "~/lib/cron/registry";
import { normalizeSlackWebhookUrl } from "~/lib/settings/slack-webhook";

// SESSION 64, JOB 3 AND JOB 4: the platform guide's claim audit.
//
// EVERY CAPABILITY SENTENCE IS TIED TO THE CODE THAT MAKES IT TRUE (350 binding
// 7), and the tie is to the SENTENCE rather than to a fragment of it: a
// substring plant survives the truth changing underneath it, which is how the
// settings card told merchants the sequence-complete notice was unbuilt for
// seven sessions after it shipped.
//
// The pairing in each case is: the guide says X, and here is the constant, the
// registry entry or the refusal in source that makes X true. A claim that
// cannot be paired does not get written, which is why this file has no rows for
// reply-to, a sending domain, auto-submit, or account deletion.

const platform = DOC_GUIDES.find((g) => g.slug === "platform")!;

/** Every rendered word of the guide, blocks flattened, for sentence pinning. */
function flatten(blocks: DocBlock[]): string {
  const inline = (node: DocInline): string => {
    if (typeof node === "string") return node;
    if ("code" in node) return node.code;
    if ("strong" in node) return node.strong;
    if ("mono" in node) return node.mono;
    if ("badge" in node) return String(node.badge);
    return node.link;
  };
  const rich = (r: string | DocInline[]): string =>
    typeof r === "string" ? r : r.map(inline).join("");
  return blocks
    .map((b) => {
      if (typeof b === "string") return b;
      switch (b.kind) {
        case "p":
          return rich(b.body);
        case "h3":
          return b.text;
        case "note":
        case "tip":
          return rich(b.body);
        case "steps":
        case "list":
          return b.items.map(rich).join(" ");
        case "table":
          return [...b.columns, ...b.rows.flat().map(rich)].join(" ");
      }
    })
    .join("\n");
}

const TEXT = platform.sections.map((s) => `${s.heading}\n${flatten(s.body)}`).join("\n");

describe("PLANT 1: the guide's shape", () => {
  it("carries legacy's three Parts, so a dropped section cannot ship silently", () => {
    expect(platform.sections.map((s) => s.heading)).toEqual([
      "Getting started",
      "Additional features",
      "Settings reference",
    ]);
  });

  it("has H3 subheadings, which the pre-extension schema could not express", () => {
    const h3s = platform.sections
      .flatMap((s) => s.body)
      .filter((b): b is { kind: "h3"; text: string } => typeof b !== "string" && b.kind === "h3");
    // Legacy's platform guide runs 24 H3. Foxhound carries the ones that are
    // true at HEAD; the count is pinned so a silent deletion fails.
    //
    // 23 TO 24 IN SESSION 77, deliberately: "Connecting an agent" joined the
    // API-keys section when the MCP endpoint went live and the S29 hold
    // released. The count moving is the guard working, not noise, and it is
    // updated with the reason rather than relaxed to a floor.
    //
    // 24 TO 27 AT J73: Recova's own 24 now sit in Recova's order (Reply-to
    // email, Merchant context, Roles, Account deletion and Disconnecting Stripe
    // among them), and Foxhound's Alerts, API keys and Connecting an agent
    // stay beside them as Foxhound additions.
    expect(h3s).toHaveLength(27);
    expect(h3s.map((h) => h.text)).toContain("Connecting an agent");
    expect(h3s.map((h) => h.text)).toContain("Expiring card alerts");
    expect(h3s.map((h) => h.text)).toContain("Win-back sequences");
  });
});

describe("PLANT 2: every capability sentence, tied to its code", () => {
  it("EXPIRING CARDS: nightly, thirty days ahead, once per card and month", () => {
    expect(TEXT).toContain(
      "Foxhound checks your active subscriptions nightly and, when a card is inside 30 days of expiring, emails that customer once to ask them to update it.",
    );
    expect(EXPIRING_CARD_DAYS_AHEAD).toBe(30);
    expect(CRON_JOBS.map((c) => c.name)).toContain("expiring-cards");
    // "once per card and expiry month" is the unique index, not a code path.
    const migrations = readFileSync(
      fileURLToPath(new URL("../drizzle/migrations/0019_condemned_speed.sql", import.meta.url)),
      "utf8",
    );
    expect(migrations).toContain("expiring_card_alerts_card_month_uq");
  });

  it("EXPIRING CARDS: the link is a Foxhound page and the alert is not billable", () => {
    expect(TEXT).toContain(
      "The link in the alert is a Foxhound page, not Stripe's billing portal.",
    );
    // Ruling 341 binding 2. The CTA target is /p/:token in card-update mode, so
    // the route has to exist for the sentence to be true.
    const routes = readFileSync(
      fileURLToPath(new URL("../app/routes.ts", import.meta.url)),
      "utf8",
    );
    expect(routes).toContain('route("p/:token"');
  });

  it("WIN-BACK: an hour, four days, fourteen days", () => {
    expect(TEXT).toContain(
      "the first an hour after the cancellation, then one at four days and a last one at fourteen",
    );
    expect(WINBACK_STEP1_HOURS).toBe(1);
    expect(WINBACK_STEP2_HOURS).toBe(4 * 24);
    expect(WINBACK_STEP3_HOURS).toBe(14 * 24);
  });

  it("WIN-BACK: matched by the sequence id Foxhound put on the checkout, never by customer", () => {
    expect(TEXT).toContain(
      "matched to their sequence by the identifier Foxhound put on the checkout, never by guessing from the customer",
    );
    // 344 binding 1: legacy matches on customer alone and credits an ordinary
    // renewal as a win-back. Foxhound reads its own metadata key instead.
    const events = readFileSync(
      fileURLToPath(new URL("../app/lib/webhooks/events.ts", import.meta.url)),
      "utf8",
    );
    expect(events).toContain("readWinbackSequenceId");
  });

  it("WEEKLY DIGEST: Monday, and off until enabled", () => {
    expect(TEXT).toContain("The weekly digest is a Monday morning summary of the previous seven days");
    expect(TEXT).toContain("It is off until you enable it on the notifications page");
    expect(CRON_JOBS.map((c) => c.name)).toContain("weekly-digest");
  });

  it("SLACK: only Slack's own webhook host is accepted", () => {
    expect(TEXT).toContain(
      "Foxhound only accepts a URL on Slack's own webhook host, so a pasted address that points somewhere else is refused rather than quietly fetched.",
    );
    // 351 binding 3, host-parsed rather than prefix-matched, so the lookalike
    // host the sentence promises to refuse is actually refused.
    expect(normalizeSlackWebhookUrl("https://hooks.slack.com/services/T/B/X").ok).toBe(true);
    expect(normalizeSlackWebhookUrl("https://hooks.slack.com.evil.test/x").ok).toBe(false);
  });

  it("SLACK: posts on a recovery email and on a successful retry", () => {
    expect(TEXT).toContain(
      "Foxhound posts to Slack when a recovery email goes out and when a retry brings a payment back.",
    );
    // 351 binding 1: legacy's two real event sites, and the brief's guess that
    // it fires on the merchant notice was withdrawn.
    const slack = readFileSync(
      fileURLToPath(new URL("../app/lib/notify/slack.server.ts", import.meta.url)),
      "utf8",
    );
    expect(slack).toContain("email_sent");
    expect(slack).toContain("payment_recovered");
  });

  it("SENDER NAME: recovery mail goes out from Support until it is set", () => {
    expect(TEXT).toContain('recovery mail goes out from "Support"');
    const send = readFileSync(
      fileURLToPath(new URL("../app/lib/email/send.ts", import.meta.url)),
      "utf8",
    );
    expect(send).toContain('const DEFAULT_FROM_NAME = "Support"');
  });

  it("BRAND VOICE: the most specific voice available wins", () => {
    expect(TEXT).toContain(
      "The voice for a given email is the one set for that decline category, or the main voice when the category has none, or Foxhound's own default when neither is set.",
    );
    // 338 binding 1: three rungs, every one a falsy check.
    const generation = readFileSync(
      fileURLToPath(new URL("../app/lib/recovery/email-generation.ts", import.meta.url)),
      "utf8",
    );
    expect(generation).toContain("resolveBrandVoice");
  });

  it("MERCHANT CONTEXT: the fields reach the prompt", () => {
    expect(TEXT).toContain(
      "The industry, customer type and monthly revenue you enter under Settings and My account go to the AI with every recovery email",
    );
    // 337 binding 1. This was FALSE AT HEAD when the heading map was written in
    // session 33 and the reader landed in session 45, which is the single
    // largest flip in the map refresh.
    const generation = readFileSync(
      fileURLToPath(new URL("../app/lib/recovery/email-generation.ts", import.meta.url)),
      "utf8",
    );
    // The prompt assembler reads them by these names and only emits a clause
    // when the merchant filled the field in, which is why the guide says the
    // copy simply omits the context rather than inventing it.
    expect(generation).toContain("if (merchant.industry)");
    expect(generation).toContain("if (merchant.customerType)");
  });

  it("TEAM: the invite link lasts seven days", () => {
    // J73: Foxhound shows the link to the owner and sends no invite email, so
    // the sentence says that rather than "They get a link".
    expect(TEXT).toContain("Send it to them yourself: Foxhound does not email it. It stays valid for seven days.");
    expect(INVITE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("TEAM: the owner cannot be removed", () => {
    expect(TEXT).toContain("Access ends immediately, and the owner cannot be removed at all.");
    const account = readFileSync(
      fileURLToPath(new URL("../app/lib/auth/account.ts", import.meta.url)),
      "utf8",
    );
    expect(account).toContain('reason: "is_owner"');
    expect(MEMBER_ROLE.OWNER).toBe("owner");
  });

  it("MULTI-ACCOUNT: several accounts under one login, and no page mixes two", () => {
    expect(TEXT).toContain(
      "One Foxhound login can hold several accounts, each with its own Stripe connection, settings, dashboard and invoices.",
    );
    expect(TEXT).toContain("Nothing on any page mixes two accounts together.");
    // The switcher (phase e) and the switch action (phase b). The no-mixing
    // half is what session 63's differential proved across every surface.
    const routes = readFileSync(
      fileURLToPath(new URL("../app/routes.ts", import.meta.url)),
      "utf8",
    );
    expect(routes).toContain('route("api/account/switch"');
  });

  it("CANCELLING: connections disconnect, attributed recoveries still invoice", () => {
    expect(TEXT).toContain(
      "Every Stripe connection on the account is disconnected, no further sequence runs, and the recoveries Foxhound already attributed still invoice.",
    );
    // 334 binding 2: cancelled_at stamped, every live connection disconnected,
    // recovered_payments and billing left alone.
    const merchants = readFileSync(
      fileURLToPath(new URL("../app/lib/admin/merchants.server.ts", import.meta.url)),
      "utf8",
    );
    expect(merchants).toContain("cancelMerchant");
  });
});

describe("PLANT 3: what the guide must NOT say", () => {
  it("promises nothing about a sending domain, and describes the deletion S40 built", () => {
    // Each of these is a legacy heading with no Foxhound build. A guide sentence
    // about one would be the class of claim the session 33 audit found three of.
    // Reply-to left this list at J03, when its reader and writer were built.
    // J73: Delete account is built (S40, lib/auth/deletion-copy.ts), so the
    // guide describes it in the deletion copy's terms.
    expect(TEXT).toContain("Delete account");
    expect(TEXT).toContain("Deletion cannot be undone.");
    expect(TEXT).not.toContain("sender domain");
    expect(TEXT).not.toContain("Sender domain");
  });

  it("describes the reply-to field that J03 built, and no longer says it is unread", () => {
    expect(TEXT).toContain("Reply-to email");
    expect(TEXT).toContain("Until you set one, replies go to the address in the From line.");
    expect(TEXT).not.toContain("A reply-to address is not read by the send path yet");
  });

  it("carries no wide dash anywhere in the guide", () => {
    // Enforced twice, per the brief: the PreToolUse hook blocks the write, and
    // this fails the suite if one ever arrives another way.
    expect(TEXT).not.toContain(String.fromCharCode(0x2014));
    expect(TEXT).not.toContain(String.fromCharCode(0x2013));
  });
});
