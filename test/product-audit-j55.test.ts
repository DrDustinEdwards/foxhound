import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { buildAuditSummaryPrompt } from "~/lib/audit/summary";
import type { AuditResult } from "~/lib/audit/engine";
import { cloudflareContext } from "~/lib/cloudflare-context";
import {
  AUDIT_LOOKBACK_DAYS,
  AUDIT_TOKEN_TTL_SECONDS,
  CRON_SCHEDULE_MONTHLY_AUDIT,
  STRIPE_AUDIT_SCOPE,
} from "~/lib/constants";
import routes from "~/routes";
import AuditProductPage, { loader } from "~/routes/products/audit";

// J55 (job_35fce978e1df), the Audit spoke, row M6. Recova's spec, read whole at
// HEAD: app/(marketing)/product/audit/page.tsx (blob 210ce79d),
// components/product/ProductSections.tsx (ba3aed7c),
// components/product/ProductFAQ.tsx (7c08a5a2) and
// components/docs/AuditScopeCard.tsx (dc1d18dd).
//
// These read the RENDERED page, fed by the route's own loader. Every fact the
// copy states is worked out here a second way, from the engine's constants and
// the summary prompt, never read back from the copy module under test.

const fakeContext = {
  get(key: unknown) {
    if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
    throw new Error("unexpected context key");
  },
};

type LoaderData = Awaited<ReturnType<typeof loader>>;

function load(): LoaderData {
  return loader({
    context: fakeContext,
    request: new Request("https://foxhoundapp.com/product/audit"),
    params: {},
  } as unknown as Parameters<typeof loader>[0]) as LoaderData;
}

