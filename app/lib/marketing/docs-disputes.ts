import { formatMoneyShort } from "@dustinedwards/site-runtime/money";
import { DISPUTE_FEE_PERCENT } from "~/lib/billing/page";
import { DISPUTE_FEE_CAP_CENTS } from "~/lib/constants";
import { EVIDENCE_FILES_LIMITS_LINE } from "~/lib/disputes/evidence-files";
import { DEADLINE_SOON_DAYS, DEADLINE_URGENT_DAYS } from "~/lib/disputes/labels";
import type { DocGuide } from "~/lib/marketing/docs-content";

export const DISPUTES_GUIDE: Omit<DocGuide, "datePublished"> = {
  slug: "disputes",
  title: "Disputes",
  description: "Evidence drafted for you. You approve every submission, or turn on auto-submit.",
  heading: "Disputes",
  sections: [
    {
      heading: "How Disputes works",
      body: [
        { kind: "h3", text: "How Foxhound handles disputes" },
        "When a dispute opens on your connected Stripe account, Foxhound receives the webhook within seconds and begins building evidence. For each dispute it pulls the customer's prior charge history, the AVS and CVV results, the Stripe Radar score and 3D Secure result of the disputed charge, the customer's subscription, and, when the charge is a payment Foxhound recovered, the recovery sequence that payment went through: each step that ran, with when an email was opened and clicked.",
        "Foxhound then scores the dispute with a triage recommendation, fight or accept, and a confidence percentage. The evidence is staged as a draft and the dispute waits in Pending review for a person on your team. You review it, add what only you know, and approve it, and Foxhound submits it to Stripe.",
        { kind: "widget", name: "dispute-states" },
        {
          kind: "note",
          body: "Foxhound hears about disputes by webhook. If a dispute opened before you connected Foxhound, use Sync dispute from Stripe on your disputes dashboard to bring it in.",
        },
        {
          kind: "note",
          body: "The approval step is enforced by the database, not by a setting. There is no state that reaches Stripe without passing through an approval, and no way to configure one.",
        },
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
        {
          kind: "list",
          items: [
            [
              { code: "fraudulent" },
              ": the strongest case for fighting when the customer has paid before and the card checks passed.",
            ],
            [
              { code: "subscription_canceled" },
              ": cancellation evidence and email history matter most.",
            ],
            [
              { code: "unrecognized" },
              ": the customer does not recognize the charge. The Radar result and their charge history carry the case.",
            ],
          ],
        },
      ],
    },
    {
      heading: "Evidence building",
      body: [
        { kind: "h3", text: "What Foxhound includes" },
        "Foxhound stages these fields automatically, each read from Stripe or from Foxhound's own records:",
        {
          kind: "steps",
          items: [
            [
              { strong: "Customer details." },
              " The name, email, billing address and purchase IP on the disputed charge.",
            ],
            [
              { strong: "Product description." },
              " Your description from Dispute settings, or the plan the customer was on.",
            ],
            [
              { strong: "Service date." },
              " When the subscription started, or when the failed payment was detected if the start is not known.",
            ],
            [
              { strong: "Subscription." },
              " The customer's subscription, when it started and whether it was canceled.",
            ],
            [
              { strong: "Customer communication." },
              " When the charge is a payment Foxhound recovered, the recovery sequence it went through, with when an email was opened and clicked.",
            ],
            [
              { strong: "Additional notes." },
              " A short summary written by the AI model and limited to the recovery facts above. When the model is not available, the field is left for you.",
            ],
          ],
        },
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
        "If auto-submit is on in Dispute settings, Foxhound submits the staged evidence automatically 24 hours before the deadline for any dispute nobody has submitted. No manual action needed. You can still review, edit and submit the evidence yourself at any point before auto-submit fires, and Foxhound emails you when it has submitted.",
        {
          kind: "note",
          body: "Every submission still carries a person's approval. Turning auto-submit on is that approval: Foxhound records who turned it on and when, and each automatic submission names them.",
        },
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
        { kind: "h3", text: "Auto-submit" },
        "Submits the staged evidence automatically 24 hours before the deadline for every dispute nobody has submitted (Part 4). Off by default.",
      ],
    },
    {
      heading: "Billing",
      body: [
        `${DISPUTE_FEE_PERCENT}% of disputes Foxhound wins, capped at ${formatMoneyShort(DISPUTE_FEE_CAP_CENTS, "usd")} per dispute. Nothing on disputes you lose or accept.`,
        "Nothing is charged on a dispute you lose, a dispute you accept, or a dispute you handled yourself outside Foxhound. The Fees owed card on the disputes dashboard shows what is still owed.",
      ],
    },
  ],
};
