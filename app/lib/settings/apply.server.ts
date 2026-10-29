import { and, eq } from "drizzle-orm";

import type { Db } from "~/db";
import { accounts, alerts, mcpWrites, stripeConnections } from "~/db";

import { isAlertDirection, isAlertMetric, isCentsMetric } from "./alert-metrics";
import {
  buildAlertDelete,
  buildAlertEnabledUpdate,
  buildAlertHistoryDelete,
  buildAlertInsert,
} from "./alerts.server";
import { normalizeLookback } from "./audit-settings";
import { parseDollarsToCents } from "./dollars";
import {
  buildBrandVoiceUpdate,
  buildVoiceSamplesUpdate,
  buildCategoryVoicesUpdate,
  buildFeatureSettingsUpdate,
  buildIntelligenceContextUpdate,
  buildNotificationSettingsUpdate,
  buildSenderSettingsUpdate,
} from "./persist.server";
import { DISPUTE_PRODUCT_DESCRIPTION_MAX_LENGTH } from "./dispute-description";
import { isValidReplyToEmail, REPLY_TO_EMAIL_MAX_LENGTH } from "./reply-to";
import { SENDER_NAME_MAX_LENGTH } from "./sender-name";
import { normalizeSlackWebhookUrl } from "./slack-webhook";
import { readVoiceSamples, storeVoiceSamples } from "~/lib/recovery/voice-samples";

// THE ONE PLACE A SETTING IS VALIDATED AND WRITTEN (372's item-4 ruling).
//
// WHY THIS MODULE EXISTS. The settings forms and the MCP write tools must agree
// exactly: same bounds, same allowlist, same refusal string. Two implementations
// of "what is a valid sender name" is the drift 372 asked to prevent, and the
// version somebody re-reads would be the one that stayed right. So the ACTION'S
// CORE moved here, and both callers invoke it: the route action passes values it
// read from a FormData, the tool passes values it read from JSON. Neither
// validates anything itself.
//
// THE ROUTE ACTIONS ARE NOW THIN, and deliberately so. What is left in each one
// is reading the form and rendering the result, which is the part that is
// genuinely about being a form.
//
// A DISCRIMINATED OUTCOME, never a throw (339 binding 5). A refusal carries the
// user-facing string the form already showed, so an agent sees the same sentence
// a person would and a merchant reading both gets one answer.
//
// EVERY WRITE LEAVES A TRACE WHEN AN AGENT MAKES IT. `applyX` takes an optional
// `trace`; the form omits it (a signed-in human's change is already attributable
// through the session) and the tool always passes one. The trace row goes in the
// SAME `db.batch` as the write, so a change without its trace is not a state the
// database can reach. An unattended write without a trace is not a safe write.

/** What every apply function returns. `fields` is the column names touched,
 *  which is what the trace records and what a tool reports back. */
export type ApplyResult<T> =
  | { ok: true; fields: string[]; state: T }
  | { ok: false; error: string };

/** Who is making the write, when an agent is. Omitted for a form. */
export interface WriteTrace {
  apiKeyId: string;
  tool: string;
  now: Date;
}

/** The trace insert, built alongside the write so the two commit together. */
function traceInsert(db: Db, accountId: string, fields: string[], trace: WriteTrace) {
  return db.insert(mcpWrites).values({
    id: crypto.randomUUID(),
    accountId,
    apiKeyId: trace.apiKeyId,
    tool: trace.tool,
    fields,
    createdAt: trace.now,
  });
}

/** Run the write, plus its trace when there is one, as one batch.
 *
 *  `statement` takes an ARRAY when one setting spans two tables or two
 *  statements: brand voice writes the general column and the four category
 *  columns through two allowlisted builders, and both plus the trace have to
 *  land or none of them do. The route used to `await` those two separately,
 *  so a failure between them left half a voice stored. */
async function commit(
  db: Db,
  accountId: string,
  fields: string[],
  statement: unknown | unknown[],
  trace: WriteTrace | undefined,
) {
  const writes = Array.isArray(statement) ? statement : [statement];
  const statements = trace ? [...writes, traceInsert(db, accountId, fields, trace)] : writes;
  await (db as unknown as { batch: (s: unknown[]) => Promise<unknown> }).batch(statements);
}