function render(loaderData: LoaderData): string {
  const Page = AuditProductPage as unknown as (props: { loaderData: LoaderData }) => React.ReactElement;
  const router = createMemoryRouter([{ path: "*", element: createElement(Page, { loaderData }) }], {
    initialEntries: ["/product/audit"],
  });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

/** Text with tags stripped and the entities this page uses decoded. */
function text(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

interface RouteEntry {
  path?: string;
  index?: boolean;
  children?: RouteEntry[];
}

function routePaths(entries: RouteEntry[], parent = "", out = new Set<string>()): Set<string> {
  for (const e of entries) {
    let path = parent;
    if (e.path) {
      path = `${parent}/${e.path.replace(/^\/+|\/+$/g, "")}`;
      out.add(path);
    } else if (e.index) {
      out.add(parent === "" ? "/" : parent);
    }
    if (e.children) routePaths(e.children, path, out);
  }
  return out;
}

const html = render(load());
const body = text(html);

// Facts, worked out here from the engine.
const LOOKBACK = String(AUDIT_LOOKBACK_DAYS);
const AUTO_RUN_DAY = Number(CRON_SCHEDULE_MONTHLY_AUDIT.split(/\s+/)[2]);
const ORDINAL = AUTO_RUN_DAY === 1 ? "1st" : AUTO_RUN_DAY === 2 ? "2nd" : AUTO_RUN_DAY === 3 ? "3rd" : `${AUTO_RUN_DAY}th`;
const TOKEN_MINUTES = AUDIT_TOKEN_TTL_SECONDS / 60;

/** The sentence plan the summary prompt hands the model, read from the prompt
 *  itself so the page cannot describe a different summary from the one made. */
function promptStructure(): string[] {
  const unread = { ok: false as const, reason: "x" };
  const prompt = buildAuditSummaryPrompt({
    failedInvoices: unread,
    expiringCards: unread,
    pastDueSubscriptions: unread,
    cardUpdater: unread,
    disputes: unread,
    health: unread,
    meta: { stripeAccountId: "acct_x", lookbackDays: AUDIT_LOOKBACK_DAYS, currency: "usd", ranAt: new Date(0) },
  } as AuditResult);
  const block = prompt.slice(prompt.indexOf("STRUCTURE"), prompt.indexOf("Return only"));
  return [...block.matchAll(/^\d\. (.+)$/gm)].map((m) => m[1]);
}

describe("/product/audit follows Recova's sections, in Recova's order (J55)", () => {
  it("renders the hero, How it works, the three feature blocks, Pricing, Questions and the closing block in order", () => {
    const marks = [
      "See what your Stripe account is leaking. Free.",
      "How it works",
      "Connect Stripe",
      "Foxhound runs the diagnostic",
      "See your results",
      "What you get",
      "What it checks",
      "Four scopes. One diagnostic.",
      "Plain English",
      "A summary that tells you what matters.",
      "Track over time",
      "Results that do not disappear.",
      "Pricing",
      "Questions",
      "Your Stripe account is telling you something.",
    ];
    let at = -1;
    for (const m of marks) {
      const next = body.indexOf(m, at + 1);
      expect(next, `"${m}" comes after the mark before it`).toBeGreaterThan(at);
      at = next;
    }
  });

  it("draws Recova's three blocks as plain, lifted, plain", () => {
    const kinds = [...html.matchAll(/data-block="([a-z]+)"/g)].map((m) => m[1]);
    expect(kinds).toEqual(["plain", "lifted", "plain"]);
  });

  it("names no Recova", () => {
    expect(html).not.toMatch(/recova/i);
  });

  it("puts all three calls to action on /audit and the guide on /docs/audit", () => {
    const ctas = [...html.matchAll(/<a [^>]*href="\/audit"[^>]*>Run your free audit<\/a>/g)];
    expect(ctas).toHaveLength(3);
    expect(html).toMatch(/<a [^>]*href="\/docs\/audit"[^>]*>Read the guide/);
  });

  it("asks Recova's three questions", () => {
    const qs = [...html.matchAll(/<summary[^>]*>([\s\S]*?)<\/summary>/g)].map((m) => text(m[1]));
    expect(qs).toEqual([
      "Does the audit require a Foxhound account?",
      "What Stripe access does the audit request?",
      "How accurate is the recovery estimate?",
    ]);
  });

  it("draws Recova's audit scope card: four scopes, each with its glyph, title and line", () => {
    for (const t of ["Failed invoices", "Expiring cards", "Open disputes", "Business health"]) {
      expect(body).toContain(t);
    }
    for (const g of ["↯", "⊘", "⚖", "◎"]) expect(html).toMatch(new RegExp(`aria-hidden="true"[^>]*>${g}<`));
    expect(body).toContain("MRR, ARR, active subscriptions, and churn rate");
  });

  it("lists Recova's six pricing points", () => {
    const pricing = html.slice(html.indexOf(">Pricing<"), html.indexOf(">Questions<"));
    expect([...pricing.matchAll(/<li /g)]).toHaveLength(6);
  });
});

describe("the copy states the audit Foxhound runs (J55, RULES.md 2.1 and 2.2)", () => {
  it("states the read-only scope the audit actually requests", () => {
    expect(STRIPE_AUDIT_SCOPE).toBe("read_only");
    expect(body).toContain("Read-only OAuth connection.");
    expect(body).toContain("Read-only OAuth scope.");
    expect(body).toContain("Always free · No account required · Read-only Stripe access");
  });

  it("never says the audit's connection carries write scope", () => {
    expect(body).not.toMatch(/read and write|read_write|write scope/i);
  });

  it("reads the lookback from the engine, and claims it only for failed invoices", () => {
    // Only the uncollectible-invoice read is bounded by the lookback; open
    // invoices, subscriptions and disputes are read whole (reads.ts).
    const reads = readFileSync("app/lib/stripe/reads.ts", "utf8");
    expect(reads.match(/created: \{ gte: lookbackStartSeconds \}/g)).toHaveLength(1);
    expect(body).toContain(
      `Four scopes read your account, going back ${LOOKBACK} days for failed invoices: failed invoices, expiring cards, open disputes, and business health.`,
    );
    expect(body).not.toMatch(new RegExp(`pull ${LOOKBACK} days of data`));
  });

  it("claims no work on invoices that failed before the account connected", () => {
    // A sequence starts only from invoice.payment_failed after connect
    // (process.ts, no_failed_payment for an earlier invoice).
    expect(body).not.toMatch(/works each of these/i);
    expect(body).toContain(
      "Foxhound recovers payments like these as they fail, with a sequence matched to the decline, and bills only on what it recovers.",
    );
  });

  it("names the day the monthly audit runs from its cron", () => {
    expect(body).toContain(`on the ${ORDINAL} of each month`);
  });

  it("does not claim results live at a URL for 30 days: an anonymous run is not saved", () => {
    expect(body).not.toMatch(/30 days/);
    expect(body).toContain(`${TOKEN_MINUTES}-minute read-only session`);
    expect(body).not.toMatch(/minute read-only connection/);
  });

  it("describes the summary the prompt asks for", () => {
    const plan = promptStructure();
    expect(plan, "the prompt carries a sentence plan").toHaveLength(3);
    expect(body).toContain("three-sentence");
    for (const sentence of plan) {
      expect(body.toLowerCase()).toContain(sentence.replace(/\.$/, "").toLowerCase());
    }
  });

  it("shows no recovery estimate, baseline or platform rate, because the results show none", () => {
    expect(body).not.toMatch(/\d+(\.\d+)?%/);
    expect(body).not.toMatch(/estimated recovery value|estimates what/i);
    expect(body).toMatch(/How accurate is the recovery estimate\? The audit does not show one\./);
  });

  it("claims no dispute deadlines, which the audit's dispute read does not carry", () => {
    expect(readFileSync("app/lib/stripe/reads.ts", "utf8")).not.toMatch(/due_by/);
    expect(body).not.toMatch(/deadline/i);
  });

  it("claims no expiry window the engine does not use", () => {
    expect(body).not.toMatch(/within 30 days|next 30 days/i);
    expect(body).toContain("by the end of next month");
  });
});

describe("the page is built from Capsomer's parts, teal, on the five sizes (J55)", () => {
  it("sits in Capsomer's teal family with Foxhound's neutrals", () => {
    expect(html).toMatch(/^<div class="fh-cap[^"]*" data-family="teal"/);
  });

  it("draws every call to action as Capsomer's primary button", () => {
    const ctas = [...html.matchAll(/<a [^>]*>Run your free audit<\/a>/g)].map((m) => m[0]);
    expect(ctas).toHaveLength(3);
    for (const a of ctas) {
      expect(a).toMatch(/class="cap-btn"/);
      expect(a).toContain('data-variant="primary"');
    }
  });

  it("puts the FAQ in Capsomer's disclosure, one open at a time", () => {
    const details = [...html.matchAll(/<details class="cap-disclosure" name="audit-faq">/g)];
    expect(details).toHaveLength(3);
  });

  it("carries no amber anywhere", () => {
    expect(html).not.toMatch(/amber/i);
  });

  it("uses only the five standard text sizes, never an arbitrary text-[ value", () => {
    const FIVE = new Set(["text-display", "text-title", "text-body", "text-label", "text-micro"]);
    const COLOUR =
      /^text-(text|text-secondary|text-tertiary|text-subtle|accent-text|green|success-text|error-text|caution|center|left|right)$/;
    expect(html).not.toMatch(/text-\[/);
    const sizes: string[] = [];
    for (const m of html.matchAll(/class="([^"]*)"/g)) {
      for (const c of m[1].split(/\s+/)) {
        const base = c.replace(/^[a-z0-9-]+:/g, "");
        if (base.startsWith("text-") && !COLOUR.test(base)) sizes.push(base);
      }
    }
    expect(sizes.length, "the page carries size classes to check").toBeGreaterThan(0);
    for (const s of sizes) expect(FIVE.has(s), `${s} is one of the five`).toBe(true);
  });

  it("draws no chart, because Recova draws none on this page", () => {
    expect(html).not.toMatch(/<svg[^>]*role="img"/);
  });

  it("points every internal link at a route that exists", () => {
    const paths = routePaths(routes as RouteEntry[]);
    expect(paths.has("/audit"), "the matcher finds a known route").toBe(true);
    const hrefs = [...html.matchAll(/href="(\/[^"#?]*)/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) {
      const known =
        paths.has(h) ||
        [...paths].some((p) => p.includes(":") && new RegExp(`^${p.replace(/:[^/]+/g, "[^/]+")}$`).test(h));
      expect(known, `${h} is a route`).toBe(true);
    }
  });

  it("keeps the SpeakableSpecification pointing at classes the page carries", () => {
    const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
    const json = JSON.parse(ld) as { url: string; speakable: { cssSelector: string[] } };
    expect(json.speakable.cssSelector).toEqual([".speakable-hero", ".speakable-description", ".speakable-features"]);
    for (const sel of json.speakable.cssSelector) expect(html).toContain(sel.slice(1));
  });

  it("leaves no spoke on the pre-Capsomer sections", () => {
    expect(readFileSync("app/routes/products/audit.tsx", "utf8")).toContain("~/components/product-sections-cap");
  });
});
