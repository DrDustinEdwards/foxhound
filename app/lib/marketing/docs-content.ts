// Modest, hand-written docs content for /docs/:slug (Phase 6 Pass 1). Legacy
// carried five much larger guides (9-23KB each); TASK-foxhound-phase6.md
// scopes this pass to "real (not stub) rendering... keep it modest, this
// isn't the focus of Pass 1", so this is a deliberately smaller set of
// sections per guide, de-branded and corrected against the 10 copy rules
// (no auto-submit language, silent-first framing, baseline-free, singular
// brand voice, no fabricated recovery-rate numbers).

export interface DocGuide {
  slug: string;
  title: string;
  description: string;
  sections: { heading: string; body: string[] }[];
}

export const DOC_GUIDES: DocGuide[] = [
  {
    slug: "platform",
    title: "Platform",
    description: "Connecting Stripe, settings, team management, and billing.",
    sections: [
      {
        heading: "Connecting Stripe",
        body: [
          "Foxhound connects to your Stripe account through Stripe Connect with read and write OAuth scope, because retrying a failed invoice is a write. Foxhound reads invoices, subscriptions, disputes, and customer data. It writes in three places: retrying payment on an invoice that has already failed, setting a customer default payment method after that customer updates their card, and submitting dispute evidence once someone on your team has approved it. It never changes prices, products, or subscription plans, never creates a charge outside an invoice you already issued, and never reaches your payouts or bank account.",
          "Disconnect at any time from your Stripe dashboard or from Settings inside Foxhound, one connected Stripe account at a time. Disconnecting stops recovery work on that Stripe account immediately, and any other Stripe account you have connected keeps running. It does not close your Foxhound account and it does not waive fees already earned on recoveries Foxhound attributed, which still invoice. To stop everything, cancel the account under Danger zone in Settings.",
        ],
      },
      {
        heading: "Billing",
        body: [
          "Each monthly run bills the prior month's matured recoveries, meaning recoveries held for 30 or more days, at 20%. Recoveries Stripe would have gotten on its own are never billed. Disputes are billed at 20% of wins only, capped at $500 per dispute. Intelligence's predictive layer is a flat $199 per month.",
          "A payment method goes on file once, in Settings. Invoices and the full evidence ledger are visible under Billing at any time.",
        ],
      },
      {
        heading: "Notifications",
        body: [
          "When Foxhound recovers a payment, it emails the notification email set in Settings, with the amount, the customer, and the decline that started it. It sends once per recovery: a repeated webhook from Stripe does not produce a second email.",
          "When a sequence runs out of steps without the payment coming back, Foxhound emails the same address to say so, with the customer and the amount, so you can decide whether to chase it or write it off. A payment that recovers gets the recovery email instead: you never get both for one payment.",
          "Set no notification email and Foxhound sends nothing, which is also how you turn either one off. Slack delivery is not built yet.",
          "The weekly digest is a Monday morning summary of the previous seven days: revenue recovered, recovery rate, payments failed and recovered, revenue still at risk, active sequences, emails sent, and win-back sequences running. It is off until you turn it on in Settings, it goes to the same notification email, and it arrives once a week even in a quiet week, so a week with nothing in it still tells you that.",
        ],
      },
      {
        heading: "Alerts",
        body: [
          "Settings and Alerts lets you set a threshold on a metric Foxhound tracks: average health score, MRR at risk, churned MRR, and contracted MRR. Choose whether the metric dropping below or rising above your number counts, and Foxhound checks every night.",
          "Every breach is recorded and shown under Recent triggers on that page. Foxhound does not email or Slack you when an alert fires yet, so the page is where you read them.",
        ],
      },
      {
        heading: "API keys",
        body: [
          "Settings and API keys issues credentials for external AI agents and automations. A key is shown once, when you generate it, and only its hash is stored, so Foxhound cannot show it to you again. Name each key so you can tell them apart, and revoke any key from the same page. A revoked key stops working immediately.",
        ],
      },
      {
        heading: "Team and brand voice",
        body: [
          "Invite teammates from Settings and Team. The account owner can remove any member other than themselves, and access ends immediately. Every account has a main brand voice, and Settings and Brand voice can set a different tone for each failure category: soft declines, expired cards, network declines, and fraud or hard declines. A category you leave on \"Same as main voice\" falls back to the main one.",
          "The industry, customer type and monthly revenue you enter under Settings go to the AI with every recovery email, so a message written for a B2B SaaS account does not read like one written for a consumer store. Leave them blank and the copy simply omits that context.",
          "Settings and Email holds the sender name, the name your customers see in the From line of every recovery email. Set it before your first send: until you do, recovery mail goes out from \"Support\". Send test email delivers a sample to your own address through the real sending path, so the From line you see is the one your customers get.",
        ],
      },
    ],
  },
  {
    slug: "audit",
    title: "Audit",
    description:
      "Free Stripe diagnostic. What Stripe already recovered, what is still dying, and what Foxhound would add.",
    sections: [
      {
        heading: "What it checks",
        body: [
          "The audit only reads. It looks at failed invoices, expiring cards, open disputes, and basic account health over the trailing period, and writes nothing back to Stripe.",
          "Results are framed around lift: what Stripe's own retries already recovered, what is currently unrecovered, and where Foxhound's silent retries and review-and-sign disputes would add on top.",
        ],
      },
      {
        heading: "No fabricated numbers",
        body: [
          "The audit does not project a recovery rate from platform-wide statistics, there is no long-running platform history to draw one from yet. It reports what your account actually shows, plainly.",
        ],
      },
    ],
  },
  {
    slug: "recovery",
    title: "Recovery",
    description: "Silent retries first, then AI-drafted email sequences, across 30 days.",
    sections: [
      {
        heading: "Silent first",
        body: [
          "When a retryable payment fails, Foxhound attempts a quiet retry before any customer ever sees an email. If the quiet retry works, the customer is never bothered.",
          "Only after the silent retry window closes does the first dunning email go out, and it carries a hosted card-update link.",
        ],
      },
      {
        heading: "Four decline categories",
        body: [
          "Declines are classified as soft, network, expired, or fraud. Fraud declines are never retried. The other three categories get a sequence tuned to what is actually wrong with the payment, spread across 30 days.",
        ],
      },
      {
        heading: "Before a card expires",
        body: [
          "Foxhound checks your active subscriptions nightly and, when a card is inside 30 days of expiring, emails that customer once to ask them to update it. The email comes from your sender name and links to the same hosted card-update page a dunning email uses.",
          "It sends once per card and expiry month, never repeatedly, and a card that has already expired is not warned about, because at that point the payment has failed and the recovery sequence has it.",
          "Nothing about this alert is billable. It prevents a failure rather than recovering one, so there is no recovered payment and no fee.",
        ],
      },
      {
        heading: "When a customer cancels",
        body: [
          "When a subscription is cancelled voluntarily, Foxhound starts a win-back sequence: three emails, the first an hour after the cancellation, then one at four days and a last one at fourteen. Each links to a page where that customer can restart the same plan through Stripe.",
          "It does not start for a subscription that ended because payments were failing, because that is a recovery and the recovery sequence already has it, and it does not start for a customer you chased in the last seven days. The sequence stops as soon as they come back.",
          "A reactivation is not billed. Win-back brings back a customer who chose to leave, which is not the recovery of a failed payment, so there is no recovered payment and no fee.",
        ],
      },
      {
        heading: "What counts as billable",
        body: [
          "A recovery is billable only when a Foxhound action provably preceded payment: a scheduled retry succeeded, a dunning email was clicked or otherwise engaged (not just opened), or a card was updated through a Foxhound page. Everything else is Stripe's own baseline recovery, recorded and shown to you, never billed.",
        ],
      },
    ],
  },
  {
    slug: "disputes",
    title: "Disputes",
    description: "Evidence drafted for you. You review and sign every submission.",
    sections: [
      {
        heading: "Draft, then a human approves",
        body: [
          "When a dispute opens, Foxhound drafts evidence from your recovery history, prior charges, and Stripe signals. Every draft moves through review before it can be approved, and every submission requires your explicit sign-off.",
          "There is no auto-submit toggle. There never has been. Nothing reaches Stripe without a person on your team approving it first.",
        ],
      },
      {
        heading: "Pricing",
        body: [
          "20% of disputes Foxhound wins, capped at $500 per dispute. Nothing on disputes you lose or accept.",
        ],
      },
    ],
  },
  {
    slug: "intelligence",
    title: "Intelligence",
    description: "Free MRR analytics for every Recovery merchant. Predictive risk scoring is the paid layer.",
    sections: [
      {
        heading: "What is free",
        body: [
          "Every Recovery merchant gets MRR, movements, churn, and cohort analytics at no charge. This is not a trial, it stays free for as long as you use Recovery.",
        ],
      },
      {
        heading: "What is paid",
        body: [
          "The $199 per month layer adds predictive risk scoring on top of the free analytics, surfacing which customers are trending toward churn before it happens.",
        ],
      },
    ],
  },
];

export function getDocGuide(slug: string): DocGuide | undefined {
  return DOC_GUIDES.find((g) => g.slug === slug);
}
