import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import {
  DISPUTE_FEE_BPS,
  DISPUTE_FEE_CAP_CENTS,
  EMAIL_ENGAGEMENT_WINDOW_DAYS,
  INTELLIGENCE_PRICE_CENTS,
  RECOVERY_FEE_BPS,
  RECOVERY_MATURITY_DAYS,
} from "~/lib/constants";
import {
  DECLINE_CATEGORY_COUNT,
  DECLINE_CATEGORY_COUNT_WORD,
  DECLINE_CATEGORY_COUNT_WORD_LOWER,
} from "~/lib/marketing/decline-categories";
import { formatMoneyShort } from "~/lib/money-format";
import { RECOVERY_SCHEDULES } from "~/lib/recovery/schedule";
import PricingPage, { meta as pricingMeta } from "~/routes/pricing";

// J54 (job_72985caa71f1), row M4: /pricing's copy. The wording is FROZEN for
// the claims pass (RULES.md 2.2, m4.txt: card price labels, header subtext, CTA
// microcopy, every feature bullet, card descriptions, FAQ answers and the meta
// description). Only the mechanism moves: every number is read from Foxhound's
// engine constants, never typed (RULES.md 2.1). This file pins the rendered
// text, word for word, with each number built here from the same constants.
//
// One value changed because the constant said something else: the Recovery
// bullet read "across 4 decline categories" against an engine that schedules
// six (DECLINE_CATEGORY_COUNT, the count 376 item 18 derived for the card
// description but left typed in the bullet). The constant wins.
//
// pricing-j54-derivation.test.ts moves the constants and expects the page to
// move with them, which is what proves the numbers are read and not typed.

const pct = (bps: number) => `${bps / 100}%`;
const usd = (cents: number) => formatMoneyShort(cents, "usd");
/** The longest recovery sequence in days, read from the schedule the engine runs. */
const SEQ_DAYS = Math.round(
  Math.max(...Object.values(RECOVERY_SCHEDULES).flatMap((steps) => steps.map((s) => s.offsetHours))) / 24,
);

/** React's text escaping, so a string compares with the markup it renders to. */
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

function render(): string {
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: createElement(PricingPage as never, { loaderData: { siteUrl: "https://example.com" } }),
      },
    ],
    { initialEntries: ["/pricing"] },
  );
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

const SPEC = [
  {
    name: "Audit",
    price: "Free",
    priceLabel: null,
    description:
      "Full Stripe diagnostic. Failed invoices, expiring cards, open disputes, and business health. No account required.",
    features: [
      "Failed invoice analysis",
      "Expiring cards timeline",
      "Open dispute summary",
      "Business health metrics",
      "No signup required",
    ],
  },
  {
    name: "Recovery",
    price: pct(RECOVERY_FEE_BPS),
    priceLabel: "of Foxhound-attributed recoveries",
    description: `Silent retries first, then AI-drafted email sequences across ${SEQ_DAYS} days. ${DECLINE_CATEGORY_COUNT_WORD} decline categories, ${DECLINE_CATEGORY_COUNT_WORD_LOWER} different sequences.`,
    features: [
      "Silent retry before any customer email",
      `${SEQ_DAYS}-day sequences across ${DECLINE_CATEGORY_COUNT} decline categories`,
      "Baseline recoveries Stripe would have gotten anyway are free",
      `No fee until the recovery has matured ${RECOVERY_MATURITY_DAYS} days`,
      "Card-update link on every email",
      "Open and click tracking",
      "No monthly fee",
    ],
  },
  {
    name: "Disputes",
    price: pct(DISPUTE_FEE_BPS),
    priceLabel: `of won disputes, capped at ${usd(DISPUTE_FEE_CAP_CENTS)}`,
    description:
      "Evidence drafted from your Stripe data and recovery history. You review and sign every submission.",
    features: [
      "Evidence drafted from transaction history",
      "Recovery email history included",
      "Draft, review, approve, submit, every time",
      "No auto-submit toggle, there never has been one",
      `${pct(DISPUTE_FEE_BPS)} only when Foxhound wins, capped at ${usd(DISPUTE_FEE_CAP_CENTS)}`,
    ],
  },
  {
    name: "Intelligence",
    price: usd(INTELLIGENCE_PRICE_CENTS),
    priceLabel: "per month for predictive risk scoring",
    description:
      "MRR, movements, churn, and cohort analytics are free for every Recovery merchant. Predictive risk scoring is the paid layer.",
    features: [
      "MRR, movements, churn, cohorts: free for Recovery merchants",
      `Predictive risk scoring: the paid ${usd(INTELLIGENCE_PRICE_CENTS)}/mo layer`,
      "Health signals feed Recovery timing and Disputes triage",
      "Account-wide, not per-customer",
      "Granted during early access; ask us",
    ],
  },
] as const;

