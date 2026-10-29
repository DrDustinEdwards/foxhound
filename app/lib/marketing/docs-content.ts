// The five docs guides behind /docs/:slug (row M18). Recova's guides are the
// spec for their Parts, their H3s and their order (J73): app/(marketing)/docs/
// {platform,audit,recovery,disputes,intelligence}/page.tsx at blobs 2b69517b,
// 3b1153b4, 6166a6be, 598fcbaa and e7f18266, read whole. Every sentence is
// Foxhound's, true of Foxhound's engine and its built settings pages; Recova's
// copy described Recova's engine and is never restored verbatim (RULES.md 2.1).
// Where Foxhound has not built what a Recova heading describes, the Part says
// so, and the H3s whose whole content was that feature are cut, each named in
// test/docs-guides-j73.test.ts.
//
// Figures come from the engine's constants, not retyped: the fee, the cap, the
// windows, the bands and the schedules.

import type { DocWidgetName } from "~/components/docs/doc-widgets";
import {
  AUDIT_LOOKBACK_DAYS,
  AUDIT_TOKEN_TTL_SECONDS,
  BULK_ACTION_CONFIRM_THRESHOLD,
  BULK_ACTION_MAX_PER_SUBMISSION,
  CAU_EVENT_RETENTION_DAYS,
  CLICK_SUSPECT_MIN_SECONDS,
  DISPUTE_FEE_BPS,
  DISPUTE_FEE_CAP_CENTS,
  EMAIL_ENGAGEMENT_WINDOW_DAYS,
  HEALTH_SCORE_AT_RISK_THRESHOLD,
  INTELLIGENCE_REPORT_HOURLY_LIMIT,
  MIN_EXPIRED_DECLINES_FOR_CAU_ADVISORY,
  RECOVERY_FEE_BPS,
  RECOVERY_MATURITY_DAYS,
} from "~/lib/constants";
import { RECOVERY_RANGES } from "~/lib/dashboard/recovery-window";
import { EVIDENCE_FILES_LIMITS_LINE } from "~/lib/disputes/evidence-files";
import { DEADLINE_SOON_DAYS, DEADLINE_URGENT_DAYS } from "~/lib/disputes/labels";
import { WATCH_CEILING } from "~/lib/intelligence/health-band";
import { RECOVERY_SCHEDULES } from "~/lib/recovery/schedule";
import { INTELLIGENCE_WINBACK_SENTENCE } from "~/lib/marketing/winback-copy";

// THE BLOCK VOCABULARY, Recova's own.
//
// A PLAIN STRING IS A PARAGRAPH. Anything richer is a tagged object, so the two
// forms cannot be confused. Recova's inline set is Strong, Code, RelLink and a
// bare font-mono span, plus a HealthScoreBadge inside the intelligence guide's
// thresholds paragraph; its block set is H3, Note, Tip, Steps, List and a
// reference table.

export type DocInline =
  | string
  | { code: string }
  | { strong: string }
  | { mono: string }
  | { badge: number }
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
  /** `label` names the table's scroll region for a screen reader. */
  | { kind: "table"; label: string; columns: string[]; rows: DocRich[][] }
  | { kind: "widget"; name: DocWidgetName };

export interface DocGuide {
  slug: string;
  /** The /docs card's title, and the breadcrumb's last item. */
  title: string;
  /** The /docs card's description, and the page's meta description. */
  description: string;
  /** The page's h1, Recova's page heading ("Platform setup"). */
  heading: string;
  /** The page's lead under the h1, Recova's page lead. */
  lead: string;
  /**
   * ISO date the guide first shipped, for the TechArticle JSON-LD.
   *
   * MEASURED FROM GIT, NOT CHOSEN. All five guides first appear in commit
   * `5478d6b` (2026-07-19). NO `dateModified` counterpart: the content module
   * tracks no per-guide revision and the Worker has no git at runtime.
   */
  datePublished: string;
  sections: { heading: string; body: DocBlock[] }[];
}

/** The date every guide in DOC_GUIDES first shipped. */
export const DOCS_FIRST_PUBLISHED = "2026-07-19";

const pct = (bps: number) => `${bps / 100}%`;
const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US")}`;
const RECOVERY_FEE = pct(RECOVERY_FEE_BPS);
const DISPUTE_FEE = pct(DISPUTE_FEE_BPS);
const NETWORK_FIRST = RECOVERY_SCHEDULES.network[0]!;
const EXPIRED_RETRY_DAY = RECOVERY_SCHEDULES.expired.find((s) => s.stepType === "retry_day21")!.offsetHours / 24;

