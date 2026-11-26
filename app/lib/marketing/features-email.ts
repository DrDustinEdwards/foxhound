import {
  SEND_MAX_ATTEMPTS,
  SEND_RETRY_BACKOFF_MINUTES,
  WINBACK_UNFLAGGED_STEP1_HOURS,
} from "~/lib/constants";
import { DECLINE_CATEGORY_COUNT_WORD } from "~/lib/marketing/decline-categories";
import { WIN_BACK_SCHEDULE } from "~/lib/recovery/schedule";
import { plural } from "@drdustinedwards/site-helpers/text";
import { listText } from "capsomer/behavior/hooks";
import type { FeatureCadence } from "~/lib/marketing/features-cadence";
import type { FeatureSection } from "~/lib/marketing/features-content";
import { minutesText } from "~/lib/marketing/features-cadence";

function hoursText(hours: number): string {
  return hours >= 24 && hours % 24 === 0 ? plural(hours / 24, "day") : plural(hours, "hour");
}

export function emailSection({ digestDay }: FeatureCadence): FeatureSection {
  const [winStep1, winStep2, winStep3] = WIN_BACK_SCHEDULE.map((s) => s.offsetHours);
  const backoff = listText(SEND_RETRY_BACKOFF_MINUTES.map(minutesText));

  return {
    id: "email",
    label: "Email and communication",
    title: "Email and communication",
    intro: "How Foxhound communicates with your customers, and how you control what it says.",
    features: [
      {
        name: "Per-category email sequences",
        description: `${DECLINE_CATEGORY_COUNT_WORD} decline categories each receive their own sequence. Timing and retry strategy differ by decline type, and a silent retry comes before any email where a retry can work.`,
        product: "Recovery",
      },
      {
        name: "AI-written subject lines",
        description:
          "Each email gets an AI-generated subject line, written with its body for the decline category.",
        product: "Recovery",
      },
      {
        name: "Brand voice configuration",
        description:
          "Set the tone for recovery emails globally, or separately for soft, expired, network, and fraud declines. Stored in Settings, Brand voice.",
        product: "Recovery",
      },
      {
        name: "Merchant context",
        description:
          "Add your industry, customer type, and MRR in Settings. Foxhound uses them in recovery email copy.",
        product: "Recovery",
      },
      {
        name: "Fallback templates",
        description:
          "If AI generation fails, a template email sends instead. Sequences never stall on an AI failure.",
        product: "Recovery",
      },
      {
        name: "Open and click tracking",
        description:
          "Every sent email tracks opens and clicks through Foxhound's own tracking routes. Clicks that look like a mail scanner are marked suspect.",
        product: "Recovery",
      },
      {
        name: "Email suppression",
        description:
          "The suppression list is checked before every send. Bounced, complained, or unsubscribed addresses never receive a recovery email.",
        product: "Recovery",
      },
      {
        name: "Send retry with backoff",
        description: `Up to ${SEND_MAX_ATTEMPTS} send attempts, backing off ${backoff} between them. A send that still fails is marked Email failed on the payment and Foxhound is alerted, so sequences do not silently stop.`,
        product: "Recovery",
      },
      {
        name: "Win-back email sequences",
        description: `Three-step post-cancellation sequence (step 1 at ${hoursText(winStep1)}, or ${hoursText(WINBACK_UNFLAGGED_STEP1_HOURS)} on an account with Intelligence unless the customer is flagged as a win-back priority; step 2 at ${hoursText(winStep2)}, step 3 at ${hoursText(winStep3)}).`,
        product: "Recovery",
      },
      {
        name: "Expiring card email",
        description:
          "Templated email with a link to Foxhound's card-update page. A unique constraint prevents duplicate alerts for the same card and month.",
        product: "Recovery",
      },
      {
        name: "Weekly unified digest",
        description: `${digestDay} morning email: recovery stats, open disputes, and Intelligence high-risk customers. One email, all products.`,
        product: "Platform",
      },
      {
        // REMINDER_BANDS in app/lib/disputes/notices.ts.
        name: "Dispute deadline reminders",
        description: "Reminder emails at 3 days and 1 day before the dispute evidence deadline.",
        product: "Disputes",
      },
      {
        name: "List-Unsubscribe headers",
        description:
          "Customer emails include RFC 8058 one-click List-Unsubscribe headers for CAN-SPAM compliance.",
        product: "Platform",
      },
      {
        name: "Signed unsubscribe tokens",
        description:
          "Unsubscribe links use signed tokens. Clicking adds the address to the suppression list immediately.",
        product: "Platform",
      },
    ],
  };
}