const FAQ_SPEC = [
  {
    question: "Is there a free trial?",
    answer:
      "Audit is always free with no account required. Recovery and Disputes have no trial period because they only charge on outcomes, so there is no upfront cost. If Foxhound doesn't recover anything, you pay nothing.",
  },
  {
    question: 'What counts as a "recovered" payment?',
    answer: `A payment is recovered when a Foxhound action provably preceded payment: a scheduled retry succeeded, a dunning email was clicked or otherwise engaged, or a card was updated through a Foxhound page. A click counts only if it came within ${EMAIL_ENGAGEMENT_WINDOW_DAYS} days before the payment, and a click Foxhound marks suspect, such as one from a mail scanner following links, is shown on the ledger and never billed. Payments Stripe's own Smart Retries recover independently are recorded as free and never billed.`,
  },
  {
    question: "When am I actually billed?",
    answer: `Each monthly run bills the prior month's matured recoveries, meaning recoveries you've held for ${RECOVERY_MATURITY_DAYS} or more days. We never bill a recovery before then.`,
  },
  {
    question: "Can I use multiple products together?",
    answer:
      "Yes. Each product works standalone and its pricing is independent. Used together, Recovery data improves Disputes evidence, and Intelligence signals improve Recovery timing.",
  },
] as const;

/** The card container: Recova's 1200px grid, through the end of its section. */
function cardSection(html: string): string {
  const at = html.indexOf("max-w-[1200px]");
  expect(at, "the 1200px card container is on the page").toBeGreaterThan(-1);
  return html.slice(at, html.indexOf("</section>", at));
}

describe("/pricing copy is Foxhound's frozen wording, numbers read from the engine (J54, row M4)", () => {
  const html = render();
  const section = cardSection(html);

  it("the sequence length the copy states is a real schedule, not zero", () => {
    // The derivation must find something, or every equality below is vacuous.
    expect(SEQ_DAYS).toBeGreaterThan(0);
    expect(DECLINE_CATEGORY_COUNT).toBeGreaterThan(0);
  });

  it.each(SPEC)("$name card renders its price, label, description and every bullet", (card) => {
    expect(section).toContain(`>${esc(card.name)}<`);
    expect(section).toContain(`>${esc(card.price)}<`);
    if (card.priceLabel) expect(section).toContain(`>${esc(card.priceLabel)}<`);
    expect(section).toContain(`>${esc(card.description)}<`);
    for (const f of card.features) expect(section, f).toContain(`<span>${esc(f)}</span>`);
  });

  it("the cards carry no bullet beyond the frozen list", () => {
    const bullets = [...section.matchAll(/<li [^>]*>[\s\S]*?<span>([^<]*)<\/span><\/li>/g)].map((m) => m[1]);
    expect(bullets).toHaveLength(SPEC.reduce((n, c) => n + c.features.length, 0));
  });

  it.each(FAQ_SPEC)("FAQ: $question", ({ question, answer }) => {
    expect(html).toContain(`>${esc(question)}<`);
    expect(html).toContain(`>${esc(answer)}<`);
  });

  it("the meta description keeps its words, with the maturity window read from the constant", () => {
    const tags = pricingMeta({ loaderData: { siteUrl: "https://example.com" } } as never);
    expect(tags.find((t) => "title" in t)?.title).toBe("Pricing - Foxhound");
    expect(tags.find((t) => (t as { name?: string }).name === "description")?.content).toBe(
      `Pay when Foxhound recovers. Baseline recoveries Stripe would have gotten anyway are free. Nothing billed until the recovery has matured for ${RECOVERY_MATURITY_DAYS} days.`,
    );
  });
});

describe("no number is typed in /pricing's source (RULES.md 2.1)", () => {
  const ROOT = new URL("../", import.meta.url);
  /** Source with comments stripped: the comments may name a figure they explain. */
  const code = (path: string) => {
    const file = fileURLToPath(new URL(path, ROOT));
    expect(existsSync(file), `${path} exists`).toBe(true);
    return readFileSync(file, "utf8")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
  };

  // Each pattern is a shape a typed price or engine figure takes in this copy.
  const TYPED: [string, RegExp][] = [
    ["a percentage", /\d+\s*%/],
    ["a dollar figure", /\$\d/],
    ["a day count", /\b\d+(?:-|\s+)days?\b/],
    ["a day count stated as a maturity floor", /\b\d+\s+or more days\b/],
    ["a decline-category count", /\b\d+\s+decline categor/],
  ];

  it("the scan finds a typed figure where one exists (positive control)", () => {
    const planted = 'price: "20%", label: "capped at $500", "30-day sequences across 4 decline categories", "held for 30 or more days"';
    for (const [what, re] of TYPED) expect(re.test(planted), what).toBe(true);
  });

  it.each(["app/routes/pricing.tsx", "app/lib/marketing/pricing-copy.ts"])("%s types no price or engine figure", (path) => {
    const src = code(path);
    expect(src.length).toBeGreaterThan(500);
    for (const [what, re] of TYPED) expect(src.match(re)?.[0], `${path} types ${what}`).toBeUndefined();
  });
});