/** Coerce a JSON or form boolean. Accepts a real boolean and the "true" string
 *  a checkbox posts, so one rule serves both callers. */
function asBoolean(value: unknown): boolean {
  return value === true || value === "true";
}

/** Trim to null, the shape every optional text setting uses. */
function asOptionalText(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw.length > 0 ? raw : null;
}

// ---------------------------------------------------------------------------

export interface AuditSettingsState {
  lookbackDays: number;
  autoRun: boolean;
}

/**
 * S30's two columns. `normalizeLookback` is the allowlist and it CLAMPS rather
 * than refusing, which is the form's behavior and stays the tool's: legacy
 * clamps on render and posts the clamped value, and the action clamps again
 * server-side because an action takes whatever is posted.
 */
export async function applyAuditSettings(
  db: Db,
  accountId: string,
  input: { lookbackDays: unknown; autoRun: unknown },
  trace?: WriteTrace,
): Promise<ApplyResult<AuditSettingsState>> {
  const lookbackDays = normalizeLookback(input.lookbackDays);
  const autoRun = asBoolean(input.autoRun);
  const fields = ["audit_lookback_days", "audit_auto_run"];

  await commit(
    db,
    accountId,
    fields,
    db
      .update(accounts)
      .set({ auditLookbackDays: lookbackDays, auditAutoRun: autoRun })
      .where(eq(accounts.id, accountId)),
    trace,
  );
  return { ok: true, fields, state: { lookbackDays, autoRun } };
}

export interface FeatureSettingsState {
  winbackNotificationsEnabled: boolean;
  expiringCardNotificationsEnabled: boolean;
}

/** S34's two toggles, and nothing else. The builder names the two columns, so a
 *  caller passing a third writes none of them. */
export async function applyFeatureSettings(
  db: Db,
  accountId: string,
  input: { winbackNotificationsEnabled: unknown; expiringCardNotificationsEnabled: unknown },
  trace?: WriteTrace,
): Promise<ApplyResult<FeatureSettingsState>> {
  const state: FeatureSettingsState = {
    winbackNotificationsEnabled: asBoolean(input.winbackNotificationsEnabled),
    expiringCardNotificationsEnabled: asBoolean(input.expiringCardNotificationsEnabled),
  };
  const fields = ["winback_notifications_enabled", "expiring_card_notifications_enabled"];
  await commit(db, accountId, fields, buildFeatureSettingsUpdate(db, accountId, state), trace);
  return { ok: true, fields, state };
}

export interface DisputeSettingsState {
  productDescription: string | null;
  shipsPhysical: boolean;
}

/** Stripe's limit on an evidence text field, which the description becomes. */
;
export const DISPUTE_PRODUCT_DESCRIPTION_ERROR = `Keep the product description under ${DISPUTE_PRODUCT_DESCRIPTION_MAX_LENGTH.toLocaleString("en-US")} characters.`;

/**
 * S32's two columns (J06), and nothing else: the product description, which
 * dispute intake reads into every response's evidence, and ships-physical,
 * which puts the shipping inputs on the dispute page. Recova's third column,
 * dispute_auto_submit, is never written (RULES.md 5.6). A blank description is
 * stored as null, so the reader's "not set" is one value.
 */
export async function applyDisputeSettings(
  db: Db,
  accountId: string,
  input: { productDescription: unknown; shipsPhysical: unknown },
  trace?: WriteTrace,
): Promise<ApplyResult<DisputeSettingsState>> {
  const productDescription = asOptionalText(input.productDescription);
  if (productDescription && productDescription.length > DISPUTE_PRODUCT_DESCRIPTION_MAX_LENGTH) {
    return { ok: false, error: DISPUTE_PRODUCT_DESCRIPTION_ERROR };
  }
  const state: DisputeSettingsState = { productDescription, shipsPhysical: asBoolean(input.shipsPhysical) };
  const fields = ["dispute_product_description", "dispute_ships_physical"];
  await commit(
    db,
    accountId,
    fields,
    db
      .update(accounts)
      .set({ disputeProductDescription: state.productDescription, disputeShipsPhysical: state.shipsPhysical })
      .where(eq(accounts.id, accountId)),
    trace,
  );
  return { ok: true, fields, state };
}

