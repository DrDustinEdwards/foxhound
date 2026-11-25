import { RECOVERY_FEE_PERCENT } from "~/lib/billing/page";
import { SUPPORT_EMAIL } from "~/lib/seo/jsonld";
import {
  BULK_ACTION_CONFIRM_THRESHOLD,
  BULK_ACTION_MAX_PER_SUBMISSION,
  EMAIL_ENGAGEMENT_WINDOW_DAYS,
  RECOVERY_MATURITY_DAYS,
} from "~/lib/constants";
import { CLICK_SUSPECT_MIN_SECONDS } from "~/lib/email/constants";
import { RECOVERY_RANGES } from "~/lib/dashboard/recovery-window";
import { listText } from "capsomer/behavior/hooks";
import { RECOVERY_SCHEDULES } from "~/lib/recovery/schedule";
import type { DocGuide } from "~/lib/marketing/docs-content";

const NETWORK_FIRST = RECOVERY_SCHEDULES.network[0]!;
const EXPIRED_RETRY_DAY =
  RECOVERY_SCHEDULES.expired.find((s) => s.stepType === "retry_day21")!.offsetHours / 24;

export const RECOVERY_GUIDE: Omit<DocGuide, "datePublished"> = {
  slug: "recovery",
  title: "Recovery",
  description: "Managing failed payments, reading sequences, and what each dashboard number means.",
  heading: "Recovery sequences",
  sections: [
    {
      heading: "Managing payments",
      body: [
        { kind: "h3", text: "Reading the payments list" },
        {
          kind: "p",
          body: [
            "The list at ",
            { link: "/recovery/payments", to: "/recovery/payments" },
            " holds every failed payment Foxhound has detected, newest first. A row carries the customer name and email, the amount, the decline category, the current status, and when the failure was detected. Open any row for that payment's own page.",
          ],
        },
        { kind: "h3", text: "Filtering and search" },
        {
          kind: "list",
          items: [
            [{ strong: "Search." }, " Matches on customer name, email, or plan name."],
            [{ strong: "Status tabs." }, " All, Active, Recovered, Canceled and Failed."],
            [{ strong: "Decline category." }, " Narrows to one of the six categories."],
            [{ strong: "Date range." }, " Filters on when the failure was detected."],
            [
              { strong: "Amount range." },
              " A slider bounded by the smallest and largest amounts you actually have.",
            ],
            [{ strong: "Sort." }, " Newest first, oldest first, or by amount."],
          ],
        },
        "Every filter is a URL parameter, so a filtered view can be bookmarked or sent to somebody else and it opens the same way for them.",
        { kind: "h3", text: "Rows per page" },
        "The selector above the table shows 10, 25, 50, 100, or all of them. It starts at 25.",
        { kind: "h3", text: "Understanding payment statuses" },
        "A payment is in one of five states: Stripe retrying, active, recovered, canceled, or failed unrecovered, which every page labels Failed.",
        {
          kind: "list",
          items: [
            [
              { strong: "Stripe retrying." },
              " Stripe is still attempting the payment on its own schedule. Foxhound is watching and has planned no steps yet.",
            ],
            [
              { strong: "Active." },
              " The sequence is running and at least one step is still ahead of it.",
            ],
            [
              { strong: "Recovered." },
              " The invoice was paid, and every remaining step was canceled.",
            ],
            [
              { strong: "Canceled." },
              " You stopped the recovery, or the subscription behind it ended.",
            ],
            [
              { strong: "Failed." },
              " Every step ran and the payment did not come back. Nothing further happens on its own.",
            ],
          ],
        },
        { kind: "widget", name: "payment-statuses" },
        { kind: "h3", text: "Reading a payment detail page" },
        "A payment's own page carries its whole timeline, from detection to the most recent step. Each step shows what kind it is, when it was scheduled, when it ran, and what came back: an email step shows the subject and the body that was sent, and a retry step shows what Stripe answered.",
        { kind: "widget", name: "payment-timeline" },
        "Opens and clicks are recorded per email step, so you can see whether a message was read and whether the card-update link was followed. The click is the one that matters for billing.",
        { kind: "h3", text: "Manual actions on a payment" },
        {
          kind: "list",
          items: [
            [
              { strong: "Trigger next step now." },
              " Runs the next pending step immediately instead of waiting for its scheduled time.",
            ],
            [
              { strong: "Mark as recovered." },
              " Closes the payment and cancels the rest of the sequence. Use it when the customer paid some other way, which Foxhound has no way to see. A payment you mark recovered is never billed.",
            ],
            [
              { strong: "Stop recovery." },
              " Stops every future step for that payment. It does not touch the customer's subscription.",
            ],
            [
              { strong: "Resend last email." },
              " Sends the last email again and records it as its own step.",
            ],
            [
              { strong: "Note." },
              " A field for your own reference. It is never sent to the customer.",
            ],
          ],
        },
        {
          kind: "note",
          body: "Foxhound has no rewrite-the-pending-email control. Each email is written at send time from the customer, the decline and your brand voice, so there is no draft sitting there to edit.",
        },
        { kind: "h3", text: "Bulk actions" },
        `Select rows with the checkboxes and a bar appears at the bottom of the screen. Trigger the next step, mark recovered, or stop recovery for every selected payment at once. Above ${BULK_ACTION_CONFIRM_THRESHOLD} payments Foxhound asks you to confirm, and one submission carries at most ${BULK_ACTION_MAX_PER_SUBMISSION}. Each payment is reported on its own, and any that did not go through stay selected.`,
        {
          kind: "note",
          body: "There is no undo. Stop recovery ends the remaining steps for every selected payment.",
        },
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
        {
          kind: "p",
          body: [
            { strong: "Why so few retries for expired cards, and none for fraud?" },
            ` A retry on an expired card fails every time until the card is updated, and the card networks do not allow retrying the same card number and expiry. So an expired card gets one retry, on day ${EXPIRED_RETRY_DAY}, and it charges only if the card has changed since the decline: Stripe's card updater gave it a new expiry, or the customer added a card on the card-update page. Otherwise the step is skipped. Retrying a blocked card can draw further flags with the issuer, so fraud gets no retry. In both cases the main path to recovery is the customer acting, which is what the emails are for, and a revoked mandate gets a single email for the same reason. An unknown decline gets no retry at all. Emails only, failing closed: no silent retry against a code that has not been classified.`,
          ],
        },
        {
          kind: "p",
          body: [
            {
              strong: `Why does network get an early retry at ${NETWORK_FIRST.offsetHours} hours?`,
            },
            " Network errors are usually passing: a processor hiccup or a bank briefly unavailable. Most clear within a few hours on their own, and the early retry catches those before any email is needed.",
          ],
        },
        { kind: "h3", text: "Reading the sequence performance page" },
        {
          kind: "p",
          body: [
            "The page at ",
            { link: "/recovery/sequence", to: "/recovery/sequence" },
            " reads across your whole recovery history by category. For each step it shows how many went out, the open rate, the click rate and the most recent subject line used. A retry step shows how often the retry worked instead.",
          ],
        },
        { kind: "h3", text: "How recovery emails are written" },
        "Every email is written at send time. The AI is given the customer's first name, the plan, the amount, how long they have been a customer, the decline category, where the message sits in the sequence, your brand voice, and your merchant context when you have set it.",
        "What comes back is checked before it goes anywhere: an email carrying hollow phrasing, hedging, or anything that reads like a billing system wrote it is rejected and the template goes instead. Delivery is never held up by the AI layer.",
        {
          kind: "tip",
          body: "Send test email under Settings and Email delivers a real one to your own address through the same sending path, so you can read what a customer would get before anything fails.",
        },
      ],
    },
    {
      heading: "Understanding your dashboard",
      body: [
        { kind: "h3", text: "Stat cards" },
        "Nine stat cards sit on the recovery dashboard: three across the top and six further down, under the recovery queue. They read the last 30 days whatever range is selected.",
        {
          kind: "table",
          label: "Dashboard stat cards",
          columns: ["Card", "What it shows"],
          rows: [
            ["Recovered (30d)", "What came back in the last 30 days."],
            [
              "Currently at risk",
              "The total across every payment still in an active sequence, with its share of your MRR when Foxhound has an MRR figure.",
            ],
            [
              "Recovery rate",
              "The share of failed payments that came back, colored by band: below target at 20% or less, near target from 21% to 35%, above target from 36%.",
            ],
            ["Active sequences", "How many payments are being worked right now."],
            ["Win-backs active", "How many canceled customers are in a win-back sequence."],
            ["Cards expiring", "Cards inside the alert window."],
            ["Avg days to recovery", "How long a recovery takes, on average."],
            ["Best category", "Which decline category is recovering best for you."],
            [
              "Emails sent",
              "Recovery emails sent in the last 30 days, with their open and click rates.",
            ],
          ],
        },
        { kind: "h3", text: "Date range filter" },
        `The ${listText(RECOVERY_RANGES)} buttons in the dashboard header change the window the trend charts, the decline breakdown, the win-back panel and the payments preview read from. The recovery timing chart stays on the last 30 days, as the stat cards do. The range starts at 30 days.`,
        "The recovery queue always shows the steps due in the next 48 hours, whatever the range.",
        "The email deliverability panel, under the stat cards, follows the range: the share of the emails Foxhound sent that bounced or were reported as spam. Foxhound records each bounce and spam report against the account that sent the email, and when there are none in the range the panel says so. It shows no delivered rate, because Foxhound does not record delivery.",
        { kind: "h3", text: "ROI widget" },
        `The Foxhound-attributed revenue panel shows what Foxhound recovered this month and over all time, counting only recoveries where a Foxhound action provably preceded payment, with the ${RECOVERY_FEE_PERCENT}% fee on each and what you keep. This month counts every such recovery since the 1st, with the fee it will carry once it has held for ${RECOVERY_MATURITY_DAYS} days; all time counts the ones that have held for ${RECOVERY_MATURITY_DAYS} days, which are the ones Foxhound bills.`,
        "A recovery is billable only when a Foxhound action provably preceded payment: a scheduled retry succeeded, a dunning email was clicked or otherwise engaged (not just opened), or a card was updated through a Foxhound page. Everything else is Stripe's own baseline recovery, recorded and shown to you, never billed.",
        `A click only counts if it came within ${EMAIL_ENGAGEMENT_WINDOW_DAYS} days before the payment came back. A customer who clicks and then pays two months later was not brought back by that email, so the recovery records as Stripe's own baseline and is free.`,
        {
          kind: "note",
          body: `Some clicks are not people. A click that arrives within ${CLICK_SUSPECT_MIN_SECONDS} seconds of the email being sent, or on a link no human can see, is marked suspect: corporate mail scanners follow every link in a message before it reaches the inbox. A suspect click is shown on the ledger with its reason and is never billed.`,
        },
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
        {
          kind: "list",
          items: [
            [
              { strong: "Is the Stripe account still connected?" },
              " Settings and Stripe connections lists every live connection on this account.",
            ],
            [
              { strong: "Has Stripe finished its own retries?" },
              " The payment appears as soon as it fails, marked as Stripe's to retry. Foxhound's sequence starts when Stripe stops.",
            ],
            [
              { strong: "Is the payment on the account you are looking at?" },
              " If you hold more than one, check the account switcher in the header.",
            ],
            [
              { strong: "Is Stripe still reaching Foxhound?" },
              " The webhook health badge on the dashboard says so.",
            ],
          ],
        },
        { kind: "h3", text: "Emails are not sending" },
        {
          kind: "list",
          items: [
            [
              { strong: "Is the address suppressed?" },
              " A customer who unsubscribed, hard bounced, or reported an email as spam is suppressed, and Foxhound will not send to them again.",
            ],
            [
              { strong: "Is the step actually due?" },
              " The timeline on the payment page shows when each step is scheduled.",
            ],
          ],
        },
        {
          kind: "note",
          body: "Suppression is per address and it holds. It exists so a customer who asked to stop hearing from you is not mailed again by a later sequence.",
        },
        { kind: "h3", text: "Recovery rate seems low" },
        {
          kind: "list",
          items: [
            [
              { strong: "How many closed payments are behind it?" },
              " A rate over a handful of payments moves on every one of them. Give it a billing cycle.",
            ],
            [
              { strong: "What is the decline mix?" },
              " Fraud and revoked recover less by nature. The decline breakdown on the dashboard shows yours.",
            ],
            [
              { strong: "Are the emails being opened?" },
              " Low open rates on the sequence page point at deliverability rather than at the copy.",
            ],
            [
              { strong: "Is the brand voice set?" },
              " Copy written without one is more generic than copy written with one.",
            ],
          ],
        },
        { kind: "h3", text: "A customer says they did not receive an email" },
        {
          kind: "list",
          items: [
            "Check the timeline on the payment page and confirm the step ran rather than sitting pending.",
            "Check whether the address is suppressed.",
            "Ask them to look in spam.",
            "Use Resend last email on the payment page to send it again.",
          ],
        },
        { kind: "h3", text: "Contact support" },
        {
          kind: "p",
          body: [
            "If none of this explains it, email ",
            { link: SUPPORT_EMAIL, to: `mailto:${SUPPORT_EMAIL}` },
            " from the address you sign in with, and include the Stripe invoice ID (",
            { code: "in_" },
            ") or payment ID (",
            { code: "pi_" },
            ") of the payment in question, so it can be found without a second round of email.",
          ],
        },
      ],
    },
  ],
};
