import { STRIPE_WRITES, STRIPE_WRITES_LIMITS } from "~/lib/marketing/trust-copy";
import { formatMoneyShort } from "@dustinedwards/site-runtime/money";
import { DISPUTE_FEE_PERCENT, RECOVERY_FEE_PERCENT } from "~/lib/billing/page";
import {
  AUDIT_LOOKBACK_DAYS,
  DISPUTE_FEE_CAP_CENTS,
  EXPIRING_CARD_DAYS_AHEAD,
  EXPIRING_CARD_TOGGLE_LABEL,
  RECOVERY_MATURITY_DAYS,
} from "~/lib/constants";
import { AUDIT_ACCESS_ASK, AUDIT_ACCESS_PROMISE } from "~/lib/marketing/audit-access";
import { INTELLIGENCE_WINBACK_SENTENCE } from "~/lib/marketing/winback-copy";
import type { DocGuide } from "~/lib/marketing/docs-content";

/** Stripe's own switch, in its Dashboard under Email notifications and customer management. */
const STRIPE_EXPIRING_CARD_SETTING = "Send emails about expiring cards";

export const PLATFORM_GUIDE: Omit<DocGuide, "datePublished"> = {
  slug: "platform",
  title: "Platform",
  description: "Connecting Stripe, settings, team management, and billing.",
  heading: "Platform setup",
  sections: [
    {
      heading: "Getting started",
      body: [
        { kind: "h3", text: "How Foxhound works" },
        "Foxhound watches your connected Stripe account for failed payments. Stripe sends a webhook within seconds of a failure, Foxhound reads the decline code, sorts the failure into a category, and opens a recovery sequence for it without you doing anything.",
        "A sequence is a quiet retry first wherever the decline can be retried, then AI-written emails and any further retries spread across up to thirty days, with the timing chosen by what went wrong. If the payment comes back at any point, the steps still ahead of it are canceled. If the sequence runs out without the payment coming back, the payment is marked failed unrecovered and you are told.",
        "Foxhound works every failed payment on its own, and you can step in on any payment from its page.",
        {
          kind: "note",
          body: "Foxhound starts after Stripe's own Smart Retries have run and failed. It does not interfere with Stripe's recovery logic, and a payment Stripe brings back on its own is recorded and never billed.",
        },
        { kind: "h3", text: "Connecting your Stripe account" },
        `Foxhound connects to your Stripe account through Stripe Connect with read and write OAuth scope, because retrying a failed invoice is a write. Foxhound reads invoices, subscriptions, disputes, and customer data. It writes for these things and no others: ${STRIPE_WRITES}. It ${STRIPE_WRITES_LIMITS}.`,
        {
          kind: "steps",
          items: [
            [{ link: "Open /connect", to: "/connect" }, " and give the account a name."],
            [{ strong: "Connect with Stripe" }, " sends you to Stripe's authorization page."],
            "Choose the Stripe account you want watched and authorize the connection.",
            "You land back in Foxhound and monitoring starts immediately.",
          ],
        },
        {
          kind: "tip",
          body: "One Foxhound login can hold several accounts, each with its own Stripe connection, settings, dashboard and invoices. Add another from the account switcher in the header, and use the same switcher to move between them. Nothing on any page mixes two accounts together.",
        },
        { kind: "h3", text: "Disconnecting Stripe" },
        "Disconnect at any time from your Stripe dashboard or from Settings inside Foxhound, under Stripe connections, one connected Stripe account at a time. Disconnecting stops recovery work on that Stripe account immediately, and any other Stripe account you have connected keeps running. It does not close your Foxhound account and it does not waive fees already earned on recoveries Foxhound attributed, which still invoice. To stop everything, cancel the account under Danger zone in Settings and My account.",
        { kind: "h3", text: "Initial setup" },
        "Three settings are worth putting in before your first failure, because all three change what your customers read.",
        { kind: "h3", text: "Sender name" },
        'Settings and Email holds the sender name, the name your customers see in the From line of every recovery email. Set it before your first send: until you do, recovery mail goes out from "Support". Send test email delivers a sample to your own address through the real sending path, so the From line you see is the one your customers get.',
        { kind: "h3", text: "Reply-to email" },
        "Also in Settings and Email. Set the address your customers reach when they reply to a recovery email. Use an inbox somebody reads, because a customer who replies is often trying to fix their payment. Until you set one, replies go to the address in the From line.",
        { kind: "h3", text: "Brand voice" },
        'Settings and Brand voice sets a different tone for each failure category. A category left on "Same as main voice" falls back to the main one.',
        {
          kind: "tip",
          body: "The industry, customer type and monthly revenue fields under Settings and My account are optional, and they go into the prompt for every recovery email when you fill them in. A message written for a B2B account reads differently from one written for a consumer store.",
        },
        { kind: "h3", text: "What happens when your first payment fails" },
        "Nothing is required of you. The sequence runs on its own.",
        {
          kind: "steps",
          items: [
            [
              "Stripe fires an ",
              { code: "invoice.payment_failed" },
              " webhook at Foxhound within seconds.",
            ],
            "Foxhound reads the decline code and sorts the failure into a category.",
            "Foxhound opens a recovery record and schedules its steps for that category.",
            "The payment appears on your dashboard under active sequences.",
            "A quiet retry runs first where the category allows one, so a payment that comes back that way never reaches your customer at all.",
            "If it does not, the first email goes out at its scheduled time, written for that customer and that decline.",
            "If the payment recovers at any point, every remaining step is canceled and you are emailed.",
          ],
        },
        {
          kind: "p",
          body: [
            "See ",
            { link: "the Recovery guide", to: "/docs/recovery" },
            " for managing payments, reading a sequence, and what each dashboard number means.",
          ],
        },
      ],
    },
    {
      heading: "Additional features",
      body: [
        { kind: "h3", text: "Expiring card alerts" },
        `Foxhound checks your active subscriptions nightly and, when a card is inside ${EXPIRING_CARD_DAYS_AHEAD} days of expiring, emails that customer once to ask them to update it. The email comes from your sender name and links to the same hosted card-update page a dunning email uses.`,
        "It sends once per card and expiry month, never repeatedly, and a card that has already expired is not warned about, because at that point the payment has failed and the recovery sequence has it.",
        {
          kind: "note",
          body: "The link in the alert is a Foxhound page, not Stripe's billing portal. The customer updates the card there and Foxhound sets it as the default payment method on the subscription. Foxhound also picks up a card changed in Stripe directly, so a customer who fixes it without the email stops being alerted.",
        },
        "Nothing about this alert is billable. It prevents a failure rather than recovering one, so there is no recovered payment and no fee.",
        `Stripe can send its own expiring-card email too, so a customer may get both. To turn off Foxhound's, switch off "${EXPIRING_CARD_TOGGLE_LABEL}" in Settings and Email. To turn off Stripe's, switch off "${STRIPE_EXPIRING_CARD_SETTING}" in your Stripe Dashboard. Foxhound's is on unless you turn it off.`,
        { kind: "h3", text: "Win-back sequences" },
        `When a subscription is canceled voluntarily, Foxhound starts a win-back sequence: three emails, the first an hour after the cancellation, then one at four days and a last one at fourteen. ${INTELLIGENCE_WINBACK_SENTENCE} Each is written in your brand voice for the step it is, warmer at the first and lighter at the last, and each links to a page where that customer can restart the same plan through Stripe.`,
        "It does not start for a subscription that ended because payments were failing, because that is a recovery and the recovery sequence already has it, and it does not start for a customer you chased in the last seven days. The sequence stops as soon as they come back.",
        {
          kind: "note",
          body: "A customer who comes back is matched to their sequence by the identifier Foxhound put on the checkout, never by guessing from the customer. Matching on the customer alone would credit an ordinary renewal as a win-back.",
        },
        "A reactivation is not billed. Win-back brings back a customer who chose to leave, which is not the recovery of a failed payment, so there is no recovered payment and no fee.",
        "Win-back sequences are on unless you turn them off in Settings and Email.",
        { kind: "h3", text: "Weekly digest" },
        "The weekly digest is a Monday morning summary of the previous seven days: revenue recovered, recovery rate, payments failed and recovered, revenue still at risk, active sequences, emails sent, and win-back sequences running. It is off until you enable it on the notifications page, it goes to the same notification email, and it arrives once a week even in a quiet week, so a week with nothing in it still tells you that.",
        { kind: "h3", text: "Slack notifications" },
        "Foxhound posts to Slack when a recovery email goes out and when a retry brings a payment back. Slack delivery posts to an incoming webhook you paste on the notifications page.",
        {
          kind: "steps",
          items: [
            "Create an app for your workspace at api.slack.com/apps.",
            ["Turn on ", { strong: "Incoming Webhooks" }, " and add one to the channel you want."],
            "Copy the webhook URL.",
            "Paste it into the Slack webhook URL field under Settings and Notifications, switch on Slack notifications, and save.",
          ],
        },
        {
          kind: "note",
          body: "Foxhound only accepts a URL on Slack's own webhook host, so a pasted address that points somewhere else is refused rather than quietly fetched. A delivery that fails is reported back to you rather than swallowed.",
        },
        { kind: "h3", text: "Free lost-revenue audit" },
        {
          kind: "p",
          body: [
            "The audit at ",
            { link: "/audit", to: "/audit" },
            ` needs no Foxhound account. It connects to Stripe, reads the last ${AUDIT_LOOKBACK_DAYS} days, and shows what is failing, what is about to, and where your disputes and recurring revenue stand. It writes nothing back to Stripe.`,
          ],
        },
        `The audit's connection is separate from your Foxhound Stripe connection. ${AUDIT_ACCESS_ASK} ${AUDIT_ACCESS_PROMISE} Share the link with colleagues, or use it to see what Foxhound would work on before you connect.`,
      ],
    },
    {
      heading: "Settings reference",
      body: [
        "Settings is a hub: Stripe connections, Email, Brand voice, Disputes, Audit, Notifications and alerts, Team, API keys, and My account, each on its own page, listed in the menu down the side.",
        { kind: "h3", text: "Email settings" },
        "Found in Settings and Email.",
        {
          kind: "table",
          label: "Email settings",
          columns: ["Setting", "What it does"],
          rows: [
            [
              "Sender name",
              'The name your customers see in the From line of every recovery email. Recovery mail goes out from "Support" until you set it.',
            ],
            [
              "Reply-to email",
              "Where your customers' replies to recovery, win-back and expiring-card emails go. Use your support inbox. Until you set one, replies go to the address in the From line.",
            ],
            [
              "Send test email",
              "Delivers a real recovery email to your own address through the sending path your customers get, so you can read the From line and the copy before a real failure.",
            ],
          ],
        },
        {
          kind: "note",
          body: "The sending domain is Foxhound's verified address on every account and is not a setting.",
        },
        { kind: "h3", text: "Brand voice" },
        'The voice for a given email is the one set for that decline category, or the main voice when the category has none, or Foxhound\'s own default when neither is set. The most specific voice available wins. The page holds a voice for each category: soft declines, expired cards, network declines, and fraud or hard declines. A category left on "Same as main voice" falls back to the main one.',
        {
          kind: "tip",
          body: "A fraud-flagged decline often reads better in a softer voice than the one you would use for an expired card. That is what the per-category fields are for.",
        },
        { kind: "h3", text: "Merchant context" },
        "The industry, customer type and monthly revenue you enter under Settings and My account go to the AI with every recovery email, so a message written for a B2B SaaS account does not read like one written for a consumer store. Leave them blank and the copy simply omits that context.",
        {
          kind: "table",
          label: "Merchant context fields",
          columns: ["Field", "What it does"],
          rows: [
            [
              "Industry",
              "What the business sells, so the email is written for that kind of buyer.",
            ],
            [
              "Primary customer type",
              "Who is being written to, which changes the register a great deal between businesses and consumers.",
            ],
            [
              "Monthly recurring revenue",
              "Roughly how big the business is, which changes how a payment of a given size reads.",
            ],
          ],
        },
        { kind: "h3", text: "Notifications" },
        "Foxhound emails the notification email set in Settings and Notifications. The field starts out holding the address you sign in with, and nothing is sent until the page has been saved with an address in it. Set no notification email and Foxhound sends nothing. Each notification has its own switch on the same page.",
        {
          kind: "list",
          items: [
            [
              { strong: "Payment recovered." },
              " Emailed when a payment in a sequence comes back, with the amount, the customer, and the decline that started it. On unless you switch it off.",
            ],
            [
              { strong: "Sequence complete." },
              " Emailed when a sequence runs out of steps without the payment coming back, so you can decide whether to chase it or write it off. On unless you switch it off.",
            ],
            [
              { strong: "Slack." },
              " Slack delivery posts to an incoming webhook you paste on the notifications page, when a recovery email goes out and when a retry recovers a payment. Off until you switch it on.",
            ],
            [
              { strong: "Weekly digest." },
              " Monday morning summary of the previous seven days. Off until you switch it on.",
            ],
            [
              { strong: "Monthly audit report." },
              " One email on the 1st, switched on under Settings and Audit, carrying a fresh audit of your Stripe account and what Foxhound recovered for you.",
            ],
          ],
        },
        "It sends once per recovery: a repeated webhook from Stripe does not produce a second email. A payment that recovers gets the recovery email and never the sequence-complete one, so you never get both for one payment.",
        {
          kind: "note",
          body: "Win-back and expiring-card emails are switches in Settings and Email rather than with your notifications, because they turn the engine off rather than changing who hears about it.",
        },
        { kind: "h3", text: "Alerts" },
        "The Alerts section of Settings and Notifications lets you set a threshold on any of eleven metrics: recovery rate, MRR at risk, active sequences, emails sent in the last 7 days, open disputes, disputes due in 48 hours, dispute amount at stake, high-risk customers, MRR at risk from Intelligence, audit revenue leaking, and the change in leaking since the prior audit. Choose whether the metric dropping below or rising above your number counts, and whether the alert goes by email or to Slack.",
        "Foxhound checks your alerts after each recovery run. Every breach is recorded and shown under Recent triggers on that page, and sent to the alert's channel no more than once a day for each alert: email goes to your notification address, Slack to the webhook on the notifications page.",
        { kind: "h3", text: "API keys" },
        "Settings and API keys issues credentials for external AI agents. A key is shown once, when you generate it, and only its hash is stored, so Foxhound cannot show it to you again. Name each key so you can tell them apart, and revoke any key from the same page. A revoked key stops working immediately.",
        { kind: "h3", text: "Connecting an agent" },
        {
          kind: "p",
          body: [
            "Point an MCP client at ",
            { mono: "https://foxhoundapp.com/mcp" },
            " and give it the key as a bearer token. The endpoint speaks the Model Context Protocol over HTTP, and the key decides which account it reads: one key, one account, always the one that issued it.",
          ],
        },
        "Most of the tools READ. An agent can list your audit runs and open one, read your recovery queue, disputes, billing ledger and invoices, your recurring-revenue overview, churn, customers and alerts, see which Stripe accounts are connected, and read back the brand voice and the merchant context before changing either.",
        "Two tools WRITE, and they change settings only: your audit lookback and monthly report, the win-back and expiring-card features, your notification email, Slack webhook and notification toggles, the sender name and the brand voice on a connected Stripe account, the industry and customer type you have told Foxhound about, and your alerts, which an agent can create, switch off and delete. Each one runs the same validation the settings page runs, so an agent gets refused for the same reasons you would and reads the same sentence. Leaving a field out of the brand voice or the business context leaves it as it is and only an empty value clears one; the notification settings are replaced as a whole, so an agent sends all of them.",
        {
          kind: "note",
          body: "Every change an agent makes is recorded with the key that made it, the tool it used and the fields it touched. The record keeps field names, never the values, so it never becomes a second copy of your settings.",
        },
        "There is no tool that submits dispute evidence, cancels an account, disconnects Stripe, issues another key or moves money in any way, and those are absent by construction rather than switched off.",
        {
          kind: "note",
          body: "Customer names are never sent through the endpoint and email addresses are masked to their first character and domain, so an agent can recognize a customer you already know without being able to write to one. The Stripe customer id comes through whole, which is what a follow-up question needs.",
        },
        { kind: "h3", text: "Team" },
        "Invite teammates from Settings and Team. The page lists everyone on the account with their role, Owner or Member, and marks an invite nobody has accepted yet as Pending.",
        { kind: "h3", text: "Inviting a team member" },
        {
          kind: "steps",
          items: [
            [
              "Enter their email address under Settings and Team and click ",
              { strong: "Send invite" },
              ". Only the account owner sees the invite form.",
            ],
            "Foxhound shows you the invite link. Send it to them yourself: Foxhound does not email it. It stays valid for seven days.",
            "Someone who already has a Foxhound account joins on opening it. Someone who does not signs up first and joins on the way through.",
          ],
        },
        {
          kind: "note",
          body: "An invite belongs to the address it was sent to. Opening it while signed in as somebody else refuses rather than joining the wrong person, and an invite to an account you are already on takes you there instead of failing.",
        },
        { kind: "h3", text: "Removing a team member" },
        "Click Remove member next to a member and confirm. The owner can remove any member other than themselves, and nobody else can remove anyone. Access ends immediately, and the owner cannot be removed at all.",
        { kind: "h3", text: "Roles" },
        "Each person on an account is its Owner or a Member. The owner invites and removes members and cannot be removed. Only the owner connects or disconnects Stripe, puts the card on file for billing, creates or revokes API keys, turns dispute auto-submit on or off, accepts a dispute, and cancels the account. Every other setting is open to every member.",
        { kind: "h3", text: "Billing and subscription" },
        `Each monthly run bills the prior month's matured recoveries, meaning recoveries held for ${RECOVERY_MATURITY_DAYS} or more days, at ${RECOVERY_FEE_PERCENT}%. Recoveries Stripe would have gotten on its own are never billed. Disputes are billed at ${DISPUTE_FEE_PERCENT}% of wins only, capped at ${formatMoneyShort(DISPUTE_FEE_CAP_CENTS, "usd")} per dispute. Intelligence and the audit are always free.`,
        "A payment method goes on file once, under Billing. Invoices and the full evidence ledger are visible there at any time.",
        { kind: "h3", text: "Cancellation" },
        "Cancel account under Danger zone in Settings and My account stops the work. Only the account's owner sees it. Every Stripe connection on the account is disconnected, no further sequence runs, and the recoveries Foxhound already attributed still invoice. Your billing history and the evidence behind it are left intact.",
        { kind: "h3", text: "Account deletion" },
        "Delete account, also under Danger zone in Settings and My account, permanently deletes your login and your personal data and removes you from every account you belong to. Each account you own is cleared too: your customers' names and emails are removed and every active recovery sequence is canceled. Foxhound keeps the amounts, dates and Stripe ids of the payments it recovered, because its fees are billed on them. Deletion cannot be undone.",
      ],
    },
  ],
};