export interface NotificationSettingsState {
  notificationEmail: string | null;
  slackWebhookUrl: string | null;
  slackNotificationsEnabled: boolean;
  digestEnabled: boolean;
  recoveryNotificationsEnabled: boolean;
  sequenceCompleteNotificationsEnabled: boolean;
}

/**
 * The six controls the notifications page renders.
 *
 * `normalizeSlackWebhookUrl` is the ONE webhook rule: it refuses anything off
 * Slack's own host, and its refusal string is what the form shows. An agent
 * pasting an attacker's URL gets the same sentence a person would.
 */
export async function applyNotificationSettings(
  db: Db,
  accountId: string,
  input: Record<string, unknown>,
  trace?: WriteTrace,
): Promise<ApplyResult<NotificationSettingsState>> {
  const webhook = normalizeSlackWebhookUrl(
    typeof input.slackWebhookUrl === "string" ? input.slackWebhookUrl : "",
  );
  if (!webhook.ok) return { ok: false, error: webhook.error };

  const state: NotificationSettingsState = {
    // Legacy's `|| null`: clearing the box is how a merchant turns every
    // notification off, which 339 binding 1 already relies on.
    notificationEmail: asOptionalText(input.notificationEmail),
    slackWebhookUrl: webhook.value,
    slackNotificationsEnabled: asBoolean(input.slackNotificationsEnabled),
    digestEnabled: asBoolean(input.digestEnabled),
    recoveryNotificationsEnabled: asBoolean(input.recoveryNotificationsEnabled),
    sequenceCompleteNotificationsEnabled: asBoolean(input.sequenceCompleteNotificationsEnabled),
  };
  const fields = [
    "notification_email",
    "slack_webhook_url",
    "slack_notifications_enabled",
    "digest_enabled",
    "recovery_notifications_enabled",
    "sequence_complete_notifications_enabled",
  ];
  await commit(db, accountId, fields, buildNotificationSettingsUpdate(db, accountId, state), trace);
  return { ok: true, fields, state };
}

export interface SenderNameState {
  connectionId: string;
  senderName: string | null;
  /** Present only when the caller sent the field (J03). */
  replyToEmail?: string | null;
}

/**
 * The sender name on one connection.
 *
 * TWO REFUSALS, both the form's own strings: no connection, and over the bound.
 * The bound is 80 (see ./sender-name.ts for why it exists at all, given legacy
 * has none).
 *
 * THE CONNECTION IS VERIFIED TO BELONG TO THIS ACCOUNT before the write, which
 * the form got for free from its own loader and a tool does not: an agent passes
 * a connection id as an argument, so the ownership check has to be explicit
 * here or the argument would be a way to name somebody else's connection.
 */
