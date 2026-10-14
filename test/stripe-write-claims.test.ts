import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildResubscribeSessionParams } from "~/lib/card-update/service";

// WHAT FOXHOUND DOES WITH A MERCHANT'S read_write GRANT, SAID TRUTHFULLY
// (job_c6d167f29506).
//
// WHAT WAS WRONG. Eight public surfaces said Foxhound writes to a connected
// Stripe account in "three places" (retrying a failed invoice, setting a default
// payment method after a card update, submitting approved dispute evidence), and
// four of them added that it "never creates a charge outside an invoice you
// already issued". Both were false: the win-back resubscribe link
// (createResubscribeSession in app/lib/card-update/service.ts) opens a Checkout
// Session in subscription mode on the connected account, and a completed
// checkout makes a new subscription, invoice and charge.
//
// THE PLANT. Every surface that lists the writes must name the resubscribe
// checkout in the same sentence, no surface may state a count of write places
// (a count has to be kept in step by hand, and it already drifted once), and
// the "outside an invoice" sentence may not come back. The code fact the copy
// rests on is pinned below too, so the disclosure cannot outlive the code.
//
// /connect (app/routes/auth/connect.tsx) is left out on purpose: PR #65 rewrites
// that page and its panel, and carries the same fix there. /audit/connect is
// left out because the audit's grant is read_only.

const ROOT = new URL("../", import.meta.url);

/** Source with block and whole-line comments removed and whitespace collapsed,
 *  so copy wrapped across JSX lines reads as one sentence. */
const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, ROOT)), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join(" ")
    .replace(/\s+/g, " ");

const SURFACES = [
  "app/lib/marketing/docs-content.ts",
  "app/routes/files/llms.ts",
  "app/routes/files/llms-full.ts",
  "app/routes/privacy.tsx",
  "app/routes/security.tsx",
  "app/routes/features.tsx",
  "app/routes/home.tsx",
  "app/lib/compare/competitors.ts",
] as const;

/** Every sentence on a surface that lists the connected-account writes. Every
 *  such list names both the default payment method and the dispute evidence
 *  writes, so the pair marks one. */
const writeListSentences = (body: string) =>
  body
    .split(/(?<=[.;])\s/)
    .filter((s) => /default payment method/i.test(s) && /dispute evidence/i.test(s));

describe("the public copy says what the read_write grant is used for", () => {
  it.each(SURFACES)("%s lists the writes at least once", (path) => {
    expect(writeListSentences(read(path)).length).toBeGreaterThan(0);
  });

  it.each(SURFACES)("%s names the win-back resubscribe checkout wherever it lists the writes", (path) => {
    for (const sentence of writeListSentences(read(path))) {
      expect(sentence, sentence).toMatch(/resubscribe/i);
    }
  });

  it.each(SURFACES)("%s states no count of write places", (path) => {
    expect(read(path).match(/\b(?:writes?|write half)\b[^.]{0,40}\b(?:two|three|four|five|six) (?:places|things)\b/i)?.[0] ?? null).toBeNull();
  });

  it.each(SURFACES)("%s no longer says a charge never happens outside an issued invoice", (path) => {
    expect(read(path).match(/[^.]*outside an invoice[^.]*/i)?.[0] ?? null).toBeNull();
  });
});

describe("the code fact the disclosure rests on", () => {
  it("the resubscribe Checkout Session is in subscription mode, so completing it creates a subscription", () => {
    const params = buildResubscribeSessionParams({
      customerId: "cus_sample",
      priceId: "price_sample",
      quantity: 1,
      winBackSequenceId: "wb_sample",
      winBackStepNumber: 1,
      successUrl: "https://example.com/ok",
      cancelUrl: "https://example.com/cancel",
    });
    expect(params.mode).toBe("subscription");
  });

  it("every Stripe write call in app/ is one this copy and the PR body account for", () => {
    // A new write call fails this test, so whoever adds it has to decide
    // whether the public copy above still tells the truth. The first group
    // runs on a merchant's connected account; the second on Foxhound's own
    // platform account (billing the merchant, and the OAuth handshake).
    const WRITE = new RegExp(
      String.raw`\.((?:checkout\.sessions|billingPortal\.sessions|invoices|invoiceItems|creditNotes|customers|subscriptions|subscriptionItems|subscriptionSchedules|disputes|refunds|charges|paymentIntents|setupIntents|paymentMethods|webhookEndpoints|prices|products|coupons|promotionCodes|transfers|payouts|oauth)\.` +
        String.raw`(?:create|update|del|pay|finalizeInvoice|voidInvoice|markUncollectible|sendInvoice|cancel|resume|attach|detach|confirm|capture|close|expire|deauthorize|token))\(`,
      "g",
    );
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(fileURLToPath(new URL(dir, ROOT)))) {
        const rel = `${dir}${name}`;
        if (statSync(fileURLToPath(new URL(rel, ROOT))).isDirectory()) walk(`${rel}/`);
        else if (/\.tsx?$/.test(name)) {
          for (const m of read(rel).matchAll(WRITE)) found.push(`${rel} ${m[1]}`);
        }
      }
    };
    walk("app/");
    expect(found.sort()).toEqual(
      [
        // Connected account.
        "app/lib/engine/execute-step.ts invoices.pay",
        "app/lib/card-update/service.ts checkout.sessions.create",
        "app/lib/card-update/service.ts checkout.sessions.create",
        "app/lib/card-update/service.ts customers.update",
        "app/lib/card-update/service.ts subscriptions.update",
        "app/lib/disputes/submission.ts disputes.update",
        // Platform account.
        "app/lib/billing/stripe-invoice.ts invoices.create",
        "app/lib/billing/stripe-invoice.ts invoiceItems.create",
        "app/lib/billing/stripe-invoice.ts invoices.finalizeInvoice",
        "app/lib/billing/stripe-invoice.ts invoices.finalizeInvoice",
        "app/lib/billing/stripe-invoice.ts invoices.pay",
        "app/lib/billing/stripe-invoice.ts creditNotes.create",
        "app/lib/billing/platform-customer.ts customers.create",
        "app/lib/billing/platform-customer.ts checkout.sessions.create",
        "app/lib/billing/platform-customer.ts customers.update",
        "app/lib/stripe/connect.ts oauth.token",
        "app/lib/stripe/connect.ts oauth.deauthorize",
      ].sort(),
    );
  });
});
