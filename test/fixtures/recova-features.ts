// Recova's /features entries (app/(marketing)/features/features-data.ts, blob
// a0a5dd20, read whole for J60) and what Foxhound did with each. Names only:
// Recova's descriptions state Recova's product facts and are never restored
// (RULES.md 2.1).
//
// `foxhound` is the name the entry carries on Foxhound's page, or null when it
// is left out. Tokens in braces are read from the engine by the test:
// {tick} the recovery tick's minutes, {weekday} the digest's day, {crons} the
// number of registered crons. `why` says why a name changed or an entry went.

export interface RecovaFeature {
  section: string;
  name: string;
  foxhound: string | null;
  why?: string;
}

const UNBUILT = "not built in Foxhound (RULES.md 2.7)";

export const RECOVA_SECTIONS = [
  { id: "automation", label: "Automation" },
  { id: "intelligence", label: "Intelligence" },
  { id: "email", label: "Email and communication" },
  { id: "visibility", label: "Visibility" },
  { id: "control", label: "Control" },
  { id: "integration", label: "Integration" },
  { id: "security", label: "Security and compliance" },
  { id: "platform-infra", label: "Platform" },
] as const;

export const RECOVA_FEATURES: RecovaFeature[] = [
  // automation (12)
  { section: "automation", name: "Hourly recovery processing", foxhound: "Recovery processing every {tick} minutes", why: "Foxhound's recovery tick runs every few minutes, not hourly" },
  { section: "automation", name: "Hourly dispute processing", foxhound: null, why: `${UNBUILT}: no dispute cron, no deadline reminders, and dispute auto-submit is deliberately not built (RULES.md 5.6)` },
  { section: "automation", name: "Hourly win-back processing", foxhound: "Win-back processing every {tick} minutes", why: "rides the recovery tick; Recova's Intelligence-priority clause dropped because nothing in Foxhound sets winback_priority (constants.ts WINBACK_PRIORITY_ACTION has no producer)" },
  { section: "automation", name: "Daily expiring card alerts", foxhound: "Nightly expiring card alerts", why: "runs on the 03:00 UTC schedule and links to Foxhound's card-update page (approved 2026-09-19), not the Stripe Billing Portal" },
  { section: "automation", name: "Nightly intelligence scoring", foxhound: "Nightly intelligence scoring" },
  { section: "automation", name: "Nightly MRR snapshots", foxhound: "Monthly MRR snapshots", why: "intelligence-sync runs monthly in Foxhound" },
  { section: "automation", name: "Monthly recovery billing", foxhound: "Monthly recovery billing" },
  { section: "automation", name: "Monthly audit auto-run", foxhound: "Monthly audit auto-run" },
  { section: "automation", name: "Monday unified digest", foxhound: "{weekday} unified digest" },
  { section: "automation", name: "Nightly demo reset", foxhound: "Nightly demo reset" },
  { section: "automation", name: "Cron overlap prevention", foxhound: "Cron overlap prevention" },
  { section: "automation", name: "Stale cron alerting", foxhound: "Stale cron alerting" },

  // intelligence (15)
  { section: "intelligence", name: "Decline classification", foxhound: "Decline classification" },
  { section: "intelligence", name: "Fraud decline detection", foxhound: "Fraud decline detection" },
  { section: "intelligence", name: "Customer health scoring", foxhound: "Customer health scoring" },
  { section: "intelligence", name: "7 recommendation types", foxhound: null, why: `${UNBUILT}: Foxhound computes no per-customer recommendation` },
  { section: "intelligence", name: "AI recovery email generation", foxhound: "AI recovery email generation" },
  { section: "intelligence", name: "AI dispute triage", foxhound: null, why: `${UNBUILT}: no fight/accept score` },
  { section: "intelligence", name: "AI audit summary", foxhound: "AI audit summary" },
  { section: "intelligence", name: "AI nightly analyst", foxhound: "AI nightly analyst" },
  { section: "intelligence", name: "Cross-product dispute signal", foxhound: "Cross-product dispute signal" },
  { section: "intelligence", name: "Fraud to dispute risk flag", foxhound: null, why: `${UNBUILT}: no fraud flag is written and there is no dispute triage to read one` },
  { section: "intelligence", name: "Dispute loss to recovery suppression", foxhound: null, why: `${UNBUILT}: a lost dispute does not suppress retries` },
  { section: "intelligence", name: "Intelligence to recovery deprioritization", foxhound: null, why: "no such mechanism; approved: the Intelligence page does not claim its signals change Recovery timing" },
  { section: "intelligence", name: "Win-back priority timing", foxhound: null, why: "the reader exists but nothing sets winback_priority (RULES.md 3.18)" },
  { section: "intelligence", name: "Card Account Updater advisory", foxhound: "Card Account Updater advisory" },
  { section: "intelligence", name: "Renewal noise filtering", foxhound: "Renewal noise filtering" },

  // email (15)
  { section: "email", name: "Per-category email sequences", foxhound: "Per-category email sequences" },
  { section: "email", name: "AI-written subject lines", foxhound: "AI-written subject lines" },
  { section: "email", name: "Brand voice configuration", foxhound: "Brand voice configuration" },
  { section: "email", name: "Merchant context", foxhound: "Merchant context" },
  { section: "email", name: "Fallback templates", foxhound: "Fallback templates" },
  { section: "email", name: "Custom body override", foxhound: null, why: "Recova's email-body editor is not built (approved 2026-08-15; RULES.md 5.6)" },
  { section: "email", name: "Open and click tracking", foxhound: "Open and click tracking" },
  { section: "email", name: "Email suppression", foxhound: "Email suppression" },
  { section: "email", name: "Resend retry with backoff", foxhound: "Send retry with backoff", why: "Foxhound sends through Cloudflare Email Service, not Resend" },
  { section: "email", name: "Win-back email sequences", foxhound: "Win-back email sequences" },
  { section: "email", name: "Expiring card email", foxhound: "Expiring card email" },
  { section: "email", name: "Weekly unified digest", foxhound: "Weekly unified digest" },
  { section: "email", name: "Dispute deadline reminders", foxhound: null, why: `${UNBUILT}: no reminder email before the evidence deadline` },
  { section: "email", name: "List-Unsubscribe headers", foxhound: "List-Unsubscribe headers" },
  { section: "email", name: "Signed unsubscribe tokens", foxhound: "Signed unsubscribe tokens" },

  // visibility (22)
  { section: "visibility", name: "Recovery dashboard", foxhound: "Recovery dashboard" },
  { section: "visibility", name: "Recovery rate chart", foxhound: "Recovery rate chart" },
  { section: "visibility", name: "Recovery timing chart", foxhound: "Recovery timing chart" },
  { section: "visibility", name: "Email category chart", foxhound: "Email category chart" },
  { section: "visibility", name: "Decline breakdown", foxhound: "Decline breakdown" },
  { section: "visibility", name: "Payment detail timeline", foxhound: "Payment detail timeline" },
  { section: "visibility", name: "Email preview in timeline", foxhound: "Email preview in timeline" },
  { section: "visibility", name: "Sequence performance page", foxhound: "Sequence performance page" },
  { section: "visibility", name: "Disputes dashboard", foxhound: "Disputes dashboard" },
  { section: "visibility", name: "Dispute evidence staging", foxhound: "Dispute evidence staging" },
  { section: "visibility", name: "Intelligence dashboard", foxhound: "Intelligence dashboard" },
  { section: "visibility", name: "Customer health index", foxhound: "Customer health index" },
  { section: "visibility", name: "Customer detail page", foxhound: "Customer detail page" },
  { section: "visibility", name: "Churn risk page", foxhound: "Churn risk page" },
  { section: "visibility", name: "MRR movement waterfall", foxhound: "MRR movement waterfall" },
  { section: "visibility", name: "Audit results page", foxhound: "Audit results page" },
  { section: "visibility", name: "Expiring cards timeline", foxhound: null, why: `${UNBUILT}: the audit shows the expiring-card count and MRR at risk, with no by-month chart` },
  { section: "visibility", name: "Audit history", foxhound: "Audit history" },
  { section: "visibility", name: "Platform status in Help", foxhound: "Platform status in Help" },
  { section: "visibility", name: "Admin webhook log", foxhound: "Admin webhook log" },
  { section: "visibility", name: "Admin audit log", foxhound: "Admin audit log" },
  { section: "visibility", name: "Cron health table", foxhound: "Cron health table" },

  // control (23)
  { section: "control", name: "Sequence pause and resume", foxhound: null, why: `${UNBUILT}: no per-sequence pause; the account-level pause is "Processing pause"` },
  { section: "control", name: "Sequence cancel", foxhound: "Stop recovery", why: 'approved 2026-08-10: the button says "Stop recovery", everywhere' },
  { section: "control", name: "Trigger immediate retry", foxhound: "Run the next step now", why: "Foxhound's control runs the next scheduled step, retry or email, rather than inserting a retry" },
  { section: "control", name: "Override next step", foxhound: null, why: `${UNBUILT}` },
  { section: "control", name: "Resend email step", foxhound: "Resend email step" },
  { section: "control", name: "Custom email body", foxhound: null, why: "Recova's email-body editor is not built (approved 2026-08-15; RULES.md 5.6)" },
  { section: "control", name: "Manual payment recovery", foxhound: "Manual payment recovery" },
  { section: "control", name: "Payment notes", foxhound: "Payment notes" },
  { section: "control", name: "Submit dispute evidence", foxhound: "Submit dispute evidence" },
  { section: "control", name: "Accept dispute", foxhound: null, why: `${UNBUILT}: no accept action on the dispute page` },
  { section: "control", name: "Dispute auto-submit toggle", foxhound: null, why: "deliberately not built (RULES.md 5.6)" },
  { section: "control", name: "Dismiss recommendation", foxhound: null, why: `${UNBUILT}: no recommendations` },
  { section: "control", name: "Snooze recommendation", foxhound: null, why: `${UNBUILT}: no recommendations` },
  { section: "control", name: "Customer notes", foxhound: null, why: "the customer_notes table exists but no page reads or writes it (RULES.md 3.18)" },
  { section: "control", name: "Audit lookback days", foxhound: "Audit lookback days" },
  { section: "control", name: "Audit auto-run toggle", foxhound: "Audit auto-run toggle" },
  { section: "control", name: "Processing pause", foxhound: "Processing pause" },
  { section: "control", name: "Alert thresholds", foxhound: "Alert thresholds" },
  { section: "control", name: "Email settings", foxhound: "Email settings" },
  { section: "control", name: "Brand voice", foxhound: "Brand voice" },
  { section: "control", name: "Merchant context", foxhound: "Merchant context" },
  { section: "control", name: "Theme toggle", foxhound: "Theme toggle" },
  { section: "control", name: "Team seats", foxhound: "Team seats" },

  // integration (15)
  { section: "integration", name: "Stripe Connect OAuth", foxhound: "Stripe Connect OAuth" },
  { section: "integration", name: "Multi-account support", foxhound: "Multi-account support" },
  { section: "integration", name: "AES-256-GCM token encryption", foxhound: "AES-256-GCM token encryption" },
  { section: "integration", name: "Stripe webhook processing", foxhound: "Stripe webhook processing" },
  { section: "integration", name: "Resend email delivery", foxhound: "Cloudflare Email Service delivery", why: "Foxhound's mail provider (RULES.md 1.2, a Cloudflare internal)" },
  { section: "integration", name: "MCP Merchant connector", foxhound: "MCP Merchant connector" },
  { section: "integration", name: "MCP Admin connector", foxhound: "MCP Admin connector" },
  { section: "integration", name: "OAuth 2.1 authorization server", foxhound: "OAuth 2.1 authorization server" },
  { section: "integration", name: "Refresh token rotation", foxhound: null, why: "not verified: the admin connector's refresh behavior is the OAuth library's, which keeps the previous token valid for a grace period, so Recova's 'old token invalidated' is not claimed" },
  { section: "integration", name: "API keys", foxhound: "API keys" },
  { section: "integration", name: "Anthropic API", foxhound: "Anthropic API" },
  { section: "integration", name: "Supabase", foxhound: "Cloudflare D1", why: "Foxhound's database (RULES.md 1.2, a Cloudflare internal)" },
  { section: "integration", name: "Vercel", foxhound: "Cloudflare Workers", why: "Foxhound's host (RULES.md 1.2, a Cloudflare internal)" },
  { section: "integration", name: "Sentry", foxhound: null, why: "the Worker is wrapped with Sentry, but it reports only once SENTRY_DSN is set, which RULES.md 3.22 lists as still to do" },
  { section: "integration", name: "Upstash", foxhound: "Durable Object rate limiting", why: "Foxhound's rate limiter (RULES.md 1.2, a Cloudflare internal)" },

  // security (15)
  { section: "security", name: "Read-only Stripe scope", foxhound: "Narrow Stripe scope", why: "truthfulness: Foxhound asks for read and write at /connect (RULES.md 2.2)" },
  { section: "security", name: "Row Level Security", foxhound: "Tenant isolation", why: "D1 has no row-level security; isolation is the account-first query helpers (RULES.md 4.6)" },
  { section: "security", name: "AES-256-GCM encryption", foxhound: "AES-256-GCM encryption" },
  { section: "security", name: "Stripe webhook verification", foxhound: "Stripe webhook verification" },
  { section: "security", name: "Resend webhook HMAC", foxhound: null, why: "no mail-provider webhook: Email Service events arrive through a queue, so there is no signature to check" },
  { section: "security", name: "CRON_SECRET validation", foxhound: "Scheduler-only crons", why: "Foxhound's crons have no HTTP route at all" },
  { section: "security", name: "PKCE S256 enforced", foxhound: "PKCE S256 enforced" },
  { section: "security", name: "Single-use authorization codes", foxhound: null, why: "not verified: the OAuth library notes its code redemption is not atomic on KV, so the claim is not made" },
  { section: "security", name: "Refresh token rotation", foxhound: null, why: "not verified, as in Integration" },
  { section: "security", name: "Admin scope double-gate", foxhound: "Admin double-gate", why: "Foxhound's gate is Cloudflare Access plus the admin list (Q6), not an OAuth scope" },
  { section: "security", name: "Rate limiting", foxhound: "Rate limiting" },
  { section: "security", name: "CAN-SPAM compliance", foxhound: "CAN-SPAM compliance" },
  { section: "security", name: "WCAG 2.2 compliance", foxhound: "WCAG 2.2 compliance" },
  { section: "security", name: "CVD accessibility", foxhound: "CVD accessibility" },
  { section: "security", name: "Disposable email blocklist", foxhound: "Disposable email blocklist" },

  // platform-infra (12)
  { section: "platform-infra", name: "Full database schema", foxhound: "Full database schema" },
  { section: "platform-infra", name: "15 cron jobs", foxhound: "{crons} cron jobs", why: "the count is read from the cron registry" },
  { section: "platform-infra", name: "Network Intelligence Layer", foxhound: "Network Intelligence Layer" },
  { section: "platform-infra", name: "Cross-product integration points", foxhound: "Cross-product integration points" },
  { section: "platform-infra", name: "Outcomes table", foxhound: "Outcomes table" },
  { section: "platform-infra", name: "Demo system", foxhound: "Demo system" },
  { section: "platform-infra", name: "AI cost tracking", foxhound: "AI cost tracking" },
  { section: "platform-infra", name: "Benchmark data", foxhound: null, why: "the estimator reads benchmark_data but nothing writes it (RULES.md 3.18)" },
  { section: "platform-infra", name: "A/B test infrastructure", foxhound: null, why: "schema columns only; nothing reads or writes them (RULES.md 3.18)" },
  { section: "platform-infra", name: "Soft deletes", foxhound: null, why: "queries skip deleted_at rows, but nothing ever sets deleted_at (RULES.md 3.18)" },
  { section: "platform-infra", name: "Renewal noise filtering", foxhound: "Renewal noise filtering" },
  { section: "platform-infra", name: "Last visited path", foxhound: null, why: "accounts.last_visited_path is read at sign-in but nothing writes it (RULES.md 3.18)" },
];