export async function applySenderName(
  db: Db,
  accountId: string,
  input: { connectionId: unknown; senderName: unknown; replyToEmail?: unknown },
  trace?: WriteTrace,
): Promise<ApplyResult<SenderNameState>> {
  const connectionId = typeof input.connectionId === "string" ? input.connectionId.trim() : "";
  if (!connectionId) {
    return { ok: false, error: "Connect Stripe before setting a sender name." };
  }

  const senderName = asOptionalText(input.senderName);
  if (senderName && senderName.length > SENDER_NAME_MAX_LENGTH) {
    return {
      ok: false,
      error: `Sender name must be ${SENDER_NAME_MAX_LENGTH} characters or fewer.`,
    };
  }

  // THE REPLY-TO (J03), legacy's "Reply-to email" field on the same form.
  // Written only when the caller sent it, which is legacy's own
  // `if (formData.has('reply_to_email'))`: the MCP sender tool sends no such
  // field, so it leaves the column alone. Empty is NULL, as legacy's `|| null`.
  // The format check and the bound are input hygiene legacy does not have
  // (./reply-to.ts says why).
  const writesReplyTo = input.replyToEmail !== undefined;
  const replyToEmail = writesReplyTo ? asOptionalText(input.replyToEmail) : undefined;
  if (replyToEmail && replyToEmail.length > REPLY_TO_EMAIL_MAX_LENGTH) {
    return {
      ok: false,
      error: `Reply-to email must be ${REPLY_TO_EMAIL_MAX_LENGTH} characters or fewer.`,
    };
  }
  if (replyToEmail && !isValidReplyToEmail(replyToEmail)) {
    return { ok: false, error: "Enter a valid reply-to email address." };
  }

  const owned = await db
    .select({ id: stripeConnections.id })
    .from(stripeConnections)
    .where(and(eq(stripeConnections.id, connectionId), eq(stripeConnections.accountId, accountId)))
    .limit(1);
  if (owned.length === 0) {
    return { ok: false, error: "Connect Stripe before setting a sender name." };
  }

  const fields = writesReplyTo ? ["sender_name", "reply_to_email"] : ["sender_name"];
  await commit(
    db,
    accountId,
    fields,
    buildSenderSettingsUpdate(db, accountId, connectionId, { senderName, replyToEmail }),
    trace,
  );
  const state: SenderNameState = { connectionId, senderName };
  if (writesReplyTo) state.replyToEmail = replyToEmail ?? null;
  return { ok: true, fields, state };
}

export interface BrandVoiceState {
  connectionId: string;
  general: string | null;
  soft: string | null;
  expired: string | null;
  network: string | null;
  fraud: string | null;
  /** The merchant's own past emails, as they will be read back. */
  samples: string[];
}

/** The five voice columns, keyed the way callers name them and valued the way
 *  the trace records them. Naming each one IS the allowlist. */
const BRAND_VOICE_COLUMNS = {
  general: "brand_voice",
  soft: "brand_voice_soft",
  expired: "brand_voice_expired",
  network: "brand_voice_network",
  fraud: "brand_voice_fraud",
} as const;

type BrandVoiceKey = keyof typeof BRAND_VOICE_COLUMNS;

/** One sentence for both refusals, and it is the form's own. */
const NO_CONNECTION_FOR_VOICE = "Connect Stripe before setting a brand voice.";

/**
 * The general voice plus the four decline-category voices, on one connection.
 *
 * NO BOUND AND NO SANITIZER ON THE WAY IN, which is legacy and is the form:
 * no maxLength, no pattern, no required. Adding one here would be an
 * unratified user-visible divergence, and it would also be guarding the wrong
 * end. This text becomes part of the SYSTEM PROMPT that generates a recovery
 * email (`resolveBrandVoice` feeds `buildSystemPrompt`), so what protects the
 * merchant is on the OUTPUT side and already ships: every generated subject and
 * body goes through `sanitizeCopy`, and `passesQualityGate` rejects the result
 * before it is sent. An agent writing this column is writing a prompt fragment,
 * and the fragment is not trusted downstream any more than a person's is.
 *
 * ABSENT MEANS LEAVE ALONE; EMPTY MEANS CLEAR. The form always posts all five
 * (four hidden inputs plus the textarea), so it always supplies every key and
 * this distinction never fires for it: `form.get` returns "" for a cleared box,
 * which stores NULL exactly as legacy's `|| null` does. A TOOL caller can omit
 * a key, and omission must not wipe four categories the merchant set in the UI.
 * There is no `get_brand_voice` read tool to preserve them from, so silently
 * clearing on omission would be unrecoverable rather than merely surprising.
 * This is not a second validator: the bounds, the allowlist and the refusal
 * string are one implementation. It only decides which columns are in the SET.
 *
 * THE CONNECTION IS VERIFIED, and this closes a silent no-op the route shipped
 * with. Both builders pin `account_id`, so a foreign or stale `connectionId`
 * matched zero rows and the action returned 200 with nothing written. 374
 * binding 3: a zero-row UPDATE reported as success is a lie the moment the
 * input source widens, and registering a tool is exactly that widening.
 */
