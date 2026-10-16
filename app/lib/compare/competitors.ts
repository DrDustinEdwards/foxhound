// Competitor comparison data for /compare (Phase 6 Pass 3, net-new).
import { DECLINE_CATEGORY_COUNT_WORD_LOWER, RECOVERY_SEQUENCE_DAYS } from "~/lib/marketing/decline-categories";
//
// SOURCING DISCIPLINE (TASK-foxhound-phase6.md): every Foxhound-side row is
// stated plainly from PRICING.md/DESIGN.md canon. Every competitor-side
// claim is reconciled against recova/phase6-content-comparisons.md (the
// dedicated content pass's researched facts), or omitted outright rather
// than invented. No competitor dollar amount or percentage appears here
// unless corroborated confidently; rows below say "not published" or
// "custom-quoted" rather than guess. Pricing rows were corrected once
// against that doc after a Phase 6 review found several understated a
// figure that was already known (treating a published rate as "not
// published") and one, Paddle Retain, stated a current standalone price
// with no support in the sourced facts; see recova/foxhound-phase6-review.md
// finding 11.
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
      "Using Foxhound alongside Smart Retries means retry logic exists in two places; wherever the decline can be retried, Foxhound's silent-retry step is designed to run first so it never duplicates a retry Stripe was already about to attempt, but that coordination is Foxhound's responsibility to get right, not something Stripe guarantees on its side.",
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
        competitor: "Starter tier is a published flat $250/month (billed yearly) for teams under $5k/month in churn volume. Higher tiers (Core, Intelligence, Enterprise) require a custom quote, not published.",
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
    omittedNote: "Churnkey's Core, Intelligence, and Enterprise tier pricing is not published as a simple public rate, so it is stated as custom-quoted here rather than estimated.",
  },

  "churn-buster": {
    slug: "churn-buster",
    name: "Churn Buster",
    category: "Dedicated dunning and recovery tool",
    oneLiner: "One of the longest-running dedicated failed-payment recovery tools for Stripe and Recurly.",
    rows: [
      {
        ...FOXHOUND_PRICING_ROW,
        competitor: "Plans start from $149/month, scaled to MRR rather than a flat rate, and billed regardless of how much gets recovered. Churn Buster backs this with its own ROI guarantee: if the tool doesn't cover its cost, the merchant doesn't pay.",
      },
      {
        dimension: "What it does",
        foxhound: `AI-drafted dunning email sequences and silent retries across ${RECOVERY_SEQUENCE_DAYS} days, tuned to ${DECLINE_CATEGORY_COUNT_WORD_LOWER} decline categories.`,
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
        competitor: "The MRR-scaled subscription still applies in a low-recovery month, offset by Churn Buster's own ROI guarantee: if the tool doesn't cover its cost, the merchant doesn't pay.",
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
        competitor: "Included at no additional charge for merchants on Paddle Billing. Historically (as ProfitWell Retain) it was sold standalone on a percentage-of-recovered-revenue basis, but Paddle's current public materials position it as a Paddle Billing feature, not a separately purchasable product, so a standalone price isn't verifiable today.",
      },
      {
        dimension: "What it does",
        foxhound: "Runs directly against your own Stripe account: silent retries, dunning emails, card-update page, disputes, and intelligence in one product.",
        competitor: "Involuntary-churn recovery: failed-payment dunning, retry orchestration, and account-update emails, most naturally suited to merchants already on Paddle's billing platform.",
      },
      {
        dimension: "Merchant-of-record requirement",
        foxhound: "None. Foxhound connects to your existing Stripe account with read and write scope, used only to retry failed invoices, set a default payment method after a card update, open a Stripe checkout when a former customer chooses to resubscribe, submit dispute evidence you approved, and close a dispute you choose to accept; you remain the merchant of record.",
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
        competitor: "Sold as part of Baremetrics' tiered subscription analytics plans, not a standalone percentage-of-recovery fee. Baremetrics states a company at $300,000 MRR pays about $499/month for Recover, as a public benchmark.",
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
        competitor: "A fixed monthly fee scaled to the merchant's MRR, not a percentage of what gets recovered. Stunning's own pricing page illustrates an example rate around $120/month at a specific MRR tier.",
      },
      {
        dimension: "What it does",
        foxhound: `AI-drafted dunning emails and silent retries across ${RECOVERY_SEQUENCE_DAYS} days, then disputes and intelligence in the same product.`,
        competitor: "Automated dunning-email sequences for failed Stripe payments. Scoped narrowly to email-based recovery.",
      },
      {
        dimension: "Silent retries before email, where retryable",
        foxhound: "Yes, wherever the decline can be retried: a scheduled retry runs before any customer-facing email so a quietly recoverable payment is never dunned unnecessarily.",
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
