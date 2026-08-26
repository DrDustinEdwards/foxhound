import { and, eq } from "drizzle-orm";

import type { Db } from "~/db";
import { accounts, mcpWrites, stripeConnections } from "~/db";

import { normalizeLookback } from "./audit-settings";
import { parseDollarsToCents } from "./dollars";
import {
  buildBrandVoiceUpdate,
  buildCategoryVoicesUpdate,
  buildFeatureSettingsUpdate,
  buildIntelligenceContextUpdate,
  buildNotificationSettingsUpdate,
  buildSenderSettingsUpdate,
} from "./persist.server";
import { SENDER_NAME_MAX_LENGTH } from "./sender-name";
import { normalizeSlackWebhookUrl } from "./slack-webhook";

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
export function asBoolean(value: unknown): boolean {
  return value === true || value === "true";
}

/** Trim to null, the shape every optional text setting uses. */
export function asOptionalText(value: unknown): string | null {
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
 * than refusing, which is the form's behaviour and stays the tool's: legacy
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
  input: { connectionId: unknown; senderName: unknown },
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

  const owned = await db
    .select({ id: stripeConnections.id })
    .from(stripeConnections)
    .where(and(eq(stripeConnections.id, connectionId), eq(stripeConnections.accountId, accountId)))
    .limit(1);
  if (owned.length === 0) {
    return { ok: false, error: "Connect Stripe before setting a sender name." };
  }

  const fields = ["sender_name"];
  await commit(
    db,
    accountId,
    fields,
    buildSenderSettingsUpdate(db, accountId, connectionId, { senderName }),
    trace,
  );
  return { ok: true, fields, state: { connectionId, senderName } };
}

export interface BrandVoiceState {
  connectionId: string;
  general: string | null;
  soft: string | null;
  expired: string | null;
  network: string | null;
  fraud: string | null;
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
 * NO BOUND AND NO SANITISER ON THE WAY IN, which is legacy and is the form:
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
  };

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
    buildIntelligenceContextUpdate(db, accountId, state),
    trace,
  );
  return { ok: true, fields, state };
}
