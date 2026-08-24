// Modest, hand-written docs content for /docs/:slug (Phase 6 Pass 1). Legacy
// carried five much larger guides (9-23KB each); TASK-foxhound-phase6.md
// scopes this pass to "real (not stub) rendering... keep it modest, this
// isn't the focus of Pass 1", so this is a deliberately smaller set of
// sections per guide, de-branded and corrected against the 10 copy rules
// (no auto-submit language, silent-first framing, baseline-free, singular
// brand voice, no fabricated recovery-rate numbers).

// THE BLOCK VOCABULARY, extended in session 64 to carry legacy's own.
//
// A PLAIN STRING IS STILL A PARAGRAPH, which is the whole point of the shape: the
// twelve sections that shipped in sessions 42 to 60 are arrays of strings and
// render through exactly the path they always did. Anything richer is a tagged
// object, so the two forms cannot be confused and no pre-existing sentence had to
// be rewritten to extend the schema.
//
// Legacy's inline set is Strong, Code, RelLink and a bare font-mono span; its
// block set is H3, Note, Tip, Steps, List and a reference table. There is no
// related-links BLOCK on either guide: legacy writes "See the Recovery guide for
// ..." as an ordinary paragraph with a RelLink inside it, which is why `link` is
// an inline here and not a block of its own.

export type DocInline =
  | string
  | { code: string }
  | { strong: string }
  | { mono: string }
  | { link: string; to: string };

/** A string, or a run of inline nodes. */
export type DocRich = string | DocInline[];

export type DocBlock =
  | string
  | { kind: "p"; body: DocInline[] }
  | { kind: "h3"; text: string }
  | { kind: "note"; body: DocRich }
  | { kind: "tip"; body: DocRich }
  | { kind: "steps"; items: DocRich[] }
  | { kind: "list"; items: DocRich[] }
  | { kind: "table"; columns: string[]; rows: DocRich[][] };

export interface DocGuide {
  slug: string;
  title: string;
  description: string;
  sections: { heading: string; body: DocBlock[] }[];
}