export async function applyBrandVoice(
  db: Db,
  accountId: string,
  input: {
    connectionId: unknown;
    general?: unknown;
    soft?: unknown;
    expired?: unknown;
    network?: unknown;
    fraud?: unknown;
    /** The pasted past emails, one string per box. Absent leaves them alone;
     *  a list of empty boxes clears them. */
    samples?: unknown;
  },
  trace?: WriteTrace,
): Promise<ApplyResult<BrandVoiceState>> {
  const connectionId = typeof input.connectionId === "string" ? input.connectionId.trim() : "";
  if (!connectionId) return { ok: false, error: NO_CONNECTION_FOR_VOICE };

  // The ownership check and the read of the current voices are ONE query: the
  // fallback below needs the stored values, and a separate existence check
  // would be a second round trip for the same row.
  const found = await db
    .select({
      general: stripeConnections.brandVoice,
      soft: stripeConnections.brandVoiceSoft,
      expired: stripeConnections.brandVoiceExpired,
      network: stripeConnections.brandVoiceNetwork,
      fraud: stripeConnections.brandVoiceFraud,
      samples: stripeConnections.brandVoiceSamples,
    })
    .from(stripeConnections)
    .where(and(eq(stripeConnections.id, connectionId), eq(stripeConnections.accountId, accountId)))
    .limit(1);
  if (found.length === 0) return { ok: false, error: NO_CONNECTION_FOR_VOICE };
  const stored = found[0];

  const fields: string[] = [];
  const resolve = (key: BrandVoiceKey): string | null => {
    const supplied = input[key];
    if (supplied === undefined) return stored[key];
    fields.push(BRAND_VOICE_COLUMNS[key]);
    return asOptionalText(supplied);
  };

  const state: BrandVoiceState = {
    connectionId,
    general: resolve("general"),
    soft: resolve("soft"),
    expired: resolve("expired"),
    network: resolve("network"),
    fraud: resolve("fraud"),
    samples: readVoiceSamples(stored.samples),
  };
  let storedSamples = stored.samples;
  if (input.samples !== undefined) {
    if (!Array.isArray(input.samples)) return { ok: false, error: "Sample emails must be a list of texts." };
    fields.push("brand_voice_samples");
    storedSamples = storeVoiceSamples(input.samples);
    state.samples = readVoiceSamples(storedSamples);
  }

  await commit(
    db,
    accountId,
    fields,
    [
      buildCategoryVoicesUpdate(db, accountId, connectionId, {
        soft: state.soft,
        expired: state.expired,
        network: state.network,
        fraud: state.fraud,
      }),
      buildBrandVoiceUpdate(db, accountId, connectionId, state.general),
      buildVoiceSamplesUpdate(db, accountId, connectionId, storedSamples),
    ],
    trace,
  );
  return { ok: true, fields, state };
}

export interface IntelligenceContextState {
  merchantIndustry: string | null;
  primaryCustomerType: string | null;
  merchantMrrSelfReportedCents: number | null;
}

/** The refusal for an amount that is neither blank nor a number. The form used
 *  to show none, because it did not have one. */
export const MRR_ERROR = "Enter a monthly recurring revenue of zero or more, or leave it blank.";

/**
 * The three merchant-context fields the Intelligence card writes.
 *
 * WHAT THEY ARE FOR, because it decides how carefully they are handled: like
 * the brand voice, these are fed to the model that writes recovery copy, and
 * they will feed risk scoring when that engine lands. Free text, no bound,
 * matching the form and legacy.
 *
 * ABSENT MEANS LEAVE ALONE, the rule `applyBrandVoice` carries and for the same
 * reason. All three are set once and forgotten, the form posts all three every
 * time so nothing changes for it, and an agent updating only the industry must
 * not blank the other two.
 *
 * A NON-BLANK AMOUNT THAT IS NOT A NUMBER IS NOW REFUSED, and this is a fix
 * rather than a new bound. `parseDollarsToCents` returns null for "abc" and for
 * a negative, and the action stored that null and answered "Saved": the field
 * is a plain text input, so a person could always type into it and be told
 * their entry was kept when it had been discarded. That is 374 binding 3's
 * lesson one table over, and registering a tool is the widening it warns about.
 * BLANK IS STILL NULL, because clearing the field is a real thing to want.
 *
 * `alongside` is statements the CALLER builds and wants committed in the same
 * batch, after this write: the account page saves the name with these three
 * as one form (Recova's AccountProfileForm), so a failed name write must not
 * leave the context saved. It is not validated or traced here; the caller owns
 * it. Nothing is committed when the input is refused.
 */
