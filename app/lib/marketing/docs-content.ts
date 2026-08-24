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
          "Foxhound checks your active subscriptions nightly and, when a card is inside 30 days of expiring, emails that customer once to ask them to update it. The email comes from your sender name and links to the same hosted card-update page a dunning email uses.",
          "It sends once per card and expiry month, never repeatedly, and a card that has already expired is not warned about, because at that point the payment has failed and the recovery sequence has it.",
          { kind: "note", body: "The link in the alert is a Foxhound page, not Stripe's billing portal. The customer updates the card there and Foxhound sets it as the default payment method on the subscription. Foxhound also picks up a card changed in Stripe directly, so a customer who fixes it without the email stops being alerted." },
          "Nothing about this alert is billable. It prevents a failure rather than recovering one, so there is no recovered payment and no fee.",
          "Expiring card alerts are on unless you turn them off on the features page.",
          { kind: "h3", text: "Win-back sequences" },
          "When a subscription is cancelled voluntarily, Foxhound starts a win-back sequence: three emails, the first an hour after the cancellation, then one at four days and a last one at fourteen. Each is written in your brand voice for the step it is, warmer at the first and lighter at the last, and each links to a page where that customer can restart the same plan through Stripe.",
          "It does not start for a subscription that ended because payments were failing, because that is a recovery and the recovery sequence already has it, and it does not start for a customer you chased in the last seven days. The sequence stops as soon as they come back.",
          { kind: "note", body: "A customer who comes back is matched to their sequence by the identifier Foxhound put on the checkout, never by guessing from the customer. Legacy matched on the customer alone and credited an ordinary renewal as a win-back." },
          "A reactivation is not billed. Win-back brings back a customer who chose to leave, which is not the recovery of a failed payment, so there is no recovered payment and no fee.",
          "Win-back sequences are on unless you turn them off on the features page.",
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
    description: "Managing failed payments, reading sequences, and what each dashboard number means.",
    sections: [
      {
        heading: "Managing payments",
        body: [
          { kind: "h3", text: "Reading the payments list" },
          { kind: "p", body: [ "The list at ", { link: "/recovery/payments", to: "/recovery/payments" }, " holds every failed payment Foxhound has detected, newest first. A row carries the customer name and email, the amount, the decline category, the current status, and when the failure was detected. Open any row for that payment's own page." ] },
          { kind: "h3", text: "Filtering and search" },
          { kind: "list", items: [
            [{ strong: "Search." }, " Matches on customer name, email, or plan name."],
            [{ strong: "Status." }, " Active, recovered, cancelled, or failed unrecovered."],
            [{ strong: "Decline category." }, " Narrows to one category."],
            [{ strong: "Date range." }, " Filters on when the failure was detected."],
            [{ strong: "Amount range." }, " A slider bounded by the smallest and largest amounts you actually have."],
            [{ strong: "Sort." }, " Newest first, oldest first, or by amount."],
          ] },
          "Every filter is a URL parameter, so a filtered view can be bookmarked or sent to somebody else and it opens the same way for them.",
          { kind: "h3", text: "Rows per page" },
          "The selector above the table shows 10, 25, 50, 100, or all of them. It starts at 50.",
          { kind: "h3", text: "What each status means" },
          { kind: "list", items: [
            [{ strong: "Active." }, " The sequence is running and at least one step is still ahead of it."],
            [{ strong: "Recovered." }, " The invoice was paid, and every remaining step was cancelled."],
            [{ strong: "Cancelled." }, " You stopped the sequence, or the subscription behind it ended."],
            [{ strong: "Failed unrecovered." }, " Every step ran and the payment did not come back. Nothing further happens on its own."],
          ] },
          { kind: "h3", text: "Reading a payment page" },
          "A payment's own page carries its whole timeline, from detection to the most recent step. Each step shows what kind it is, when it was scheduled, when it ran, and what came back: an email step shows the subject and the body that was sent, and a retry step shows what Stripe answered.",
          "Opens and clicks are recorded per email step, so you can see whether a message was read and whether the card-update link was followed. The click is the one that matters for billing.",
          { kind: "h3", text: "Acting on a payment by hand" },
          { kind: "list", items: [
            [{ strong: "Trigger now." }, " Runs the next pending step immediately instead of waiting for its scheduled time."],
            [{ strong: "Mark recovered." }, " Closes the payment and cancels the rest of the sequence. Use it when the customer paid some other way, which Foxhound has no way to see."],
            [{ strong: "Cancel sequence." }, " Stops every future step for that payment."],
            [{ strong: "Resend." }, " Sends a completed email step again and records it as its own step."],
            [{ strong: "Note." }, " A field for your own reference. It is never sent to the customer."],
          ] },
          { kind: "note", body: "Foxhound has no rewrite-the-pending-email control. Legacy let you replace a queued email with your own text; Foxhound writes each email at send time from the customer, the decline and your brand voice, so there is no draft sitting there to edit." },
          { kind: "h3", text: "Bulk actions" },
          "Select rows with the checkboxes and a bar appears at the bottom of the screen. Trigger, mark recovered, or cancel every selected payment at once. There is a ceiling on how many one submission can carry, and the bar tells you what it is.",
          { kind: "h3", text: "Exporting to CSV" },
          "Export CSV in the list header downloads the payments matching whatever filters you have on, so the export is the view you are looking at rather than the whole table.",
        ],
      },
      {
        heading: "Recovery sequences",
        body: [
          { kind: "h3", text: "Silent retries first" },
          "When a retryable payment fails, Foxhound attempts a quiet retry before any customer ever sees an email. If the quiet retry works, the customer is never bothered.",
          "Only after the silent retry window closes does the first dunning email go out, and it carries a hosted card-update link.",
          { kind: "h3", text: "How sequences are built by decline type" },
          "Declines are sorted into six categories: soft, network, expired, fraud, revoked, and unknown. Each gets its own schedule, spread across thirty days, chosen by what is actually wrong with the payment.",
          { kind: "table", columns: ["Category", "What it means", "How it is worked"], rows: [
            ["Soft", "A temporary decline, often insufficient funds", "Silent retries and emails together, the longest sequence of the six"],
            ["Network", "A processor or bank problem, usually passing", "An early silent retry catches most of these before any email is needed"],
            ["Expired", "The card is past its expiry date", "Emails only. A retry on an expired card fails every time until the customer updates it"],
            ["Fraud", "The issuer blocked the charge", "Emails only. Retrying a blocked card can draw further flags"],
            ["Revoked", "The customer withdrew the mandate", "A single email. There is nothing to retry against"],
            ["Unknown", "A decline code the engine does not recognise", "Emails only, failing closed: no silent retry against a code that has not been classified"],
          ] },
          { kind: "note", body: "Legacy classified four categories. Foxhound classifies six, and the two extra ones are both cases where a retry would be wrong: a revoked mandate and a decline code nothing has mapped." },
          { kind: "h3", text: "Reading the sequences page" },
          { kind: "p", body: [ "The page at ", { link: "/recovery/sequences", to: "/recovery/sequences" }, " reads across your whole recovery history by category. For each step it shows how many went out, the open rate, the click rate and the most recent subject line used. A retry step shows how often the retry worked instead." ] },
          { kind: "h3", text: "How recovery emails are written" },
          "Every email is written at send time. The AI is given the customer's first name, the plan, the amount, how long they have been a customer, the decline category, where the message sits in the sequence, your brand voice, and your merchant context when you have set it.",
          "What comes back is checked before it goes anywhere: an email carrying hollow phrasing, hedging, or anything that reads like a billing system wrote it is rejected and the template goes instead. Delivery is never held up by the AI layer.",
          { kind: "tip", body: "Send test email under Settings and Email delivers a real one to your own address through the same sending path, so you can read what a customer would get before anything fails." },
        ],
      },
      {
        heading: "Understanding your dashboard",
        body: [
          { kind: "h3", text: "Stat cards" },
          "Nine cards sit across the top of the recovery dashboard. The range buttons in the header move them together.",
          { kind: "table", columns: ["Card", "What it shows"], rows: [
            ["Recovered", "What came back in the selected range."],
            ["Currently at risk", "The total across every payment still in an active sequence."],
            ["Recovery rate", "The share of closed payments that came back."],
            ["Active sequences", "How many payments are being worked right now."],
            ["Win-backs active", "How many cancelled customers are in a win-back sequence."],
            ["Cards expiring", "Cards inside the alert window."],
            ["Avg. days to recover", "How long a recovery takes, on average."],
            ["Best decline category", "Which category is recovering best for you."],
            ["Emails sent", "Recovery emails sent in the selected range."],
          ] },
          { kind: "h3", text: "Date range" },
          "The range buttons in the header change the window every card and chart reads from.",
          { kind: "h3", text: "Webhook health" },
          "The dashboard shows whether Stripe is still reaching Foxhound. A webhook inside the last day reads as receiving normally, nothing for a day reads as quiet, and nothing for more than three days is flagged as a problem worth checking. A brand new connection that has not seen one yet says so rather than reading as a failure.",
          { kind: "h3", text: "What counts as billable" },
          "A recovery is billable only when a Foxhound action provably preceded payment: a scheduled retry succeeded, a dunning email was clicked or otherwise engaged (not just opened), or a card was updated through a Foxhound page. Everything else is Stripe's own baseline recovery, recorded and shown to you, never billed.",
        ],
      },
      {
        heading: "Troubleshooting",
        body: [
          { kind: "h3", text: "A payment is not showing up" },
          { kind: "list", items: [
            [{ strong: "Is the Stripe account still connected?" }, " Settings and Stripe connections lists every live connection on this account."],
            [{ strong: "Has Stripe finished its own retries?" }, " Foxhound only gets the webhook once Stripe has given up. While Stripe is still trying, the payment will not appear."],
            [{ strong: "Is the payment on the account you are looking at?" }, " If you hold more than one, check the account switcher in the header."],
            [{ strong: "Is Stripe still reaching Foxhound?" }, " The webhook health line on the dashboard says so."],
          ] },
          { kind: "h3", text: "An email is not going out" },
          { kind: "list", items: [
            [{ strong: "Is the address suppressed?" }, " A customer who unsubscribed, hard bounced, or reported an email as spam is suppressed, and Foxhound will not send to them again."],
            [{ strong: "Is the step actually due?" }, " The timeline on the payment page shows when each step is scheduled."],
          ] },
          { kind: "note", body: "Suppression is per address and it holds. It exists so a customer who asked to stop hearing from you is not mailed again by a later sequence." },
          { kind: "h3", text: "The recovery rate looks low" },
          { kind: "list", items: [
            [{ strong: "How many closed payments are behind it?" }, " A rate over a handful of payments moves on every one of them. Give it a billing cycle."],
            [{ strong: "What is the decline mix?" }, " Fraud and revoked recover less by nature. The decline breakdown on the dashboard shows yours."],
            [{ strong: "Are the emails being opened?" }, " Low open rates on the sequences page point at deliverability rather than at the copy."],
            [{ strong: "Is the brand voice set?" }, " Copy written without one is more generic than copy written with one."],
          ] },
          { kind: "h3", text: "A customer says the email never arrived" },
          { kind: "list", items: [
            "Check the timeline on the payment page and confirm the step ran rather than sitting pending.",
            "Check whether the address is suppressed.",
            "Ask them to look in spam.",
            "Use Resend on the completed step to send it again.",
          ] },
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