export const DOC_GUIDES: DocGuide[] = [
  {
    slug: "platform",
    datePublished: DOCS_FIRST_PUBLISHED,
    title: "Platform",
    description: "Connecting Stripe, settings, team management, and billing.",
    heading: "Platform setup",
    lead: "Connecting Stripe, configuring settings, managing your team, and understanding billing.",
    sections: [
      {
        heading: "Getting started",
        body: [
          { kind: "h3", text: "How Foxhound works" },
          "Foxhound watches your connected Stripe account for failed payments. Stripe sends a webhook within seconds of a failure, Foxhound reads the decline code, sorts the failure into a category, and opens a recovery sequence for it without you doing anything.",
          "A sequence is a quiet retry first wherever the decline can be retried, then AI-written emails and any further retries spread across up to thirty days, with the timing chosen by what went wrong. If the payment comes back at any point, the steps still ahead of it are canceled. If the sequence runs out without the payment coming back, the payment is marked failed unrecovered and you are told.",
          "Foxhound works every failed payment on its own, and you can step in on any payment from its page.",
          { kind: "note", body: "Foxhound starts after Stripe's own Smart Retries have run and failed. It does not interfere with Stripe's recovery logic, and a payment Stripe brings back on its own is recorded and never billed." },
          { kind: "h3", text: "Connecting your Stripe account" },
          "Foxhound connects to your Stripe account through Stripe Connect with read and write OAuth scope, because retrying a failed invoice is a write. Foxhound reads invoices, subscriptions, disputes, and customer data. It writes for these things and no others: retrying payment on an invoice that has already failed, setting a customer default payment method after that customer updates their card, opening a Stripe checkout when a former customer chooses to resubscribe, submitting dispute evidence once someone on your team has approved it, and closing a dispute at Stripe when you choose to accept it. It never changes prices, products, or subscription plans, never charges a customer except by retrying a failed invoice or through a checkout they complete, and never reaches your payouts or bank account.",
          { kind: "steps", items: [
            [{ link: "Open /connect", to: "/connect" }, " and give the account a name."],
            [{ strong: "Connect with Stripe" }, " sends you to Stripe's authorization page."],
            "Choose the Stripe account you want watched and authorize the connection.",
            "You land back in Foxhound and monitoring starts immediately.",
          ] },
          { kind: "tip", body: "One Foxhound login can hold several accounts, each with its own Stripe connection, settings, dashboard and invoices. Add another from the account switcher in the header, and use the same switcher to move between them. Nothing on any page mixes two accounts together." },
          { kind: "h3", text: "Disconnecting Stripe" },
          "Disconnect at any time from your Stripe dashboard or from Settings inside Foxhound, under Stripe connections, one connected Stripe account at a time. Disconnecting stops recovery work on that Stripe account immediately, and any other Stripe account you have connected keeps running. It does not close your Foxhound account and it does not waive fees already earned on recoveries Foxhound attributed, which still invoice. To stop everything, cancel the account under Danger zone in Settings and My account.",
          { kind: "h3", text: "Initial setup" },
          "Three settings are worth putting in before your first failure, because all three change what your customers read.",
          { kind: "h3", text: "Sender name" },
          "Settings and Email holds the sender name, the name your customers see in the From line of every recovery email. Set it before your first send: until you do, recovery mail goes out from \"Support\". Send test email delivers a sample to your own address through the real sending path, so the From line you see is the one your customers get.",
          { kind: "h3", text: "Reply-to email" },
          "Also in Settings and Email. Set the address your customers reach when they reply to a recovery email. Use an inbox somebody reads, because a customer who replies is often trying to fix their payment. Until you set one, replies go to the address in the From line.",
          { kind: "h3", text: "Brand voice" },
          "Settings and Brand voice sets a different tone for each failure category. A category left on \"Same as main voice\" falls back to the main one.",
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
            "If the payment recovers at any point, every remaining step is canceled and you are emailed.",
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
          `When a subscription is canceled voluntarily, Foxhound starts a win-back sequence: three emails, the first an hour after the cancellation, then one at four days and a last one at fourteen. ${INTELLIGENCE_WINBACK_SENTENCE} Each is written in your brand voice for the step it is, warmer at the first and lighter at the last, and each links to a page where that customer can restart the same plan through Stripe.`,
          "It does not start for a subscription that ended because payments were failing, because that is a recovery and the recovery sequence already has it, and it does not start for a customer you chased in the last seven days. The sequence stops as soon as they come back.",
          { kind: "note", body: "A customer who comes back is matched to their sequence by the identifier Foxhound put on the checkout, never by guessing from the customer. Matching on the customer alone would credit an ordinary renewal as a win-back." },
          "A reactivation is not billed. Win-back brings back a customer who chose to leave, which is not the recovery of a failed payment, so there is no recovered payment and no fee.",
          "Win-back sequences are on unless you turn them off on the features page.",
          { kind: "h3", text: "Weekly digest" },
          "The weekly digest is a Monday morning summary of the previous seven days: revenue recovered, recovery rate, payments failed and recovered, revenue still at risk, active sequences, emails sent, and win-back sequences running. It is off until you enable it on the notifications page, it goes to the same notification email, and it arrives once a week even in a quiet week, so a week with nothing in it still tells you that.",
          { kind: "h3", text: "Slack notifications" },
          "Foxhound posts to Slack when a recovery email goes out and when a retry brings a payment back. Slack delivery posts to an incoming webhook you paste on the notifications page.",
          { kind: "steps", items: [
            "Create an app for your workspace at api.slack.com/apps.",
            [ "Turn on ", { strong: "Incoming Webhooks" }, " and add one to the channel you want." ],
            "Copy the webhook URL.",
            "Paste it into the Slack webhook URL field under Settings and Notifications, switch on Slack notifications, and save.",
          ] },
          { kind: "note", body: "Foxhound only accepts a URL on Slack's own webhook host, so a pasted address that points somewhere else is refused rather than quietly fetched. A delivery that fails is reported back to you rather than swallowed." },
          { kind: "h3", text: "Free lost-revenue audit" },
          { kind: "p", body: [ "The audit at ", { link: "/audit", to: "/audit" }, ` needs no Foxhound account. It connects to Stripe read-only, reads the last ${AUDIT_LOOKBACK_DAYS} days, and shows what is failing, what is about to, and where your disputes and recurring revenue stand. It writes nothing back to Stripe.` ] },
          "The audit's connection is separate from your Foxhound Stripe connection and is read-only. Share the link with colleagues, or use it to see what Foxhound would work on before you connect.",
        ],
      },
      {
        heading: "Settings reference",
        body: [
          "Settings is a hub: Stripe connections, Email, Brand voice, Features, Disputes, Intelligence, Audit, Notifications, Alerts, Team, API keys, and My account, each on its own page with a sub-nav down the side.",
          { kind: "h3", text: "Email settings" },
          "Found in Settings and Email.",
          { kind: "table", label: "Email settings", columns: ["Setting", "What it does"], rows: [
            ["Sender name", "The name your customers see in the From line of every recovery email. Recovery mail goes out from \"Support\" until you set it."],
            ["Reply-to email", "Where your customers' replies to recovery, win-back and expiring-card emails go. Use your support inbox. Until you set one, replies go to the address in the From line."],
            ["Send test email", "Delivers a real recovery email to your own address through the sending path your customers get, so you can read the From line and the copy before a real failure."],
          ] },
          { kind: "note", body: "The sending domain is Foxhound's verified address on every account and is not a setting." },
          { kind: "h3", text: "Brand voice" },
          "The voice for a given email is the one set for that decline category, or the main voice when the category has none, or Foxhound's own default when neither is set. The most specific voice available wins. The page holds a voice for each category: soft declines, expired cards, network declines, and fraud or hard declines. A category left on \"Same as main voice\" falls back to the main one.",
          { kind: "tip", body: "A fraud-flagged decline often reads better in a softer voice than the one you would use for an expired card. That is what the per-category fields are for." },
          { kind: "h3", text: "Merchant context" },
          "The industry, customer type and monthly revenue you enter under Settings and My account go to the AI with every recovery email, so a message written for a B2B SaaS account does not read like one written for a consumer store. Leave them blank and the copy simply omits that context.",
          { kind: "table", label: "Merchant context fields", columns: ["Field", "What it does"], rows: [
            ["Industry", "What the business sells, so the email is written for that kind of buyer."],
            ["Primary customer type", "Who is being written to, which changes the register a great deal between businesses and consumers."],
            ["Monthly recurring revenue", "Roughly how big the business is, which changes how a payment of a given size reads."],
          ] },
          { kind: "h3", text: "Notifications" },
          "Foxhound emails the notification email set in Settings and Notifications. The field starts out holding the address you sign in with, and nothing is sent until the page has been saved with an address in it. Set no notification email and Foxhound sends nothing. Each notification has its own switch on the same page.",
          { kind: "list", items: [
            [{ strong: "Payment recovered." }, " Emailed when a payment in a sequence comes back, with the amount, the customer, and the decline that started it. On unless you switch it off."],
            [{ strong: "Sequence complete." }, " Emailed when a sequence runs out of steps without the payment coming back, so you can decide whether to chase it or write it off. On unless you switch it off."],
            [{ strong: "Slack." }, " Slack delivery posts to an incoming webhook you paste on the notifications page, when a recovery email goes out and when a retry recovers a payment. Off until you switch it on."],
            [{ strong: "Weekly digest." }, " Monday morning summary of the previous seven days. Off until you switch it on."],
            [{ strong: "Monthly audit report." }, " One email on the 1st, switched on under Settings and Audit, carrying a fresh audit of your Stripe account and what Foxhound recovered for you."],
          ] },
          "It sends once per recovery: a repeated webhook from Stripe does not produce a second email. A payment that recovers gets the recovery email and never the sequence-complete one, so you never get both for one payment.",
          { kind: "note", body: "Win-back and expiring-card alerts are switches on the features page rather than the notifications page, because they turn the engine off rather than changing who hears about it." },
          { kind: "h3", text: "Alerts" },
          "Settings and Alerts lets you set a threshold on any of eleven metrics: recovery rate, MRR at risk, active sequences, emails sent in the last 7 days, open disputes, disputes due in 48 hours, dispute amount at stake, high-risk customers, MRR at risk from Intelligence, audit revenue leaking, and the change in leaking since the prior audit. Choose whether the metric dropping below or rising above your number counts, and whether the alert goes by email or to Slack.",
          "Foxhound checks your alerts after each recovery run. Every breach is recorded and shown under Recent triggers on that page, and sent to the alert's channel no more than once a day for each alert: email goes to your notification address, Slack to the webhook on the notifications page.",
          { kind: "h3", text: "API keys" },
          "Settings and API keys issues credentials for external AI agents. A key is shown once, when you generate it, and only its hash is stored, so Foxhound cannot show it to you again. Name each key so you can tell them apart, and revoke any key from the same page. A revoked key stops working immediately.",
          { kind: "h3", text: "Connecting an agent" },
          { kind: "p", body: [ "Point an MCP client at ", { mono: "https://foxhoundapp.com/mcp" }, " and give it the key as a bearer token. The endpoint speaks the Model Context Protocol over HTTP, and the key decides which account it reads: one key, one account, always the one that issued it." ] },
          "Most of the tools READ. An agent can list your audit runs and open one, read your recovery queue, disputes, billing ledger and invoices, your recurring-revenue overview, churn, customers and alerts, see which Stripe accounts are connected, and read back the brand voice and the merchant context before changing either.",
          "Two tools WRITE, and they change settings only: your audit lookback and monthly report, the win-back and expiring-card features, your notification email, Slack webhook and notification toggles, the sender name and the brand voice on a connected Stripe account, the industry and customer type you have told Foxhound about, and your alerts, which an agent can create, switch off and delete. Each one runs the same validation the settings page runs, so an agent gets refused for the same reasons you would and reads the same sentence. Leaving a field out of the brand voice or the business context leaves it as it is and only an empty value clears one; the notification settings are replaced as a whole, so an agent sends all of them.",
          { kind: "note", body: "Every change an agent makes is recorded with the key that made it, the tool it used and the fields it touched. The record keeps field names, never the values, so it never becomes a second copy of your settings." },
          "There is no tool that submits dispute evidence, cancels an account, disconnects Stripe, issues another key or moves money in any way, and those are absent by construction rather than switched off.",
          { kind: "note", body: "Customer names are never sent through the endpoint and email addresses are masked to their first character and domain, so an agent can recognize a customer you already know without being able to write to one. The Stripe customer id comes through whole, which is what a follow-up question needs." },
          { kind: "h3", text: "Team" },
          "Invite teammates from Settings and Team. The page lists everyone on the account with their role, Owner or Member, and marks an invite nobody has accepted yet as Pending.",
          { kind: "h3", text: "Inviting a team member" },
          { kind: "steps", items: [
            [ "Enter their email address under Settings and Team and click ", { strong: "Send invite" }, ". Only the account owner sees the invite form." ],
            "Foxhound shows you the invite link. Send it to them yourself: Foxhound does not email it. It stays valid for seven days.",
            "Someone who already has a Foxhound account joins on opening it. Someone who does not signs up first and joins on the way through.",
          ] },
          { kind: "note", body: "An invite belongs to the address it was sent to. Opening it while signed in as somebody else refuses rather than joining the wrong person, and an invite to an account you are already on takes you there instead of failing." },
          { kind: "h3", text: "Removing a team member" },
          "Click Remove member next to a member and confirm. The owner can remove any member other than themselves, and nobody else can remove anyone. Access ends immediately, and the owner cannot be removed at all.",
          { kind: "h3", text: "Roles" },
          "Each person on an account is its Owner or a Member. The owner invites and removes members and cannot be removed. Otherwise settings, billing and the Stripe connections are open to every member. Only the owner can cancel the account.",
          { kind: "h3", text: "Billing and subscription" },
          `Each monthly run bills the prior month's matured recoveries, meaning recoveries held for ${RECOVERY_MATURITY_DAYS} or more days, at ${RECOVERY_FEE}. Recoveries Stripe would have gotten on its own are never billed. Disputes are billed at ${DISPUTE_FEE} of wins only, capped at ${dollars(DISPUTE_FEE_CAP_CENTS)} per dispute. Intelligence and the audit are always free.`,
          "A payment method goes on file once, under Billing. Invoices and the full evidence ledger are visible there at any time.",
          { kind: "h3", text: "Cancellation" },
          "Cancel account under Danger zone in Settings and My account stops the work. Only the account's owner sees it. Every Stripe connection on the account is disconnected, no further sequence runs, and the recoveries Foxhound already attributed still invoice. Your billing history and the evidence behind it are left intact.",
          { kind: "h3", text: "Account deletion" },
          "Delete account, also under Danger zone in Settings and My account, permanently deletes your login and your personal data and removes you from every account you belong to. Each account you own is cleared too: your customers' names and emails are removed and every active recovery sequence is canceled. Foxhound keeps the amounts, dates and Stripe ids of the payments it recovered, because its fees are billed on them. Deletion cannot be undone.",
        ],
      },
    ],
  },
  {
    slug: "audit",
    datePublished: DOCS_FIRST_PUBLISHED,
    title: "Audit",
    description:
      "Free Stripe diagnostic. What Stripe already recovered, what is still dying, and what Foxhound would add.",
    heading: "Audit",
    lead: "A free Stripe diagnostic that shows what your account is leaking. No signup required.",
    sections: [
      {
        heading: "How the Audit works",
        body: [
          { kind: "p", body: [ "The audit at ", { link: "/audit", to: "/audit" }, ` connects to your Stripe account with read-only OAuth and reads the last ${AUDIT_LOOKBACK_DAYS} days, or the lookback you set under Settings and Audit when you are signed in. It reads four scopes and puts a short written summary at the top.` ] },
          "Foxhound runs the full audit on demand: connect Stripe from the audit page and the run happens while you wait. The audit only reads. It writes nothing back to Stripe.",
          "No Foxhound account is required. Share the audit link with colleagues: they can run it against their own Stripe account without signing up.",
          { kind: "widget", name: "audit-scopes" },
          { kind: "note", body: "The audit uses a connection of its own, separate from the one a Foxhound account uses, and asks Stripe for read-only access. A grant that comes back wider than that is refused rather than used. Your billing configuration, your subscriptions and your payment methods are never touched." },
        ],
      },
      {
        heading: "The four scopes",
        body: [
          { kind: "h3", text: "Failed invoices" },
          "Every failed invoice in the lookback window that is still unpaid: how many, their total value, and how the total splits across Foxhound's six decline categories.",
          "The audit does not project a recovery rate from platform-wide statistics. Foxhound applies no flat recovery estimate to at-risk value, because there is no Foxhound history to draw such a rate from.",
          { kind: "h3", text: "Expiring cards" },
          "Active subscriptions whose card has expired or expires this month or next, counted once per customer, with the MRR those subscriptions carry if their payments fail.",
          { kind: "p", body: [ { strong: "Card Account Updater signal." }, ` If Stripe updated none of your cards in the last ${CAU_EVENT_RETENTION_DAYS} days while ${MIN_EXPIRED_DECLINES_FOR_CAU_ADVISORY} or more expired-card declines hit your account in the same window, the audit says so as an advisory, with the common causes. Stripe's updater prevents many expired-card failures before they happen.` ] },
          { kind: "h3", text: "Open disputes" },
          "Every open dispute: how many and the amount at stake. Beside them, the disputes you lost without submitting any evidence, and your won and lost record.",
          { kind: "h3", text: "Business health" },
          "Your MRR, ARR, active subscription count, and churn rate, split into voluntary (the customer canceled) and involuntary (a payment failed). The involuntary rate is the one Foxhound works on.",
        ],
      },
      {
        heading: "Reading your results",
        body: [
          "The summary at the top is a few plain sentences on what stands out. When the AI model is not available, a fixed sentence takes its place.",
          "Below it, the results come in three sections: Revenue leaking now (failed invoices by category, the Card Updater line, expiring cards, and past-due subscriptions), Disputes unmanaged, and Business snapshot. Where a scope could not be read, it says so rather than showing you a zero, because a zero that means unknown is worse than no number at all.",
        ],
      },
      {
        heading: "Saving results",
        body: [
          { kind: "p", body: [ "Sign in to Foxhound before you run the audit and the run is saved to ", { link: "Audit history", to: "/audit/dashboard" }, ", each run on its own page, so you can follow your numbers over time. It is saved only when the Stripe account you audited is the one connected to the Foxhound account you are in: audit somebody else's account and you still see the results, and they are not filed into your history." ] },
          `Without an account nothing is stored. The results page reads your Stripe account for as long as the ${AUDIT_TOKEN_TTL_SECONDS / 60}-minute authorization lasts, and after that you run the audit again.`,
        ],
      },
      {
        heading: "Auto-run",
        body: [
          "With a Foxhound account, turn on the monthly audit digest under Settings and Audit, and on the 1st of each month Foxhound runs the whole audit again and emails you the result at your notification address, with a link to that run and a line saying what Foxhound recovered for you. It is ONE email. It uses the lookback you set on the same page, and nothing is billed for it.",
          { kind: "note", body: "The report reads your Stripe account fresh, so it needs a live Stripe connection rather than only Foxhound's own records. A scope Stripe would not answer for says so in the email, as it does on the page. Turn auto-run off and nothing is sent." },
        ],
      },
      {
        heading: "Using the audit to evaluate Foxhound",
        body: [
          `The failed invoices scope is the most direct read of what Foxhound would work on: it is the money that failed and is still unpaid. Foxhound's fee is ${RECOVERY_FEE} of a recovery it can show it caused, and nothing on what Stripe recovers by itself, so there is no cost where there is no recovery.`,
          "If the failed invoices scope reads zero, Foxhound Recovery has nothing to add right now, and the audit will not tell you otherwise.",
        ],
      },
    ],
  },
  {
    slug: "recovery",
    datePublished: DOCS_FIRST_PUBLISHED,
    title: "Recovery",
    description: "Managing failed payments, reading sequences, and what each dashboard number means.",
    heading: "Recovery sequences",
    lead: "Managing failed payments, reading sequences, understanding your dashboard, and troubleshooting.",
    sections: [
      {
        heading: "Managing payments",
        body: [
          { kind: "h3", text: "Reading the payments list" },
          { kind: "p", body: [ "The list at ", { link: "/recovery/payments", to: "/recovery/payments" }, " holds every failed payment Foxhound has detected, newest first. A row carries the customer name and email, the amount, the decline category, the current status, and when the failure was detected. Open any row for that payment's own page." ] },
          { kind: "h3", text: "Filtering and search" },
          { kind: "list", items: [
            [{ strong: "Search." }, " Matches on customer name, email, or plan name."],
            [{ strong: "Status tabs." }, " All, Active, Recovered, Canceled and Failed."],
            [{ strong: "Decline category." }, " Narrows to one of the six categories."],
            [{ strong: "Date range." }, " Filters on when the failure was detected."],
            [{ strong: "Amount range." }, " A slider bounded by the smallest and largest amounts you actually have."],
            [{ strong: "Sort." }, " Newest first, oldest first, or by amount."],
          ] },
          "Every filter is a URL parameter, so a filtered view can be bookmarked or sent to somebody else and it opens the same way for them.",
          { kind: "h3", text: "Rows per page" },
          "The selector above the table shows 10, 25, 50, 100, or all of them. It starts at 25.",
          { kind: "h3", text: "Understanding payment statuses" },
          "A payment is in one of five states: Stripe retrying, active, recovered, canceled, or failed unrecovered, which every page labels Failed.",
          { kind: "list", items: [
            [{ strong: "Stripe retrying." }, " Stripe is still attempting the payment on its own schedule. Foxhound is watching and has planned no steps yet."],
            [{ strong: "Active." }, " The sequence is running and at least one step is still ahead of it."],
            [{ strong: "Recovered." }, " The invoice was paid, and every remaining step was canceled."],
            [{ strong: "Canceled." }, " You stopped the recovery, or the subscription behind it ended."],
            [{ strong: "Failed." }, " Every step ran and the payment did not come back. Nothing further happens on its own."],
          ] },
          { kind: "widget", name: "payment-statuses" },
          { kind: "h3", text: "Reading a payment detail page" },
          "A payment's own page carries its whole timeline, from detection to the most recent step. Each step shows what kind it is, when it was scheduled, when it ran, and what came back: an email step shows the subject and the body that was sent, and a retry step shows what Stripe answered.",
          { kind: "widget", name: "payment-timeline" },
          "Opens and clicks are recorded per email step, so you can see whether a message was read and whether the card-update link was followed. The click is the one that matters for billing.",
          { kind: "h3", text: "Manual actions on a payment" },
          { kind: "list", items: [
            [{ strong: "Trigger next step now." }, " Runs the next pending step immediately instead of waiting for its scheduled time."],
            [{ strong: "Mark as recovered." }, " Closes the payment and cancels the rest of the sequence. Use it when the customer paid some other way, which Foxhound has no way to see. A payment you mark recovered is never billed."],
            [{ strong: "Stop recovery." }, " Stops every future step for that payment. It does not touch the customer's subscription."],
            [{ strong: "Resend last email." }, " Sends the last email again and records it as its own step."],
            [{ strong: "Note." }, " A field for your own reference. It is never sent to the customer."],
          ] },
          { kind: "note", body: "Foxhound has no rewrite-the-pending-email control. Each email is written at send time from the customer, the decline and your brand voice, so there is no draft sitting there to edit." },
          { kind: "h3", text: "Bulk actions" },
          `Select rows with the checkboxes and a bar appears at the bottom of the screen. Trigger the next step, mark recovered, or stop recovery for every selected payment at once. Above ${BULK_ACTION_CONFIRM_THRESHOLD} payments Foxhound asks you to confirm, and one submission carries at most ${BULK_ACTION_MAX_PER_SUBMISSION}. Each payment is reported on its own, and any that did not go through stay selected.`,
          { kind: "note", body: "There is no undo. Stop recovery ends the remaining steps for every selected payment." },
          { kind: "h3", text: "Exporting to CSV" },
          "Export CSV in the list header downloads the payments on screen: this page, with the filters, sort and rows per page you have on. Choose All in rows per page to export every payment that matches your filters.",
        ],
      },
      {
        heading: "Recovery sequences",
        body: [
          { kind: "h3", text: "How sequences are built by decline type" },
          "Declines are sorted into six categories: soft, network, expired, fraud, revoked, and unknown. Each gets its own schedule, spread across up to thirty days, chosen by what is actually wrong with the payment. When a retryable payment fails, Foxhound attempts a quiet retry before any customer sees an email, and only after that does the first email go out, with a hosted card-update link.",
          { kind: "widget", name: "decline-categories" },
          "Each category's steps in order, from the engine's own schedule table:",
          { kind: "widget", name: "sequence-timelines" },
          { kind: "p", body: [ { strong: "Why so few retries for expired cards, and none for fraud?" }, ` A retry on an expired card fails every time until the card is updated, and the card networks do not allow retrying the same card number and expiry. So an expired card gets one retry, on day ${EXPIRED_RETRY_DAY}, and it charges only if the card has changed since the decline: Stripe's card updater gave it a new expiry, or the customer added a card on the card-update page. Otherwise the step is skipped. Retrying a blocked card can draw further flags with the issuer, so fraud gets no retry. In both cases the main path to recovery is the customer acting, which is what the emails are for, and a revoked mandate gets a single email for the same reason. An unknown decline gets no retry at all. Emails only, failing closed: no silent retry against a code that has not been classified.` ] },
          { kind: "p", body: [ { strong: `Why does network get an early retry at ${NETWORK_FIRST.offsetHours} hours?` }, " Network errors are usually passing: a processor hiccup or a bank briefly unavailable. Most clear within a few hours on their own, and the early retry catches those before any email is needed." ] },
          { kind: "h3", text: "Reading the sequence performance page" },
          { kind: "p", body: [ "The page at ", { link: "/recovery/sequence", to: "/recovery/sequence" }, " reads across your whole recovery history by category. For each step it shows how many went out, the open rate, the click rate and the most recent subject line used. A retry step shows how often the retry worked instead." ] },
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
          "Nine stat cards sit on the recovery dashboard: three across the top and six further down, under the recovery queue. They read the last 30 days whatever range is selected.",
          { kind: "table", label: "Dashboard stat cards", columns: ["Card", "What it shows"], rows: [
            ["Recovered (30d)", "What came back in the last 30 days."],
            ["Currently at risk", "The total across every payment still in an active sequence, with its share of your MRR when Foxhound has an MRR figure."],
            ["Recovery rate", "The share of failed payments that came back, colored by band: below target at 20% or less, near target from 21% to 35%, above target from 36%."],
            ["Active sequences", "How many payments are being worked right now."],
            ["Win-backs active", "How many canceled customers are in a win-back sequence."],
            ["Cards expiring", "Cards inside the alert window."],
            ["Avg days to recovery", "How long a recovery takes, on average."],
            ["Best category", "Which decline category is recovering best for you."],
            ["Emails sent", "Recovery emails sent in the last 30 days, with their open and click rates."],
          ] },
          { kind: "h3", text: "Date range filter" },
          `The ${RECOVERY_RANGES.slice(0, -1).join(", ")} and ${RECOVERY_RANGES.at(-1)} buttons in the dashboard header change the window the trend charts, the decline breakdown, the win-back panel and the payments preview read from. The recovery timing chart stays on the last 30 days, as the stat cards do. The range starts at 30 days.`,
          "The recovery queue always shows the steps due in the next 48 hours, whatever the range.",
          "The email deliverability panel, under the stat cards, follows the range: the share of the emails Foxhound sent that bounced or were reported as spam. Foxhound does not yet record bounces and spam reports against the account that sent the email, so for now the panel says there is nothing to show. It shows no delivered rate, because Foxhound does not record delivery.",
          { kind: "h3", text: "ROI widget" },
          `The Foxhound-attributed revenue panel shows what Foxhound recovered this month and over all time, counting only recoveries where a Foxhound action provably preceded payment, with the ${RECOVERY_FEE} fee on each and what you keep. This month counts every such recovery since the 1st, with the fee it will carry once it has held for ${RECOVERY_MATURITY_DAYS} days; all time counts the ones that have held for ${RECOVERY_MATURITY_DAYS} days, which are the ones Foxhound bills.`,
          "A recovery is billable only when a Foxhound action provably preceded payment: a scheduled retry succeeded, a dunning email was clicked or otherwise engaged (not just opened), or a card was updated through a Foxhound page. Everything else is Stripe's own baseline recovery, recorded and shown to you, never billed.",
          `A click only counts if it came within ${EMAIL_ENGAGEMENT_WINDOW_DAYS} days before the payment came back. A customer who clicks and then pays two months later was not brought back by that email, so the recovery records as Stripe's own baseline and is free.`,
          { kind: "note", body: `Some clicks are not people. A click that arrives within ${CLICK_SUSPECT_MIN_SECONDS} seconds of the email being sent, or on a link no human can see, is marked suspect: corporate mail scanners follow every link in a message before it reaches the inbox. A suspect click is shown on the ledger with its reason and is never billed.` },
          { kind: "h3", text: "Recovery rate benchmark" },
          "The dashboard shows no outside benchmark beside your rate. Its color comes from the bands above, not from a figure published by Stripe or anyone else.",
          { kind: "h3", text: "Webhook health indicator" },
          "A badge in the dashboard header shows whether Stripe is still reaching Foxhound. A webhook inside the last day reads as receiving normally, nothing for a day reads as quiet, and nothing for more than three days is flagged as a problem worth checking. A brand new connection that has not seen one yet says so rather than reading as a failure.",
        ],
      },
      {
        heading: "Troubleshooting",
        body: [
          { kind: "h3", text: "A payment is not being detected" },
          { kind: "list", items: [
            [{ strong: "Is the Stripe account still connected?" }, " Settings and Stripe connections lists every live connection on this account."],
            [{ strong: "Has Stripe finished its own retries?" }, " The payment appears as soon as it fails, marked as Stripe's to retry. Foxhound's sequence starts when Stripe stops."],
            [{ strong: "Is the payment on the account you are looking at?" }, " If you hold more than one, check the account switcher in the header."],
            [{ strong: "Is Stripe still reaching Foxhound?" }, " The webhook health badge on the dashboard says so."],
          ] },
          { kind: "h3", text: "Emails are not sending" },
          { kind: "list", items: [
            [{ strong: "Is the address suppressed?" }, " A customer who unsubscribed, hard bounced, or reported an email as spam is suppressed, and Foxhound will not send to them again."],
            [{ strong: "Is the step actually due?" }, " The timeline on the payment page shows when each step is scheduled."],
          ] },
          { kind: "note", body: "Suppression is per address and it holds. It exists so a customer who asked to stop hearing from you is not mailed again by a later sequence." },
          { kind: "h3", text: "Recovery rate seems low" },
          { kind: "list", items: [
            [{ strong: "How many closed payments are behind it?" }, " A rate over a handful of payments moves on every one of them. Give it a billing cycle."],
            [{ strong: "What is the decline mix?" }, " Fraud and revoked recover less by nature. The decline breakdown on the dashboard shows yours."],
            [{ strong: "Are the emails being opened?" }, " Low open rates on the sequence page point at deliverability rather than at the copy."],
            [{ strong: "Is the brand voice set?" }, " Copy written without one is more generic than copy written with one."],
          ] },
          { kind: "h3", text: "A customer says they did not receive an email" },
          { kind: "list", items: [
            "Check the timeline on the payment page and confirm the step ran rather than sitting pending.",
            "Check whether the address is suppressed.",
            "Ask them to look in spam.",
            "Use Resend last email on the payment page to send it again.",
          ] },
        ],
      },
    ],
  },
  {
    slug: "disputes",
    datePublished: DOCS_FIRST_PUBLISHED,
    title: "Disputes",
    description: "Evidence drafted for you. You review and sign every submission.",
    heading: "Disputes",
    lead: "Evidence building, triage scoring, review and submission for Stripe disputes.",
    sections: [
      {
        heading: "How Disputes works",
        body: [
          { kind: "h3", text: "How Foxhound handles disputes" },
          "When a dispute opens on your connected Stripe account, Foxhound receives the webhook within seconds and begins building evidence. For each dispute it pulls the customer's prior charge history, the AVS and CVV results, the Stripe Radar score and 3D Secure result of the disputed charge, the customer's subscription, and, when the charge is a payment Foxhound recovered, the recovery sequence that payment went through: each step that ran, with when an email was opened and clicked.",
          "Foxhound then scores the dispute with a triage recommendation, fight or accept, and a confidence percentage. The evidence is staged as a draft and the dispute waits in Pending review for a person on your team. You review it, add what only you know, and approve it, and Foxhound submits it to Stripe.",
          { kind: "widget", name: "dispute-states" },
          { kind: "note", body: "Foxhound hears about disputes by webhook. If a dispute opened before you connected Foxhound, use Sync dispute from Stripe on your disputes dashboard to bring it in." },
          { kind: "note", body: "The approval step is enforced by the database, not by a setting. There is no state that reaches Stripe without passing through an approval, and no way to configure one." },
        ],
      },
      {
        heading: "Dispute triage",
        body: [
          { kind: "h3", text: "The triage score" },
          "Every dispute gets a recommendation, fight or accept, with a confidence from 0 to 100. It comes from the dispute reason, the customer's prior successful charges, the AVS and CVV results, the dispute amount, and whether you ship physical goods. The recommendation and its reason are shown at the top of the dispute's page and in the new-dispute email.",
          { kind: "h3", text: "Fight recommendations" },
          "A fight recommendation means the record supports you. Common signals: the customer has paid you before without a dispute, AVS and CVV passed, or the dispute is about a subscription Stripe's records show was active.",
          { kind: "h3", text: "Accept recommendations" },
          "An accept recommendation means the evidence is weak. Common signals: a physical-goods order with no proof of delivery, or a small amount where the time spent fighting costs more than the dispute.",
          { kind: "h3", text: "Dispute reasons" },
          "The reason code shapes both the evidence and the likely outcome:",
          { kind: "list", items: [
            [{ code: "fraudulent" }, ": the strongest case for fighting when the customer has paid before and the card checks passed."],
            [{ code: "subscription_canceled" }, ": cancellation evidence and email history matter most."],
            [{ code: "unrecognized" }, ": the customer does not recognize the charge. The Radar result and their charge history carry the case."],
          ] },
        ],
      },
      {
        heading: "Evidence building",
        body: [
          { kind: "h3", text: "What Foxhound includes" },
          "Foxhound stages these fields automatically, each read from Stripe or from Foxhound's own records:",
          { kind: "steps", items: [
            [{ strong: "Customer details." }, " The name, email, billing address and purchase IP on the disputed charge."],
            [{ strong: "Product description." }, " Your description from Dispute settings, or the plan the customer was on."],
            [{ strong: "Service date." }, " When the subscription started, or when the failed payment was detected if the start is not known."],
            [{ strong: "Subscription." }, " The customer's subscription, when it started and whether it was canceled."],
            [{ strong: "Customer communication." }, " When the charge is a payment Foxhound recovered, the recovery sequence it went through, with when an email was opened and clicked."],
            [{ strong: "Additional notes." }, " A short summary written by the AI model and limited to the recovery facts above. When the model is not available, the field is left for you."],
          ] },
          "The dispute's page also shows the prior charge history, the AVS and CVV results, the Stripe Radar score and the 3D Secure result, for you to weigh before you approve. The Additional notes field at the bottom of the evidence form is for everything else: shipping details, support tickets, correspondence.",
          { kind: "h3", text: "File uploads" },
          `You can attach files to a dispute as additional evidence: ${EVIDENCE_FILES_LIMITS_LINE} Common attachments: signed contracts, usage logs, email correspondence, screenshots.`,
        ],
      },
      {
        heading: "Submitting a dispute",
        body: [
          "Review the staged evidence on the dispute's page, edit it and save, then click Approve and submit. The button shows the fee Foxhound would charge if the dispute is won. Foxhound records who approved it and submits the evidence you saved to Stripe through the API.",
          { kind: "h3", text: "Auto-submit" },
          "There is no auto-submit toggle. There never has been.",
          { kind: "note", body: "Foxhound has no automatic-submission setting and will not have one: the approval gate is schema-enforced, so a submission with nobody's name on it cannot be built, let alone configured." },
          { kind: "h3", text: "Deadlines" },
          `Each dispute shows the days left to respond. The count is shown in red when ${DEADLINE_URGENT_DAYS} days or fewer remain, and in the caution color when ${DEADLINE_SOON_DAYS} days or fewer remain. Once the deadline has passed the dispute says so. Foxhound emails a reminder 3 days and 1 day before the deadline while nobody has submitted the dispute.`,
        ],
      },
      {
        heading: "Accepting a dispute",
        body: [
          "Click Accept dispute on the dispute's page and confirm. This closes the dispute at Stripe without submitting evidence. Stripe keeps its dispute fee, and Foxhound charges nothing on a dispute you accept.",
          "Use accept when the triage recommends it and the customer has a legitimate complaint. Fighting a weak case costs more time than it is likely to win back.",
        ],
      },
      {
        heading: "Settings",
        body: [
          { kind: "h3", text: "Product description" },
          "A plain-English description of what you sell. Foxhound uses it as the product description in every dispute's evidence. It helps most with unrecognized and subscription_canceled disputes.",
          { kind: "h3", text: "Ships physical goods" },
          "When this is on, the dispute page adds shipping fields to the evidence form, and triage weighs a not-received dispute without proof of delivery as one to accept. Leave it off for software and services.",
          "There is no auto-submit setting and there will not be one (Part 4).",
        ],
      },
      {
        heading: "Billing",
        body: [
          `${DISPUTE_FEE} of disputes Foxhound wins, capped at ${dollars(DISPUTE_FEE_CAP_CENTS)} per dispute. Nothing on disputes you lose or accept.`,
          "Nothing is charged on a dispute you lose, a dispute you accept, or a dispute you handled yourself outside Foxhound. The Fees owed card on the disputes dashboard shows what is still owed.",
        ],
      },
    ],
  },
  {
    slug: "intelligence",
    datePublished: DOCS_FIRST_PUBLISHED,
    title: "Intelligence",
    description:
      "Customer health scores, churn risk and MRR trends, free on every account.",
    heading: "Intelligence",
    lead: "Customer health scoring, churn prediction, MRR trend analysis, and AI-generated insights.",
    sections: [
      {
        heading: "How Intelligence works",
        body: [
          "Each night Intelligence scores the customers it has synced from your Stripe account. Every customer gets a health score from 0 to 100, and the score puts them in one of three bands.",
          { kind: "widget", name: "health-bands" },
          "The score is a way of sorting. What it is for is finding the customers worth your attention before they leave.",
          { kind: "note", body: "Intelligence is free and on for every account. There is nothing to subscribe to or turn on." },
        ],
      },
      {
        heading: "Health scores",
        body: [
          { kind: "h3", text: "The 0-100 score" },
          "Every customer starts from the same baseline, and five signals move the score from there:",
          { kind: "list", items: [
            [{ strong: "Payment timing." }, " Paying later and later against the due date pulls the score down; paying early lifts it a little."],
            [{ strong: "Billing changes." }, " Plan, billing interval and seat changes count as volatility and pull it down."],
            [{ strong: "Refunds and disputes." }, " Each one on record pulls it down."],
            [{ strong: "Recovery engagement." }, " A customer who has had failed payments and never engaged with a recovery email, or not for half a year, loses points."],
            [{ strong: "Tenure." }, " Long-standing customers gain points."],
          ] },
          "A customer with none of these on record keeps the baseline score rather than being penalized or left unscored.",
          { kind: "widget", name: "customer-columns" },
          { kind: "h3", text: "Score thresholds and colors" },
          { kind: "p", body: [ { badge: 20 }, ` Below ${HEALTH_SCORE_AT_RISK_THRESHOLD}, at risk. `, { badge: 50 }, ` ${HEALTH_SCORE_AT_RISK_THRESHOLD} to ${WATCH_CEILING - 1}, watch. `, { badge: 82 }, ` ${WATCH_CEILING} and above, healthy.` ] },
          { kind: "note", body: `The bands are strict at the edges: anything below ${HEALTH_SCORE_AT_RISK_THRESHOLD} is at risk, so a ${HEALTH_SCORE_AT_RISK_THRESHOLD - 1} reads as at risk and ${HEALTH_SCORE_AT_RISK_THRESHOLD} as watch. Each badge and band above is drawn from the same constant the engine scores with, so they cannot drift.` },
        ],
      },
      {
        heading: "Recommendations",
        body: [
          "Intelligence does not recommend an action for each customer yet, and the customers page has no Recommended action column. Each customer's own page lists the factors that moved their score instead, which is the part a person can act on.",
        ],
      },
      {
        heading: "Churn risk",
        body: [
          "The churn page splits your MRR across the three health bands, with how many customers are in each, so the question it answers is how much money is sitting in at-risk customers rather than how many of them there are.",
          "Below that, the high-risk customers are listed with the highest monthly contribution first, so the most valuable customer at risk is the first one you read.",
        ],
      },
      {
        heading: "MRR trends",
        body: [
          "The Intelligence dashboard charts total MRR and MRR by plan, net revenue retention over the last 90 days, where above 100% means expansion outran churn, and the MRR movement behind it by week: new, expansion, reactivation, contraction and churn.",
          "A week whose total barely moves can still be hiding a lot of both, which is what the movement chart is for. Customer data is synced from Stripe every day, and once right after you connect, so each bar is a week of those days.",
        ],
      },
      {
        heading: "AI analyst",
        body: [
          "Each night, after scoring, the AI analyst writes a short narrative for the account: the MRR at risk and the at-risk customers that matter most. It works only from the scores and signals Foxhound computed, which it puts into words and never invents.",
          "The current month's narrative is on the Intelligence dashboard and is rewritten each night, and every month keeps its own under Reports.",
          `You can also generate this month's report from the dashboard yourself, up to ${INTELLIGENCE_REPORT_HOURLY_LIMIT} times an hour. When the AI model cannot run, the dashboard says so and no report is written.`,
          { kind: "tip", body: "When the AI model is not available, no narrative is written that night. The scores, the bands and the alerts still update." },
        ],
      },
      {
        heading: "Settings",
        body: [
          "With Intelligence active, Settings and Intelligence lists what Intelligence would deliver to you and marks it not built: there is no weekly narrative email or Slack post yet, so there is nothing to set there.",
          { kind: "h3", text: "Health alert" },
          "Settings and Alerts lets you set a threshold on the number of high-risk customers, those with a health score of 33 or below, or on the MRR they carry, firing when the metric drops below or rises above your number. Foxhound checks after each recovery run, records each breach under Recent triggers on that page, and sends it by email or to Slack, no more than once a day for each alert. It does not alert on one customer's score.",
        ],
      },
    ],
  },
];

export function getDocGuide(slug: string): DocGuide | undefined {
  return DOC_GUIDES.find((g) => g.slug === slug);
}