export const DOC_GUIDES: DocGuide[] = [
  {
    slug: "platform",
    title: "Platform",
    description: "Connecting Stripe, settings, team management, and billing.",
    sections: [
      {
        heading: "Getting started",
        body: [
          { kind: "h3", text: "How Foxhound works" },
          "Foxhound watches your connected Stripe account for failed payments. Stripe sends a webhook within seconds of a failure, Foxhound reads the decline code, sorts the failure into a category, and opens a recovery sequence for it without you doing anything.",
          "A sequence is a quiet retry first, then AI-written emails and further retries spread across thirty days, with the timing chosen by what went wrong. If the payment comes back at any point, the steps still ahead of it are cancelled. If the sequence runs out without the payment coming back, the payment is marked failed unrecovered and you are told.",
          { kind: "note", body: "Foxhound starts after Stripe's own Smart Retries have run and failed. It does not interfere with Stripe's recovery logic, and a payment Stripe brings back on its own is recorded and never billed." },
          { kind: "h3", text: "Connecting your Stripe account" },
          "Foxhound connects to your Stripe account through Stripe Connect with read and write OAuth scope, because retrying a failed invoice is a write. Foxhound reads invoices, subscriptions, disputes, and customer data. It writes in three places: retrying payment on an invoice that has already failed, setting a customer default payment method after that customer updates their card, and submitting dispute evidence once someone on your team has approved it. It never changes prices, products, or subscription plans, never creates a charge outside an invoice you already issued, and never reaches your payouts or bank account.",
          { kind: "steps", items: [
            [{ link: "Open /connect", to: "/connect" }, " and give the account a name."],
            [{ strong: "Connect with Stripe" }, " sends you to Stripe's authorization page."],
            "Choose the Stripe account you want watched and authorize the connection.",
            "You land back in Foxhound and monitoring starts immediately.",
          ] },
          { kind: "tip", body: "One Foxhound login can hold several accounts, each with its own Stripe connection, settings, dashboard and invoices. Add another from the account switcher in the header, and use the same switcher to move between them. Nothing on any page mixes two accounts together." },
          { kind: "h3", text: "Disconnecting Stripe" },
          "Disconnect at any time from your Stripe dashboard or from Settings inside Foxhound, one connected Stripe account at a time. Disconnecting stops recovery work on that Stripe account immediately, and any other Stripe account you have connected keeps running. It does not close your Foxhound account and it does not waive fees already earned on recoveries Foxhound attributed, which still invoice. To stop everything, cancel the account under Danger zone in Settings and My account.",
          { kind: "h3", text: "Initial setup" },
          "Two settings are worth putting in before your first failure, because both change what your customers read.",
          { kind: "h3", text: "Sender name" },
          "Settings and Email holds the sender name, the name your customers see in the From line of every recovery email. Set it before your first send: until you do, recovery mail goes out from \"Support\". Send test email delivers a sample to your own address through the real sending path, so the From line you see is the one your customers get.",
          { kind: "h3", text: "Brand voice" },
          "Settings and Brand voice sets the tone of every AI-written email. Set one voice for everything, or a different voice for each decline category underneath it.",
          { kind: "tip", body: "The industry, customer type and monthly revenue fields under Settings and My account are optional, and they go into the prompt for every recovery email when you fill them in. A message written for a B2B account reads differently from one written for a consumer store." },
          { kind: "h3", text: "What happens when your first payment fails" },
          "Nothing is required of you. The sequence runs on its own.",
          { kind: "steps", items: [
            [ "Stripe fires an ", { code: "invoice.payment_failed" }, " webhook at Foxhound within seconds." ],
            "Foxhound reads the decline code and sorts the failure into a category.",
            "Foxhound opens a recovery record and schedules its steps for that category.",
            "The payment appears on your dashboard under active sequences.",
            "A quiet retry runs first where the category allows one, so a payment that comes back that way never reaches your customer at all.",
            "If it does not, the first email goes out at its scheduled time, written for that customer and that decline.",
            "If the payment recovers at any point, every remaining step is cancelled and you are emailed.",
          ] },
          { kind: "p", body: [ "See ", { link: "the Recovery guide", to: "/docs/recovery" }, " for managing payments, reading a sequence, and what each dashboard number means." ] },
        ],
      },
      {
        heading: "Additional features",
        body: [
          { kind: "h3", text: "Expiring card alerts" },
          "Once a night Foxhound reads the active subscriptions on your connected account and finds the cards inside thirty days of expiring. Each of those customers is emailed once, from your sender name, with a link to update the card before anything fails.",
          "The alert goes out once per card and expiry month rather than repeatedly, and a card that has already expired is left alone, because by then the payment has failed and the recovery sequence has it.",
          { kind: "note", body: "The link in the alert is a Foxhound page, not Stripe's billing portal. The customer updates the card there and Foxhound sets it as the default payment method on the subscription. Nothing about the alert is billable: it prevents a failure rather than recovering one." },
          "Foxhound also picks up card changes made in Stripe directly, so a customer who fixes their card without the email stops being alerted.",
          { kind: "h3", text: "Win-back sequences" },
          "When a subscription is cancelled, Foxhound checks whether a failed payment caused it. If one did, the cancellation was involuntary, the recovery sequence already has it, and no win-back starts.",
          "If nothing failed, the customer chose to go. Three emails go out, the first an hour after the cancellation, then one at four days and a last one at fourteen, each written in your brand voice for the step it is and each linking to a page where that customer can restart the same plan through Stripe.",
          "A customer who comes back is matched to their sequence by the identifier Foxhound put on the checkout, never by guessing from the customer, and the reactivation is recorded against that sequence. Reactivations are not billed.",
          { kind: "h3", text: "Weekly digest" },
          "The weekly digest is a Monday morning summary of the previous seven days: revenue recovered, recovery rate, payments failed and recovered, revenue still at risk, active sequences, emails sent, and win-back sequences running. It is off until you enable it on the notifications page, it goes to the same notification email, and it arrives once a week even in a quiet week, so a week with nothing in it still tells you that.",
          { kind: "h3", text: "Slack notifications" },
          "Foxhound posts to Slack when a recovery email goes out and when a retry brings a payment back. Paste an incoming webhook URL on the notifications page to turn it on.",
          { kind: "steps", items: [
            "Create an app for your workspace at api.slack.com/apps.",
            [ "Turn on ", { strong: "Incoming Webhooks" }, " and add one to the channel you want." ],
            "Copy the webhook URL.",
            "Paste it into the Slack webhook field under Settings and Notifications, and save.",
          ] },
          { kind: "note", body: "Foxhound only accepts a URL on Slack's own webhook host, so a pasted address that points somewhere else is refused rather than quietly fetched. A delivery that fails is reported back to you rather than swallowed." },
          { kind: "h3", text: "Free lost-revenue audit" },
          { kind: "p", body: [ "The audit at ", { link: "/audit", to: "/audit" }, " needs no Foxhound account. It connects to Stripe read-only, reads the trailing period, and shows what Stripe already recovered, what is still unrecovered, and where Foxhound would add on top. It writes nothing back to Stripe." ] },
        ],
      },
      {
        heading: "Settings reference",
        body: [
          "Settings is a hub: Stripe connections, Email, Brand voice, Features, Audit, Notifications, Alerts, Team, API keys, and My account, each on its own page with a sub-nav down the side. Disputes and Intelligence settings are not built yet, so the hub does not list them.",
          { kind: "h3", text: "Email" },
          { kind: "table", columns: ["Setting", "What it does"], rows: [
            ["Sender name", "The name your customers see in the From line of every recovery email. Recovery mail goes out from \"Support\" until you set it."],
            ["Send test email", "Delivers a real recovery email to your own address through the sending path your customers get, so you can read the From line and the copy before a real failure."],
          ] },
          { kind: "note", body: "The sending domain is Foxhound's verified address on every account and is not a setting. A reply-to address is not read by the send path yet, so the field is not offered rather than shown and ignored." },
          { kind: "h3", text: "Brand voice" },
          "The voice for a given email is the one set for that decline category, or the main voice when the category has none, or Foxhound's own default when neither is set. The most specific voice available wins.",
          { kind: "tip", body: "A fraud-flagged decline often reads better in a softer voice than the one you would use for an expired card. That is what the per-category fields are for." },
          { kind: "h3", text: "Merchant context" },
          "The industry, customer type and monthly revenue you enter under Settings and My account go to the AI with every recovery email, so a message written for a B2B SaaS account does not read like one written for a consumer store. Leave them blank and the copy simply omits that context.",
          { kind: "table", columns: ["Field", "What it does"], rows: [
            ["Industry", "What the business sells, so the email is written for that kind of buyer."],
            ["Primary customer type", "Who is being written to, which changes the register a great deal between businesses and consumers."],
            ["Monthly recurring revenue", "Roughly how big the business is, which changes how a payment of a given size reads."],
          ] },
          { kind: "h3", text: "Notifications" },
          "When Foxhound recovers a payment, it emails the notification email set in Settings and Notifications, with the amount, the customer, and the decline that started it. It sends once per recovery: a repeated webhook from Stripe does not produce a second email.",
          "When a sequence runs out of steps without the payment coming back, Foxhound emails the same address to say so, with the customer and the amount, so you can decide whether to chase it or write it off. A payment that recovers gets the recovery email instead: you never get both for one payment.",
          "Set no notification email and Foxhound sends nothing, which is also how you turn either one off. Slack delivery posts to an incoming webhook you paste on the notifications page, when a recovery email goes out and when a retry recovers a payment.",
          { kind: "list", items: [
            [{ strong: "Recovery." }, " Emailed when a payment in a sequence comes back."],
            [{ strong: "Sequence complete." }, " Emailed when every step has run and the payment has not come back."],
            [{ strong: "Slack." }, " Posts to your channel on a recovery email and on a successful retry."],
            [{ strong: "Weekly digest." }, " Monday morning summary of the previous seven days."],
          ] },
          { kind: "note", body: "Win-back and expiring-card alerts are switches on the features page rather than the notifications page, because they turn the engine off rather than changing who hears about it." },
          { kind: "h3", text: "Alerts" },
          "Settings and Alerts lets you set a threshold on a metric Foxhound tracks: average health score, MRR at risk, churned MRR, and contracted MRR. Choose whether the metric dropping below or rising above your number counts, and Foxhound checks every night.",
          "Every breach is recorded and shown under Recent triggers on that page. Foxhound does not email or Slack you when an alert fires yet, so the page is where you read them.",
          { kind: "h3", text: "API keys" },
          "Settings and API keys issues credentials for external AI agents and automations. A key is shown once, when you generate it, and only its hash is stored, so Foxhound cannot show it to you again. Name each key so you can tell them apart, and revoke any key from the same page. A revoked key stops working immediately.",
          { kind: "h3", text: "Team" },
          "Invite teammates from Settings and Team. The account owner can remove any member other than themselves, and access ends immediately. Settings and Brand voice holds the main brand voice and, below it, a different tone for each failure category: soft declines, expired cards, network declines, and fraud or hard declines. A category you leave on \"Same as main voice\" falls back to the main one.",
          { kind: "h3", text: "Inviting a team member" },
          { kind: "steps", items: [
            [ "Enter their email address under Settings and Team and send the invite." ],
            "They get a link that stays valid for seven days.",
            "Someone who already has a Foxhound account joins on clicking it. Someone who does not signs up first and joins on the way through.",
          ] },
          { kind: "note", body: "An invite belongs to the address it was sent to. Opening it while signed in as somebody else refuses rather than joining the wrong person, and an invite to an account you are already on takes you there instead of failing." },
          { kind: "h3", text: "Removing a team member" },
          "Remove any member other than the owner from Settings and Team. Access ends immediately, and the owner cannot be removed at all.",
          { kind: "h3", text: "Billing" },
          "Each monthly run bills the prior month's matured recoveries, meaning recoveries held for 30 or more days, at 20%. Recoveries Stripe would have gotten on its own are never billed. Disputes are billed at 20% of wins only, capped at $500 per dispute. Intelligence's predictive layer is a flat $199 per month.",
          "A payment method goes on file once, in Settings. Invoices and the full evidence ledger are visible under Billing at any time.",
          { kind: "h3", text: "Cancelling" },
          "Cancel account under Danger zone in Settings and My account stops the work. Every Stripe connection on the account is disconnected, no further sequence runs, and the recoveries Foxhound already attributed still invoice. Your billing history and the evidence behind it are left intact.",
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
          "Expiring card alerts are on unless you turn them off on the features page.",
        ],
      },
      {
        heading: "When a customer cancels",
        body: [
          "When a subscription is cancelled voluntarily, Foxhound starts a win-back sequence: three emails, the first an hour after the cancellation, then one at four days and a last one at fourteen. Each is written in your brand voice for the step it is, warmer at the first and lighter at the last, and each links to a page where that customer can restart the same plan through Stripe.",
          "It does not start for a subscription that ended because payments were failing, because that is a recovery and the recovery sequence already has it, and it does not start for a customer you chased in the last seven days. The sequence stops as soon as they come back.",
          "A reactivation is not billed. Win-back brings back a customer who chose to leave, which is not the recovery of a failed payment, so there is no recovered payment and no fee.",
          "Win-back sequences are on unless you turn them off on the features page.",
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
