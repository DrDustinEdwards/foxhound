import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  RETENTION_AI_CALLS_DAYS,
  RETENTION_EMAIL_SENDS_DAYS,
  RETENTION_ENGAGEMENT_DAYS,
  RETENTION_WEBHOOK_EVENTS_DAYS,
  STRIPE_AUDIT_SCOPE,
  STRIPE_CONNECT_SCOPE,
} from "~/lib/constants";
import { DENIED_TOOL_FRAGMENTS } from "~/lib/mcp/registry";
import { STATIC_PAGES } from "~/routes/files/sitemap";
import { GOVERNING_LAW_JURISDICTION, SUPPORT_EMAIL } from "~/lib/seo/jsonld";

const ROOT = new URL("../", import.meta.url);

/**
 * Source with BLOCK COMMENTS STRIPPED and whitespace collapsed (387).
 *
 * The module header explains at length that no attestation claim appears on this
 * page, and it names the claims it is refusing: SOC 2, penetration test,
 * bank-grade. An absence check over raw source would therefore find the forbidden
 * phrases inside the comment that forbids them, which is session 57's trap and
 * the fourth time this campaign has recorded it. Line comments are left alone
 * because the naive stripper eats every https:// in a file.
 */
const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, ROOT)), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    // LINE COMMENTS TOO, but only where the line STARTS with one, which is the
    // established shape in this repo: a blanket `//` strip eats every https:// in
    // a file. Lines are filtered BEFORE whitespace is collapsed, because
    // collapsing first destroys the line structure this depends on.
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")
    .replace(/\s+/g, " ");

const page = read("app/routes/security.tsx");
const privacy = read("app/routes/privacy.tsx");
const footer = read("app/components/footer.tsx");

// 377 ITEM 11: /security states what ships and nothing that does not.

describe("PLANT 1: NO ATTESTATION CLAIM APPEARS", () => {
  it("none of the forbidden claims is on the page", () => {
    // 377 item 11: no attestation claim of any kind until an auditor has signed
    // one. These are the phrases a reader would take as certification.
    const FORBIDDEN = [
      "SOC 2",
      "SOC2",
      "pentest",
      "penetration test",
      "audited by",
      "bank-grade",
      "bank grade",
      "ISO 27001",
      "PCI DSS",
      "HIPAA",
      "certified",
    ];
    expect(FORBIDDEN.length).toBeGreaterThan(0);
    expect(page.length, "the page read empty").toBeGreaterThan(2000);
    for (const claim of FORBIDDEN) {
      expect(page.toLowerCase(), `/security claims ${claim}`).not.toContain(claim.toLowerCase());
    }
  });

  it("and it says outright that there is no certification", () => {
    // Silence about certification reads as modesty; saying it reads as a fact a
    // buyer can rely on. 377 item 11 wants the second.
    expect(page).toContain("holds no third-party security certification");
    expect(page).toContain("until an assessor has signed one");
  });
});

