// Competitor comparison data for /compare (Phase 6 Pass 3, net-new).
//
// SOURCING DISCIPLINE (TASK-foxhound-phase6.md): every Foxhound-side row is
// stated plainly from PRICING.md/DESIGN.md canon. Every competitor-side
// claim is either a well-known, stable, public fact about that product
// category (checked against general payments-industry knowledge, and for
// the two least-certain products, Churn Buster and Paddle Retain, a web
// search on 2026-07-19), or omitted outright rather than invented. No
// competitor dollar amount or percentage appears here unless corroborated
// confidently; several rows below say "not published" rather than guess.
//
// Foxhound's real cons are included deliberately (task: "don't oversell"):
// newer/less proven than every incumbent here, no prevention/pre-dispute
// alerts layer yet (PRICING.md's stated V1 deferral), and Foxhound uses one
// brand-voice field for dunning copy rather than a per-category voice
// system some incumbents offer.

export interface ComparisonRow {
  dimension: string;
  foxhound: string;
  competitor: string;
}

export interface CompetitorDef {
  slug: string;
  name: string;
  oneLiner: string;
  category: string;
  rows: ComparisonRow[];
  /** Foxhound cons stated honestly against this specific competitor. */
  foxhoundCons: string[];
  /** Any competitor-side claim deliberately omitted, and why (shown in copy). */
  omittedNote?: string;
}

const FOXHOUND_PRICING_ROW: ComparisonRow = {
  dimension: "Pricing model",
  foxhound: "20% of Foxhound-attributed recoveries only. Baseline recoveries Stripe would have gotten anyway are free. Nothing billed until a recovery has matured 30 days.",
  competitor: "",
};

