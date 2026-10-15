import {
  AUDIT_LOOKBACK_DAYS,
  ALERT_METRICS,
  CRON_SCHEDULE_DAILY,
  CRON_SCHEDULE_MONTHLY,
  CRON_SCHEDULE_MONTHLY_AUDIT,
  CRON_SCHEDULE_RECOVERY_TICK,
  CRON_SCHEDULE_WEEKLY,
  EXPIRING_CARD_DAYS_AHEAD,
  HEALTH_SCORE_AT_RISK_THRESHOLD,
  RECOVERY_FEE_BPS,
  RECOVERY_MATURITY_DAYS,
  SEND_MAX_ATTEMPTS,
  SEND_RETRY_BACKOFF_MINUTES,
  WINBACK_UNFLAGGED_STEP1_HOURS,
} from "~/lib/constants";
import { recoveryRateTone } from "~/lib/dashboard/recovery-rate";
import { RECOVERY_RANGES } from "~/lib/dashboard/recovery-window";
import { DEMO_ACCOUNT_NAME } from "~/lib/demo/constants";
import { WATCH_CEILING } from "~/lib/intelligence/health-band";
import {
  DECLINE_CATEGORY_COUNT_WORD,
  DECLINE_CATEGORY_COUNT_WORD_LOWER,
  DECLINE_CATEGORY_PHRASE,
} from "~/lib/marketing/decline-categories";
import { WIN_BACK_SCHEDULE } from "~/lib/recovery/schedule";
import { LOOKBACK_OPTIONS } from "~/lib/settings/audit-settings";

// /features content (J60, row M10). Recova's spec is
// app/(marketing)/features/features-data.ts (blob a0a5dd20), read whole.
//
// RECOVA'S SECTIONS, IN RECOVA'S ORDER, WITH RECOVA'S IDS, AND RECOVA'S ENTRIES
// IN RECOVA'S ORDER. Each Recova entry is kept where Foxhound ships it and the
// words are true, rewritten to Foxhound's own fact where it ships the thing
// differently, and left out where Foxhound has not built it (RULES.md 2.7).
// test/fixtures/recova-features.ts lists all 129 Recova entries with what
// happened to each, and test/features-j60.test.ts checks that every entry
// rendered here names code that exists.
//
// EVERY NUMBER IS READ FROM THE ENGINE, never typed (RULES.md 2.1): cadences
// from the cron schedule constants, the fee and maturity from the pricing
// constants, the bands from the functions that colour them. Two counts live
// only on the server (the cron registry and the MCP tool list); the route's
// loader reads them and passes them in as FeatureFacts.

export const FEATURE_PRODUCTS = ["Platform", "Audit", "Recovery", "Disputes", "Intelligence"] as const;
export type FeatureProduct = (typeof FEATURE_PRODUCTS)[number];

/** Recova's FeatureFilter order: All first, then the five products. */
export const FEATURE_FILTERS = ["All", ...FEATURE_PRODUCTS] as const;
export type FeatureFilterValue = (typeof FEATURE_FILTERS)[number];

export interface Feature {
  name: string;
  description: string;
  product: FeatureProduct;
}

export interface FeatureSection {
  id: string;
  label: string;
  title: string;
  intro: string;
  features: Feature[];
}

/** Counts that only the server can read (the cron registry and the merchant
 *  MCP tool list are server modules). */
export interface FeatureFacts {
  cronJobCount: number;
  merchantMcpToolCount: number;
}

/** Recova's header subtext, with Foxhound's name. */
export const FEATURES_SUBTEXT =
  "Everything Foxhound does. Organized by capability, tagged by product. Built to stay current as the platform grows.";

/** Recova's meta description without its "129 features" count (parity/M10-FEATURES.md). */
export const FEATURES_META_DESCRIPTION =
  "Features across automation, intelligence, email, visibility, control, integration, and security. Built for Stripe subscription businesses.";

// ---- Reading the engine's numbers as words ----

/** "every 5 minutes" from a "*\/N * * * *" schedule. */
export function cronEveryMinutes(expr: string): number {
  const m = /^\*\/(\d+) \* \* \* \*$/.exec(expr);
  if (!m) throw new Error(`not an every-N-minutes schedule: ${expr}`);
  return Number(m[1]);
}