describe("PLANT 2: every factual claim is pinned to what makes it true", () => {
  it("THE OAUTH SCOPES COME FROM THE CONSTANTS THE OAUTH CALLS SEND", () => {
    // Derived, not typed: if 362 ruling 1's read-only audit scope ever changed,
    // this page would be describing a permission Foxhound no longer requests.
    expect(STRIPE_AUDIT_SCOPE).toBe("read_only");
    expect(STRIPE_CONNECT_SCOPE).toBe("read_write");
    expect(page).toContain("{STRIPE_AUDIT_SCOPE} scope");
    expect(page).toContain("{STRIPE_CONNECT_SCOPE} scope");
  });

  it("the three writes are named, and only three", () => {
    expect(page).toContain("retrying payment on an invoice that has already failed");
    expect(page).toContain("setting a customer default payment method");
    expect(page).toContain("submitting dispute evidence");
    expect(page).toContain("exactly three places");
  });

  it("THE RETENTION WINDOWS COME FROM THE CONSTANTS THE SWEEPERS DELETE ON", () => {
    // EACH CLAIM PINS TO ITS OWN CONSTANT. Engagement and email sends happen to
    // share a window today, as do webhooks and AI calls, so one interpolation
    // could have covered two claims and gone silently wrong the day either
    // moved. Four claims, four constants.
    for (const days of [
      RETENTION_ENGAGEMENT_DAYS,
      RETENTION_EMAIL_SENDS_DAYS,
      RETENTION_WEBHOOK_EVENTS_DAYS,
      RETENTION_AI_CALLS_DAYS,
    ]) {
      expect(days).toBeGreaterThan(0);
    }
    expect(page).toContain("{RETENTION_ENGAGEMENT_DAYS} days");
    expect(page).toContain("{RETENTION_EMAIL_SENDS_DAYS} days");
    expect(page).toContain("{RETENTION_WEBHOOK_EVENTS_DAYS} days");
    expect(page).toContain("{RETENTION_AI_CALLS_DAYS}");
  });

  it("THE SUBPROCESSORS MATCH /privacy, which is the authoritative carrier", () => {
    // Two pages naming different subprocessors is a worse failure than either
    // naming none, so this compares the two rather than pinning a list.
    const SUBPROCESSORS = ["Stripe", "Cloudflare", "Anthropic"];
    expect(privacy.length).toBeGreaterThan(2000);
    for (const name of SUBPROCESSORS) {
      expect(privacy, `/privacy does not name ${name}`).toContain(name);
      expect(page, `/security does not name ${name}`).toContain(name);
    }
    // And /security defers to /privacy in the text, so a reader knows which wins.
    expect(page).toContain("that list is the authoritative one");
  });

  it("the never-exposed API actions match the MCP denylist", () => {
    // Same tie as the Terms carve-out: the page promises these are unavailable
    // to a key, and the registry is what makes that true.
    expect(DENIED_TOOL_FRAGMENTS.length).toBeGreaterThan(0);
    for (const fragment of ["submit_dispute", "disconnect", "connect_stripe", "record_outcome"]) {
      expect(DENIED_TOOL_FRAGMENTS, `${fragment} is not denied`).toContain(fragment);
    }
    expect(page).toContain("submitting dispute evidence, connecting or disconnecting Stripe");
  });
});

describe("PLANT 3: the page carries the rest of 377 item 11's list", () => {
  it("card data, encryption, sessions, disclosure, DPA and the entity", () => {
    expect(page).toContain("No card number, expiry or CVC ever reaches Foxhound");
    expect(page).toContain("AES-256-GCM");
    expect(page).toContain("keyring");
    expect(page).toContain("sessions are stored in Cloudflare D1");
    expect(page).toContain("data processing agreement is available on request");
    expect(page).toContain("{SUPPORT_EMAIL}");
    expect(SUPPORT_EMAIL).toContain("@");
    expect(page).toContain("{GOVERNING_LAW_JURISDICTION}");
    expect(GOVERNING_LAW_JURISDICTION).toBe("Texas");
  });

  it("the disclosure route points at the security.txt contact", () => {
    expect(page).toContain("/.well-known/security.txt");
    expect(page).toContain("RFC 9116");
  });
});

describe("PLANT 4: the page is reachable", () => {
  it("it is in the sitemap", () => {
    const paths = STATIC_PAGES.map((p) => p.path);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths).toContain("/security");
    // Beside the other two legal pages, so a future tidy cannot drop one.
    expect(paths).toContain("/privacy");
    expect(paths).toContain("/terms");
  });

  it("it is in the footer, next to Privacy and Terms", () => {
    expect(footer).toContain('to: "/security"');
    expect(footer).toContain('to: "/privacy"');
    expect(footer).toContain('to: "/terms"');
  });

  it("and the footer carries the entity line (377 item 11)", () => {
    expect(footer).toContain("Operated by Dustin Edwards, sole proprietor, Texas");
  });
});