export async function applyIntelligenceContext(
  db: Db,
  accountId: string,
  input: {
    merchantIndustry?: unknown;
    primaryCustomerType?: unknown;
    merchantMrrSelfReported?: unknown;
  },
  trace?: WriteTrace,
  alongside: unknown[] = [],
): Promise<ApplyResult<IntelligenceContextState>> {
  const found = await db
    .select({
      merchantIndustry: accounts.merchantIndustry,
      primaryCustomerType: accounts.primaryCustomerType,
      merchantMrrSelfReportedCents: accounts.merchantMrrSelfReported,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  // The caller's own account, resolved from their credential rather than from
  // an argument, so there is no foreign-id case here to refuse.
  if (found.length === 0) return { ok: false, error: "This account no longer exists." };
  const stored = found[0];

  const fields: string[] = [];
  const state: IntelligenceContextState = { ...stored };

  if (input.merchantIndustry !== undefined) {
    fields.push("merchant_industry");
    state.merchantIndustry = asOptionalText(input.merchantIndustry);
  }
  if (input.primaryCustomerType !== undefined) {
    fields.push("primary_customer_type");
    state.primaryCustomerType = asOptionalText(input.primaryCustomerType);
  }
  if (input.merchantMrrSelfReported !== undefined) {
    const raw =
      typeof input.merchantMrrSelfReported === "number"
        ? String(input.merchantMrrSelfReported)
        : typeof input.merchantMrrSelfReported === "string"
          ? input.merchantMrrSelfReported
          : "";
    const cents = parseDollarsToCents(raw);
    // Blank clears. Non-blank that would not parse is the refusal, which is why
    // the two cases are separated rather than both reading as null.
    if (cents === null && raw.trim().length > 0) return { ok: false, error: MRR_ERROR };
    fields.push("merchant_mrr_self_reported");
    state.merchantMrrSelfReportedCents = cents;
  }

  await commit(
    db,
    accountId,
    fields,
    [buildIntelligenceContextUpdate(db, accountId, state), ...alongside],
    trace,
  );
  return { ok: true, fields, state };
}

// ---------------------------------------------------------------------------
// Alerts, in TWO functions, because the action is in two shapes
// ---------------------------------------------------------------------------
//
// THE FORM'S ACTION BRANCHES EXACTLY HERE and the split follows it rather than
// inventing one: `if (intent === "create")` validates four fields and takes no
// id, then `if (intent === "toggle" || intent === "delete")` shares the id
// reading and the refusal between two verbs that operate on a row that already
// exists. Nothing is shared across that line: no argument, no validation, no
// refusal string.
//
// SO THERE ARE TWO TOOLS. A single one would need a schema whose required
// fields depend on the value of another field, which is the shape an agent gets
// wrong, and it would put the foreign-id guard on a code path that sometimes
// has no id to guard. Splitting makes the guard unconditional where an id
// exists and structurally absent where one does not.

export interface AlertCreateState {
  id: string;
  metric: string;
  direction: string;
  thresholdValue: number;
  label: string | null;
  channel: string;
}

/** Recova's two channels. Email is the default, as Recova's form opens on it. */
const ALERT_CHANNELS = ["email", "slack"] as const;

/** The three refusals, the form's own sentences. */
const ALERT_METRIC_ERROR = "Choose a metric Foxhound tracks.";
const ALERT_DIRECTION_ERROR = "Choose whether the metric rises or drops.";
export const ALERT_THRESHOLD_ERROR = "Enter a threshold of zero or more.";
const ALERT_NOT_FOUND_ERROR = "Select an alert.";

/**
 * Create one alert.
 *
 * THE ENUMS ARE THE EVALUATOR'S, not the select's. A posted metric the nightly
 * `evaluateAlerts` cannot compute is refused here rather than stored and then
 * skipped in silence every night, which is the form's own reasoning and now
 * covers an agent that invents a metric name.
 *
 * THE THRESHOLD ARRIVES IN DOLLARS FOR A CENTS METRIC and is stored in cents,
 * because that is the column the evaluator compares against. A tool passing a
 * JSON number goes through the identical conversion, so an agent cannot store
 * an amount a hundred times too small by taking the other reading.
 */
export async function applyAlertCreate(
  db: Db,
  accountId: string,
  input: { metric: unknown; direction: unknown; threshold: unknown; label?: unknown; channel?: unknown },
  now: Date,
  trace?: WriteTrace,
): Promise<ApplyResult<AlertCreateState>> {
  const metric = typeof input.metric === "string" ? input.metric : "";
  const direction = typeof input.direction === "string" ? input.direction : "";
  if (!isAlertMetric(metric)) return { ok: false, error: ALERT_METRIC_ERROR };
  if (!isAlertDirection(direction)) return { ok: false, error: ALERT_DIRECTION_ERROR };

  const raw = typeof input.threshold === "number" ? String(input.threshold) : String(input.threshold ?? "").trim();
  const parsed = Number(raw);
  if (!raw || !Number.isFinite(parsed) || parsed < 0) {
    return { ok: false, error: ALERT_THRESHOLD_ERROR };
  }
  const thresholdValue = isCentsMetric(metric) ? Math.round(parsed * 100) : parsed;
  const channel = (ALERT_CHANNELS as readonly unknown[]).includes(input.channel) ? String(input.channel) : "email";

  const state: AlertCreateState = {
    id: crypto.randomUUID(),
    metric,
    direction,
    thresholdValue,
    label: asOptionalText(input.label),
    channel,
  };
  // A new row, so every column it names is a field this write touched.
  const fields = ["metric", "direction", "threshold_value", "label", "channel"];
  await commit(
    db,
    accountId,
    fields,
    buildAlertInsert(db, accountId, state, now, state.id),
    trace,
  );
  return { ok: true, fields, state };
}

export interface AlertConfigState {
  id: string;
  enabled: boolean;
  deleted: boolean;
}

/**
 * Enable, disable or delete one existing alert.
 *
 * THE ALERT IS VERIFIED TO BELONG TO THIS ACCOUNT, and this closes the second
 * silent no-op of the session. Both writers pin `account_id`, and the route's
 * own comment said so approvingly: "an alert on another account matches zero
 * rows and changes nothing". It then returned `ok: true`. Nothing being changed
 * IS the problem once an id can be typed by something that guessed it: the
 * caller is told the alert is off when it is still firing, or that it is gone
 * when it is not. 374 binding 3, and the same fixture proves an absent id and a
 * foreign one both refuse.
 *
 * DELETING TAKES THE FIRING HISTORY WITH IT, which is legacy's cascade and the
 * foreign key's requirement, so the two statements batch in that order.
 */
export async function applyAlertConfig(
  db: Db,
  accountId: string,
  input: { alertId: unknown; enabled?: unknown; deleted?: unknown },
  trace?: WriteTrace,
): Promise<ApplyResult<AlertConfigState>> {
  const alertId = typeof input.alertId === "string" ? input.alertId.trim() : "";
  if (!alertId) return { ok: false, error: ALERT_NOT_FOUND_ERROR };

  const owned = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(and(eq(alerts.id, alertId), eq(alerts.accountId, accountId)))
    .limit(1);
  if (owned.length === 0) return { ok: false, error: ALERT_NOT_FOUND_ERROR };

  if (asBoolean(input.deleted)) {
    const fields = ["deleted"];
    await commit(
      db,
      accountId,
      fields,
      [buildAlertHistoryDelete(db, accountId, alertId), buildAlertDelete(db, accountId, alertId)],
      trace,
    );
    return { ok: true, fields, state: { id: alertId, enabled: false, deleted: true } };
  }

  const enabled = asBoolean(input.enabled);
  const fields = ["enabled"];
  await commit(
    db,
    accountId,
    fields,
    buildAlertEnabledUpdate(db, accountId, alertId, enabled),
    trace,
  );
  return { ok: true, fields, state: { id: alertId, enabled, deleted: false } };
}