/** True for a once-a-day "M H * * *" schedule. */
export function cronIsDaily(expr: string): boolean {
  return /^\d+ \d+ \* \* \*$/.test(expr);
}

/** The cadence word for a schedule: "nightly" for a daily run (Foxhound's
 *  daily jobs run at night, UTC), "weekly", "monthly", or "every N minutes". */
export function cronCadence(expr: string): string {
  if (/^\*\/\d+ \* \* \* \*$/.test(expr)) return `every ${cronEveryMinutes(expr)} minutes`;
  if (cronIsDaily(expr)) return "nightly";
  if (/^\d+ \d+ \* \* \d$/.test(expr)) return "weekly";
  if (/^\d+ \d+ \d+ \* \*$/.test(expr)) return "monthly";
  throw new Error(`no cadence word for schedule: ${expr}`);
}

/** When in its period a schedule runs: "the 1st of each month" for a monthly
 *  run, "each Tuesday" for a weekly one, "each night" for a daily one. */
export function cronWhen(expr: string): string {
  const cadence = cronCadence(expr);
  if (cadence === "monthly") return `the ${ordinal(cronMonthDay(expr))} of each month`;
  if (cadence === "weekly") return `each ${cronWeekday(expr)}`;
  if (cadence === "nightly") return "each night";
  return cadence;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** The day of the month of a monthly "M H D * *" schedule. */
export function cronMonthDay(expr: string): number {
  const m = /^\d+ \d+ (\d+) \* \*$/.exec(expr);
  if (!m) throw new Error(`not a monthly schedule: ${expr}`);
  return Number(m[1]);
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The weekday of a weekly "M H * * D" schedule. */
export function cronWeekday(expr: string): string {
  const m = /^\d+ \d+ \* \* (\d)$/.exec(expr);
  if (!m) throw new Error(`not a weekly schedule: ${expr}`);
  return WEEKDAYS[Number(m[1]) % 7];
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** 15 -> "15 minutes", 60 -> "1 hour", 720 -> "12 hours". */
function minutesText(minutes: number): string {
  return minutes % 60 === 0 ? plural(minutes / 60, "hour") : plural(minutes, "minute");
}

/** 1 -> "1 hour", 96 -> "4 days". */
function hoursText(hours: number): string {
  return hours >= 24 && hours % 24 === 0 ? plural(hours / 24, "day") : plural(hours, "hour");
}

function listText(items: readonly string[], last = "or"): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${last} ${items[items.length - 1]}`;
}

/** The recovery-rate bands, found by asking recoveryRateTone itself. */
function recoveryRateBands(): { redMax: number; cautionMax: number } {
  let redMax = -1;
  let cautionMax = -1;
  for (let pct = 0; pct <= 100; pct++) {
    const tone = recoveryRateTone(pct);
    if (tone === "red") redMax = pct;
    if (tone === "caution") cautionMax = pct;
  }
  return { redMax, cautionMax };
}

/** The three example scores beside the health-band sentence, one per band.
 *  Recova shows 20, 50 and 82; each is kept while it lands in its band under
 *  Foxhound's thresholds, and becomes the band's midpoint if a threshold moves
 *  past it, so a badge never shows a score in the wrong band. */
export function healthBandExampleScores(): [number, number, number] {
  const bands: [number, number, number][] = [
    [20, 0, HEALTH_SCORE_AT_RISK_THRESHOLD - 1],
    [50, HEALTH_SCORE_AT_RISK_THRESHOLD, WATCH_CEILING - 1],
    [82, WATCH_CEILING, 100],
  ];
  const [a, b, c] = bands.map(([recova, lo, hi]) =>
    recova >= lo && recova <= hi ? recova : Math.floor((lo + hi) / 2),
  );
  return [a, b, c];
}

/** Foxhound's health bands, as the intelligence section's example states them. */
export function healthBandSentence(): string {
  return `red below ${HEALTH_SCORE_AT_RISK_THRESHOLD}, orange ${HEALTH_SCORE_AT_RISK_THRESHOLD}-${WATCH_CEILING - 1}, green at or above ${WATCH_CEILING}.`;
}

// ---- The sections ----

export function featureSections(facts: FeatureFacts): FeatureSection[] {
  const tick = cronEveryMinutes(CRON_SCHEDULE_RECOVERY_TICK);
  const billingWhen = cronWhen(CRON_SCHEDULE_MONTHLY);
  const auditWhen = cronWhen(CRON_SCHEDULE_MONTHLY_AUDIT);
  const digestDay = cronWeekday(CRON_SCHEDULE_WEEKLY);
  // Each cadence word is read from the schedule its job runs on (the cron
  // registry pairs job and schedule; test/features-j60.test.ts checks it).
  const nightly = cronCadence(CRON_SCHEDULE_DAILY);
  const Nightly = capitalize(nightly);
  const daily = cronIsDaily(CRON_SCHEDULE_DAILY) ? "daily" : cronCadence(CRON_SCHEDULE_DAILY);
  const monthly = cronCadence(CRON_SCHEDULE_MONTHLY);
  const Monthly = capitalize(monthly);
  const auditCadence = cronCadence(CRON_SCHEDULE_MONTHLY_AUDIT);
  const fee = `${RECOVERY_FEE_BPS / 100}%`;
  const { redMax, cautionMax } = recoveryRateBands();
  const [winStep1, winStep2, winStep3] = WIN_BACK_SCHEDULE.map((s) => s.offsetHours);
  const backoff = listText(SEND_RETRY_BACKOFF_MINUTES.map(minutesText), "and");
  const lookbacks = listText(LOOKBACK_OPTIONS.map(String));
  const ranges = RECOVERY_RANGES.join(" / ");

  return [
    {
      id: "automation",
      label: "Automation",
      title: "Automation",
      intro:
        "Everything that runs without you doing anything. Foxhound processes failed payments, sends emails, retries charges, drafts dispute evidence, and alerts you. All on schedule, all automatically.",
      features: [
        {
          name: `Recovery processing every ${tick} minutes`,
          description: `Picks due recovery steps and executes them every ${tick} minutes.`,
          product: "Recovery",
        },
        {
          name: `Win-back processing every ${tick} minutes`,
          description: `Executes win-back email steps on schedule, checked every ${tick} minutes.`,
          product: "Recovery",
        },
        {
          name: `${Nightly} expiring card alerts`,
          description: `${Nightly}, finds every card expiring within ${EXPIRING_CARD_DAYS_AHEAD} days and emails the customer a link to Foxhound's card-update page.`,
          product: "Recovery",
        },
        {
          name: `${Nightly} intelligence scoring`,
          description: `Computes health scores, predictions, and alerts for every customer ${nightly}.`,
          product: "Intelligence",
        },
        {
          name: `${Monthly} MRR snapshots`,
          description: `Pulls subscription data from Stripe and computes MRR, NRR, GRR, and the movement waterfall. Updated ${monthly}, on ${billingWhen}.`,
          product: "Intelligence",
        },
        {
          name: `${Monthly} recovery billing`,
          description: `Invoices ${fee} of matured Foxhound-attributed recoveries (held ${RECOVERY_MATURITY_DAYS} days or more) on ${billingWhen}. Recoveries Stripe would have made anyway are never billed.`,
          product: "Platform",
        },
        {
          name: `${capitalize(auditCadence)} audit auto-run`,
          description: `Re-runs your Stripe diagnostic on ${auditWhen} and emails you the results. Toggle on in Settings.`,
          product: "Audit",
        },
        {
          name: `${digestDay} unified digest`,
          description: "Weekly email covering recovery stats, open disputes, and Intelligence high-risk customers.",
          product: "Platform",
        },
        {
          name: `${Nightly} demo reset`,
          description: `Rebuilds the demo account's data ${nightly}. The demo never touches live Stripe.`,
          product: "Platform",
        },
        {
          name: "Cron overlap prevention",
          description: "A Durable Object lock per cron. Overlapping runs are blocked, not queued.",
          product: "Platform",
        },
        {
          name: "Stale cron alerting",
          description: `A ${daily} check finds any cron that has not run within its expected window, or has never run, and sends an operator alert.`,
          product: "Platform",
        },
      ],
    },
    {
      id: "intelligence",
      label: "Intelligence",
      title: "Intelligence",
      intro:
        "What Foxhound figures out on its own: about your customers, your payments, and how to handle both.",
      features: [
        {
          name: "Decline classification",
          description: `Maps every Stripe decline code to one of ${DECLINE_CATEGORY_COUNT_WORD_LOWER} categories: ${DECLINE_CATEGORY_PHRASE}. Different category, different sequence.`,
          product: "Recovery",
        },
        {
          name: "Fraud decline detection",
          description: "Fraud-category declines are never retried. The customer gets emails only.",
          product: "Recovery",
        },
        {
          name: "Customer health scoring",
          description:
            "0-100 score per customer from payment timing, billing changes, refunds and disputes, engagement with recovery emails, and tenure.",
          product: "Intelligence",
        },
        {
          name: "AI recovery email generation",
          description:
            "Claude writes each email in your brand voice. Dashes and filler phrases are stripped, and a quality check holds back any copy that reveals the schedule.",
          product: "Recovery",
        },
        {
          name: "AI audit summary",
          description: "A plain-English diagnostic summary at the top of every audit result.",
          product: "Audit",
        },
        {
          name: `AI ${nightly} analyst`,
          description: `Claude writes a plain-English narrative of the account's at-risk customers ${nightly}, from their real scores. It phrases the numbers, never invents one.`,
          product: "Intelligence",
        },
        {
          name: "Cross-product dispute signal",
          description:
            "Each customer's disputes, won and lost, are counted into their Intelligence record, and disputes count against the health score.",
          product: "Disputes",
        },
        {
          name: "Card Account Updater advisory",
          description:
            "The audit counts the cards Stripe's Card Account Updater refreshed beside the expired-card declines in the same window, so you can see whether it is working.",
          product: "Audit",
        },
        {
          name: "Renewal noise filtering",
          description:
            "A first failed payment waits while Stripe's own retries run. Foxhound's sequence starts when Stripe gives up, so Stripe's retry events never start a duplicate sequence.",
          product: "Recovery",
        },
      ],
    },
    {
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
          description: "Each email gets an AI-generated subject line, written with its body for the decline category.",
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
          description: "Add your industry, customer type, and MRR in Settings. Foxhound uses them in recovery email copy.",
          product: "Recovery",
        },
        {
          name: "Fallback templates",
          description: "If AI generation fails, a template email sends instead. Sequences never stall on an AI failure.",
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
          description: `Up to ${SEND_MAX_ATTEMPTS} send attempts, backing off ${backoff} between them. A send that still fails is dead-lettered and alerted, so sequences do not silently stop.`,
          product: "Recovery",
        },
        {
          name: "Win-back email sequences",
          description: `Three-step post-cancellation sequence (step 1 at ${hoursText(winStep1)} or ${hoursText(WINBACK_UNFLAGGED_STEP1_HOURS)}, step 2 at ${hoursText(winStep2)}, step 3 at ${hoursText(winStep3)}).`,
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
          name: "List-Unsubscribe headers",
          description: "Customer emails include RFC 8058 one-click List-Unsubscribe headers for CAN-SPAM compliance.",
          product: "Platform",
        },
        {
          name: "Signed unsubscribe tokens",
          description: "Unsubscribe links use signed tokens. Clicking adds the address to the suppression list immediately.",
          product: "Platform",
        },
      ],
    },
    {
      id: "visibility",
      label: "Visibility",
      title: "Visibility",
      intro: "Everything you can see: across your payments, sequences, customers, disputes, and platform health.",
      features: [
        {
          name: "Recovery dashboard",
          description: `Stat cards, ROI widget, charts, and the recovery queue. Range: ${ranges}.`,
          product: "Recovery",
        },
        {
          name: "Recovery rate chart",
          description: `Daily recovery rate over the chosen range, beside the rate itself coloured by band: green above ${cautionMax}%, caution ${redMax + 1}-${cautionMax}%, red at or below ${redMax}%.`,
          product: "Recovery",
        },
        {
          name: "Recovery timing chart",
          description: "Bar chart of when recoveries happen, by days since the payment failed.",
          product: "Recovery",
        },
        {
          name: "Email category chart",
          description: "Open rate and click rate per decline category. Shows which category your customers respond to most.",
          product: "Recovery",
        },
        {
          name: "Decline breakdown",
          description: "Category distribution with per-category recovery rate and sparklines.",
          product: "Recovery",
        },
        {
          name: "Payment detail timeline",
          description: "Every step in a payment's sequence: scheduled, sent, pending. Exact timestamps, results, and email preview.",
          product: "Recovery",
        },
        {
          name: "Email preview in timeline",
          description: "The rendered email body is visible on every sent email step.",
          product: "Recovery",
        },
        {
          name: "Sequence performance page",
          description: "Open, click, and recovery rate per sequence step, across all sequences.",
          product: "Recovery",
        },
        {
          name: "Disputes dashboard",
          description: "Disputes needing action, the amount at stake, historical win rate, and fees owed.",
          product: "Disputes",
        },
        {
          name: "Dispute evidence staging",
          description:
            "The full evidence draft before submission, grounded in the charge's recovery history and the emails the customer received.",
          product: "Disputes",
        },
        {
          name: "Intelligence dashboard",
          description: `MRR, NRR trend, MRR movement chart, health score distribution, and the ${nightly} AI narrative.`,
          product: "Intelligence",
        },
        {
          name: "Customer health index",
          description: "All customers sorted by health score ascending, or by MRR. Worst-health customers surface first.",
          product: "Intelligence",
        },
        {
          name: "Customer detail page",
          description: "Health score with its factors, score history sparkline, predictions, and MRR contribution.",
          product: "Intelligence",
        },
        {
          name: "Churn risk page",
          description: "MRR at risk by health band, the churn rate trend chart, and the high-risk customer table sorted by MRR.",
          product: "Intelligence",
        },
        {
          name: "MRR movement waterfall",
          description: "New, expansion, reactivation vs contraction, churn. Month by month.",
          product: "Intelligence",
        },
        {
          name: "Audit results page",
          description: "Failed invoices, expiring cards, open disputes, and business health. AI summary at top.",
          product: "Audit",
        },
        {
          name: "Audit history",
          description: "Signed-in accounts see every past audit run at /audit/history.",
          product: "Audit",
        },
        {
          name: "Platform status in Help",
          description: "Live cron health (last run and status) visible at /help.",
          product: "Platform",
        },
        {
          name: "Admin webhook log",
          description: "Recent webhook deliveries with their status and errors, and 24-hour received and error counts.",
          product: "Platform",
        },
        {
          name: "Admin audit log",
          description: "Recent admin actions with actor, action, and metadata.",
          product: "Platform",
        },
        {
          name: "Cron health table",
          description: `All ${facts.cronJobCount} crons with last-run status in /admin/crons.`,
          product: "Platform",
        },
      ],
    },
    {
      id: "control",
      label: "Control",
      title: "Control",
      intro:
        "What you can configure, override, or stop. Foxhound runs automatically. You have explicit control over everything it does.",
      features: [
        {
          name: "Stop recovery",
          description:
            "Stop a payment's recovery permanently from the payment detail page. No further steps will run, and the subscription is never touched.",
          product: "Recovery",
        },
        {
          name: "Run the next step now",
          description: "Run the next scheduled step for any payment in an active sequence, without waiting for its time.",
          product: "Recovery",
        },
        {
          name: "Resend email step",
          description: "Resend the last email sent for a payment. The suppression list is checked first.",
          product: "Recovery",
        },
        {
          name: "Manual payment recovery",
          description: "Mark a payment recovered by hand from the payment detail page. Manual recoveries are never billed.",
          product: "Recovery",
        },
        {
          name: "Payment notes",
          description: "Add an internal note to any payment.",
          product: "Recovery",
        },
        {
          name: "Submit dispute evidence",
          description:
            "Review the drafted evidence, edit any field, and approve its submission to Stripe. The fee is stated on the button.",
          product: "Disputes",
        },
        {
          name: "Audit lookback days",
          description: `Choose the lookback window (${lookbacks} days, default ${AUDIT_LOOKBACK_DAYS}) for your Stripe diagnostic.`,
          product: "Audit",
        },
        {
          name: "Audit auto-run toggle",
          description: `Enable the ${auditCadence} audit in Settings. It runs on ${auditWhen} and emails you the results.`,
          product: "Audit",
        },
        {
          name: "Processing pause",
          description: "A per-account pause that stops recovery and dispute processing immediately.",
          product: "Platform",
        },
        {
          name: "Alert thresholds",
          description: `Configure alerts on ${ALERT_METRICS.length} Intelligence metrics with your own thresholds and directions. Each breach is recorded and shown in Settings.`,
          product: "Platform",
        },
        {
          name: "Email settings",
          description: "Sender name per Stripe connection, and a test email to your own address.",
          product: "Platform",
        },
        {
          name: "Brand voice",
          description: "Per-decline-category tone configuration. Influences AI email generation.",
          product: "Recovery",
        },
        {
          name: "Merchant context",
          description: "Industry, customer type, and MRR. Used in recovery email copy.",
          product: "Recovery",
        },
        {
          name: "Theme toggle",
          description: "Dark/light mode toggle. Saved to your account when signed in, a cookie otherwise.",
          product: "Platform",
        },
        {
          name: "Team seats",
          description: "Invite teammates by email from Settings, Team.",
          product: "Platform",
        },
      ],
    },
    {
      id: "integration",
      label: "Integration",
      title: "Integration",
      intro:
        "How Foxhound connects to your existing stack. The free audit is read-only. Never changes your prices, products, or plans.",
      features: [
        {
          name: "Stripe Connect OAuth",
          description:
            "OAuth connection to your Stripe account, read and write, asked for once at /connect. The free audit connects read-only.",
          product: "Platform",
        },
        {
          name: "Multi-account support",
          description: "One person can belong to several accounts, each with its own Stripe connection. Switch between accounts from the header.",
          product: "Platform",
        },
        {
          name: "AES-256-GCM token encryption",
          description: "All Stripe access tokens encrypted at rest in the stripe_connections table.",
          product: "Platform",
        },
        {
          name: "Stripe webhook processing",
          description:
            "Handles invoice.payment_failed and succeeded, subscription cancellations, refunds, and charge.dispute events.",
          product: "Platform",
        },
        {
          name: "Cloudflare Email Service delivery",
          description:
            "All outbound email sent through Cloudflare Email Service, behind one send module. Bounce and complaint events arrive through a queue.",
          product: "Platform",
        },
        {
          name: "MCP Merchant connector",
          description: `An MCP endpoint at /mcp with ${facts.merchantMcpToolCount} tools across Recovery, Disputes, Intelligence, and Audit, authorised by an API key scoped to one account.`,
          product: "Platform",
        },
        {
          name: "MCP Admin connector",
          description:
            "Platform-wide admin access from Claude and other AI clients. A separate Worker at admin-mcp.foxhoundapp.com, signed in through Cloudflare Access.",
          product: "Platform",
        },
        {
          name: "OAuth 2.1 authorization server",
          description: "The admin connector is its own OAuth 2.1 authorization server. PKCE S256 only.",
          product: "Platform",
        },
        {
          name: "API keys",
          description: "SHA-256 hashed API keys, shown once and revocable. Manage from Settings, API keys.",
          product: "Platform",
        },
        {
          name: "Anthropic API",
          description:
            `Claude Sonnet writes recovery emails, dispute evidence, and the ${nightly} narrative. Claude Haiku writes audit summaries.`,
          product: "Platform",
        },
        {
          name: "Cloudflare D1",
          description: "The database, reached through Workers bindings. Every query is scoped to one account.",
          product: "Platform",
        },
        {
          name: "Cloudflare Workers",
          description: "One Worker serves the site, the app, the crons, and the email queue.",
          product: "Platform",
        },
        {
          name: "Durable Object rate limiting",
          description: "Rate limiting on sign-in, the audit, and the MCP endpoint.",
          product: "Platform",
        },
      ],
    },
    {
      id: "security",
      label: "Security and compliance",
      title: "Security and compliance",
      intro: "What protects you, your customers, and your Stripe data.",
      features: [
        {
          name: "Narrow Stripe scope",
          description:
            "Foxhound requests read and write Stripe Connect access, because retrying a failed invoice is a write. It writes for these things and no others: retrying an invoice that already failed, setting a customer default payment method after a card update, opening a Stripe checkout when a former customer chooses to resubscribe, and submitting dispute evidence you approved. It never changes your prices, products, or plans. The free audit is read-only.",
          product: "Platform",
        },
        {
          name: "Tenant isolation",
          description:
            "D1 has no row-level security, so every query helper takes the account as a required first argument. No query can reach another account's data.",
          product: "Platform",
        },
        {
          name: "AES-256-GCM encryption",
          description: "All Stripe access tokens encrypted at rest. Decrypted only in memory when used.",
          product: "Platform",
        },
        {
          name: "Stripe webhook verification",
          description:
            "All incoming Stripe webhooks verified with constructEventAsync signature verification. Stripe's default replay window enforced.",
          product: "Platform",
        },
        {
          name: "Scheduler-only crons",
          description: "Crons run only from Cloudflare's scheduler. No HTTP route can start one.",
          product: "Platform",
        },
        {
          name: "PKCE S256 enforced",
          description: "The admin connector's OAuth flow accepts only S256 code challenges. Plain is refused.",
          product: "Platform",
        },
        {
          name: "Admin double-gate",
          description:
            "Admin needs Cloudflare Access and an address on the admin list. The admin connector asks the admin API again on every call.",
          product: "Platform",
        },
        {
          name: "Rate limiting",
          description: "Durable Object rate limiting on the audit, sign-in, and the MCP endpoint.",
          product: "Platform",
        },
        {
          name: "CAN-SPAM compliance",
          description:
            "List-Unsubscribe headers, signed unsubscribe tokens, a suppression list, and a physical address in all commercial emails. A send without one is refused.",
          product: "Platform",
        },
        {
          name: "WCAG 2.2 compliance",
          description: "prefers-reduced-motion, prefers-contrast: more, and forced-colors all implemented.",
          product: "Platform",
        },
        {
          name: "CVD accessibility",
          description: "Status is never colour alone: every status badge carries its word.",
          product: "Platform",
        },
        {
          name: "Disposable email blocklist",
          description: "Disposable email domains blocked at signup.",
          product: "Platform",
        },
      ],
    },
    {
      id: "platform-infra",
      label: "Platform",
      title: "Platform",
      intro: "The infrastructure and data layer underneath everything.",
      features: [
        {
          name: "Full database schema",
          description:
            "Full schema across all platform tables: accounts, stripe_connections, failed_payments, recovery_steps, disputes, customer_context, mrr_snapshots, audit_runs, and more.",
          product: "Platform",
        },
        {
          name: `${facts.cronJobCount} cron jobs`,
          description: `All ${facts.cronJobCount} registered. Scheduled from every ${tick} minutes to ${monthly}. Status visible at /help.`,
          product: "Platform",
        },
        {
          name: "Network Intelligence Layer",
          description:
            "One outcomes write for every material event, serialized per account through a Durable Object. It never blocks the recovery, dispute, or billing path that called it.",
          product: "Platform",
        },
        {
          name: "Cross-product integration points",
          description:
            "Recovery history grounds dispute evidence. Dispute history and recovery engagement feed the Intelligence health score.",
          product: "Platform",
        },
        {
          name: "Outcomes table",
          description: "Every recovery, dispute, and alert event written to outcomes with its attribution, which lift and billing read.",
          product: "Platform",
        },
        {
          name: "Demo system",
          description: `A demo account (${DEMO_ACCOUNT_NAME}) that opens the real app read-only. ${Nightly} reset.`,
          product: "Platform",
        },
        {
          name: "AI cost tracking",
          description: "ai_calls records every Anthropic API call with model, tokens, and cost.",
          product: "Platform",
        },
        {
          name: "Renewal noise filtering",
          description: "A failed payment Stripe is still retrying is parked, so Stripe's own retry events never start a duplicate sequence.",
          product: "Platform",
        },
      ],
    },
  ];
}