export const COMPETITORS: Record<string, CompetitorDef> = {
  "stripe-smart-retries": {
    slug: "stripe-smart-retries",
    name: "Stripe Smart Retries",
    oneLiner: "Stripe's own built-in retry-timing feature inside Stripe Billing, not a separate product.",
    category: "Built-in Stripe feature",
    rows: [
      {
        ...FOXHOUND_PRICING_ROW,
        competitor: "Included with Stripe Billing at no extra cost. It is a feature of Stripe itself, not a separately priced product.",
      },
      {
        dimension: "What it does",
        foxhound: "Silent retries, then AI-drafted dunning emails in the merchant's brand voice, then a hosted card-update page.",
        competitor: "Machine-learning-optimized retry timing for failed subscription charges. No dunning email authoring, no card-update page, no dispute handling.",
      },
      {
        dimension: "Disputes",
        foxhound: "Evidence drafted from Stripe data and recovery history. Merchant reviews and signs every submission before it reaches Stripe.",
        competitor: "Not offered. Smart Retries is scoped to retry timing only.",
      },
      {
        dimension: "Subscription intelligence",
        foxhound: "Free MRR, movements, churn, and cohort analytics for every Recovery merchant. Paid predictive risk scoring on top.",
        competitor: "Not offered as part of this feature.",
      },
      {
        dimension: "Attribution",
        foxhound: "Every recovery links to the exact action that caused it: retry, email click, or card update. Baseline recoveries are shown for free in the same ledger.",
        competitor: "Retry outcomes are visible in the Stripe Dashboard, but there is no separate billing or attribution layer since nothing is charged for this feature.",
      },
    ],
    foxhoundCons: [
      "Foxhound is a newer, less proven product than Stripe itself, which is the platform processing the payment in the first place.",
      "Using Foxhound alongside Smart Retries means retry logic exists in two places; Foxhound's silent-retry step is designed to run first so it never duplicates a retry Stripe was already about to attempt, but that coordination is Foxhound's responsibility to get right, not something Stripe guarantees on its side.",
    ],
  },

  churnkey: {
    slug: "churnkey",
    name: "Churnkey",
    category: "Retention and cancellation-flow platform",
    oneLiner: "A cancellation-flow and retention platform (save offers, downgrade paths) that also offers payment recovery.",
    rows: [
      {
        ...FOXHOUND_PRICING_ROW,
        competitor: "Not published as a flat public rate; Churnkey's pricing is not stated here rather than guessed.",
      },
      {
        dimension: "What it does",
        foxhound: "Failed-payment recovery, dispute handling, and subscription intelligence for Stripe merchants specifically.",
        competitor: "Primarily known for cancellation-flow modals (retention offers, downgrade paths, save flows) with payment recovery as an additional module, marketed heavily to consumer subscription (D2C) brands.",
      },
      {
        dimension: "Disputes",
        foxhound: "Evidence drafted automatically, human-approved before every submission, capped fee only on wins.",
        competitor: "Not a focus area of the product's public positioning.",
      },
      {
        dimension: "Cancellation flows",
        foxhound: "Not offered. Foxhound is scoped to recovery, disputes, and intelligence, not retention/save-offer flows at cancellation.",
        competitor: "A core, differentiated part of the product.",
      },
    ],
    foxhoundCons: [
      "Foxhound has no cancellation-flow or save-offer product at all; if that is the primary need, Churnkey is built specifically for it and Foxhound is not.",
      "Foxhound is newer and has no comparable public track record yet.",
    ],
    omittedNote: "Churnkey's specific pricing structure is not published as a simple public rate, so it is stated as unavailable here rather than estimated.",
  },

  "churn-buster": {
    slug: "churn-buster",
    name: "Churn Buster",
    category: "Dedicated dunning and recovery tool",
    oneLiner: "One of the longest-running dedicated failed-payment recovery tools for Stripe and Recurly.",
    rows: [
      {
        ...FOXHOUND_PRICING_ROW,
        competitor: "A flat monthly subscription tier rather than a percentage of recovered revenue, billed regardless of how much (or how little) gets recovered in a given month.",
      },
      {
        dimension: "What it does",
        foxhound: "Silent retries first, then AI-drafted dunning email sequences across 30 days, tuned to four decline categories.",
        competitor: "Dunning email sequences for failed payments, plus account-management support from a human team on top of the software.",
      },
      {
        dimension: "Disputes",
        foxhound: "Evidence drafted automatically from Stripe and recovery history; merchant reviews and signs every submission.",
        competitor: "Not a core part of the product's public positioning.",
      },
      {
        dimension: "Cost when nothing is recovered",
        foxhound: "Zero. The fee only applies to attributed recoveries.",
        competitor: "The flat subscription still applies even in a month with little or no recovered revenue.",
      },
    ],
    foxhoundCons: [
      "Foxhound is a newer entrant against a product with a long operating history in this specific niche.",
      "Foxhound's dunning copy comes from one brand-voice field per merchant; a team-supported service can hand-tune messaging more directly if that level of white-glove attention matters more than automation.",
    ],
  },

  "paddle-retain": {
    slug: "paddle-retain",
    name: "Paddle Retain",
    category: "Recovery tool bundled with a merchant-of-record platform",
    oneLiner: "Formerly ProfitWell Retain; failed-payment dunning and retry orchestration, now part of Paddle.",
    rows: [
      {
        ...FOXHOUND_PRICING_ROW,
        competitor: "Priced as a percentage of recovered revenue when used standalone; bundled at no separate charge for merchants already using Paddle as their merchant of record.",
      },
      {
        dimension: "What it does",
        foxhound: "Runs directly against your own Stripe account: silent retries, dunning emails, card-update page, disputes, and intelligence in one product.",
        competitor: "Involuntary-churn recovery: failed-payment dunning, retry orchestration, and account-update emails, most naturally suited to merchants already on Paddle's billing platform.",
      },
      {
        dimension: "Merchant-of-record requirement",
        foxhound: "None. Foxhound connects read-only (and later read-write for recovery actions) to your existing Stripe account; you remain the merchant of record.",
        competitor: "Most value is realized on Paddle's own platform, where Paddle is the merchant of record rather than the business using its own direct Stripe account.",
      },
      {
        dimension: "Disputes",
        foxhound: "Evidence drafted automatically, human-approved, 20% of wins capped at $500.",
        competitor: "Not the product's primary focus.",
      },
    ],
    foxhoundCons: [
      "Foxhound is a newer, less proven product than an offering descended from ProfitWell's long operating history.",
      "If a business is already committed to Paddle as its merchant of record, the bundled option may already be effectively free for that specific use case.",
    ],
  },

  "baremetrics-recover": {
    slug: "baremetrics-recover",
    name: "Baremetrics Recover",
    category: "Recovery module inside an analytics suite",
    oneLiner: "A dunning/recovery module bundled inside Baremetrics' subscription analytics suite.",
    rows: [
      {
        ...FOXHOUND_PRICING_ROW,
        competitor: "Sold as part of Baremetrics' tiered subscription analytics plans rather than as a standalone product with its own separate price.",
      },
      {
        dimension: "What it does",
        foxhound: "A dedicated recovery, disputes, and intelligence product for Stripe merchants.",
        competitor: "Failed-payment recovery as one module alongside Baremetrics' broader analytics suite (MRR/churn dashboards, forecasting, cancellation insights).",
      },
      {
        dimension: "Disputes",
        foxhound: "Evidence drafted automatically from transaction and recovery history, human-approved before submission, capped fee only on wins.",
        competitor: "Not part of the Baremetrics suite.",
      },
      {
        dimension: "Standalone MRR analytics",
        foxhound: "Free MRR, movements, churn, and cohort analytics bundled with every Recovery account; paid predictive risk scoring on top.",
        competitor: "A comprehensive, mature analytics suite is the core product, with Recover as one add-on module inside it.",
      },
    ],
    foxhoundCons: [
      "Foxhound's free analytics tier is newer and narrower in scope than Baremetrics' full, long-established analytics suite.",
      "Foxhound is unproven relative to an established analytics vendor most merchants already know by name.",
    ],
  },

  stunning: {
    slug: "stunning",
    name: "Stunning",
    category: "Dedicated dunning-email tool",
    oneLiner: "One of the original standalone dunning-email tools for recovering failed Stripe payments.",
    rows: [
      {
        ...FOXHOUND_PRICING_ROW,
        competitor: "A flat monthly subscription, typically tiered by active subscriber count, rather than a percentage of what gets recovered.",
      },
      {
        dimension: "What it does",
        foxhound: "Silent retries first, then AI-drafted dunning emails across 30 days, then disputes and intelligence in the same product.",
        competitor: "Automated dunning-email sequences for failed Stripe payments. Scoped narrowly to email-based recovery.",
      },
      {
        dimension: "Silent retries before email",
        foxhound: "Yes, a scheduled retry runs before any customer-facing email so a quietly recoverable payment is never dunned unnecessarily.",
        competitor: "Not a stated feature; the product's public positioning centers on the email sequence itself.",
      },
      {
        dimension: "Disputes and intelligence",
        foxhound: "Both included in the same product: human-approved dispute evidence and free MRR analytics.",
        competitor: "Not offered; the product is scoped to dunning emails.",
      },
      {
        dimension: "Cost when little is recovered",
        foxhound: "Zero. Fee only applies to attributed recoveries.",
        competitor: "The flat subscription tier still applies regardless of how much is actually recovered that month.",
      },
    ],
    foxhoundCons: [
      "Foxhound is newer than one of the category's original entrants.",
      "A flat monthly fee is simpler to budget for than an outcome-based percentage, if predictability matters more than paying only for results.",
    ],
  },
};

export const COMPETITOR_ORDER = [
  "stripe-smart-retries",
  "churnkey",
  "churn-buster",
  "paddle-retain",
  "baremetrics-recover",
  "stunning",
] as const;
