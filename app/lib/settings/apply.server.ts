import { formatCount } from "@drdustinedwards/site-helpers/text";
import { eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Db } from "~/db";
import { accounts, mcpWrites } from "~/db";
import { parseMoneyInput } from "@dustinedwards/site-runtime/money";
import { sealSlackWebhook } from "~/lib/notify/slack-webhook-secret.server";

import { normalizeLookback } from "./audit-settings";
import {
  buildFeatureSettingsUpdate,
  buildIntelligenceContextUpdate,
  buildNotificationSettingsUpdate,
} from "./persist.server";
import { DISPUTE_PRODUCT_DESCRIPTION_MAX_LENGTH } from "./dispute-description";
import { asBoolean, asLabel, asNotificationEmail, asOptionalText } from "./setting-input";
import { normalizeSlackWebhookUrl } from "./slack-webhook";

// THE ONE PLACE A SETTING IS VALIDATED AND WRITTEN. The settings forms and the MCP write tools must
// agree exactly: same bounds, allowlist and refusal string. A DISCRIMINATED OUTCOME, never a throw.

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

/** Run the write, plus its trace when there is one, as one batch. */
export async function commit(
  db: Db,
  accountId: string,
  fields: string[],
  statement: BatchItem<"sqlite"> | [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]],
  trace: WriteTrace | undefined,
) {
  type Statements = [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];
  const writes: Statements = Array.isArray(statement) ? statement : [statement];
  const statements: Statements = trace
    ? [...writes, traceInsert(db, accountId, fields, trace)]
    : writes;
  await db.batch(statements);
}

export interface AuditSettingsState {
  lookbackDays: number;
  autoRun: boolean;
}

/** The two audit columns. */
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

/** The two toggles, and nothing else. The builder names the two columns, so a
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
  autoSubmit: boolean;
}

/** Who is saving the dispute settings: the signed-in user whose turning
 *  auto-submit on becomes the standing approval its submissions record. */
export interface DisputeSettingsActor {
  userId: string | null;
  email: string;
  now: Date;
}

/** Stripe's limit on an evidence text field, which the description becomes. */
export const DISPUTE_PRODUCT_DESCRIPTION_ERROR = `Keep the product description under ${formatCount(DISPUTE_PRODUCT_DESCRIPTION_MAX_LENGTH)} characters.`;

/** A blank description is stored as null, so the reader's "not set" is one value. */
export async function applyDisputeSettings(
  db: Db,
  accountId: string,
  input: { productDescription: unknown; shipsPhysical: unknown; autoSubmit: unknown },
  actor: DisputeSettingsActor,
  trace?: WriteTrace,
): Promise<ApplyResult<DisputeSettingsState>> {
  const productDescription = asOptionalText(input.productDescription);
  if (productDescription && productDescription.length > DISPUTE_PRODUCT_DESCRIPTION_MAX_LENGTH) {
    return { ok: false, error: DISPUTE_PRODUCT_DESCRIPTION_ERROR };
  }
  const state: DisputeSettingsState = {
    productDescription,
    shipsPhysical: asBoolean(input.shipsPhysical),
    autoSubmit: asBoolean(input.autoSubmit),
  };
  const [current] = await db
    .select({ autoSubmit: accounts.disputeAutoSubmit, at: accounts.disputeAutoSubmitAt })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  const alreadyOptedIn = current?.autoSubmit === true && current.at != null;
  const fields = ["dispute_product_description", "dispute_ships_physical", "dispute_auto_submit"];
  const optIn = !state.autoSubmit
    ? { disputeAutoSubmitByUserId: null, disputeAutoSubmitByEmail: null, disputeAutoSubmitAt: null }
    : alreadyOptedIn
      ? {}
      : {
          disputeAutoSubmitByUserId: actor.userId,
          disputeAutoSubmitByEmail: actor.email,
          disputeAutoSubmitAt: actor.now,
        };
  await commit(
    db,
    accountId,
    fields,
    db
      .update(accounts)
      .set({
        disputeProductDescription: state.productDescription,
        disputeShipsPhysical: state.shipsPhysical,
        disputeAutoSubmit: state.autoSubmit,
        ...optIn,
      })
      .where(eq(accounts.id, accountId)),
    trace,
  );
  return { ok: true, fields, state };
}

/** The Disputes on/off switch. */
export async function applyDisputesEnabled(
  db: Db,
  accountId: string,
  input: { enabled: unknown },
  trace?: WriteTrace,
): Promise<ApplyResult<{ enabled: boolean }>> {
  const state = { enabled: asBoolean(input.enabled) };
  const fields = ["disputes_enabled"];
  await commit(
    db,
    accountId,
    fields,
    db.update(accounts).set({ disputesEnabled: state.enabled }).where(eq(accounts.id, accountId)),
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
 * The six controls the notifications page renders. An agent pasting an attacker's URL gets the same
 * sentence a person would.
 */
export async function applyNotificationSettings(
  env: Env,
  db: Db,
  accountId: string,
  input: Record<string, unknown>,
  trace?: WriteTrace,
): Promise<ApplyResult<NotificationSettingsState>> {
  const webhook = normalizeSlackWebhookUrl(
    typeof input.slackWebhookUrl === "string" ? input.slackWebhookUrl : "",
  );
  if (!webhook.ok) return { ok: false, error: webhook.error };
  const email = asNotificationEmail(input.notificationEmail);
  if (!email.ok) return email;

  const state: NotificationSettingsState = {
    notificationEmail: email.value,
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
  // The column holds the URL sealed (slack-webhook-secret.server.ts); the
  // returned state keeps what the caller sent.
  const stored = { ...state, slackWebhookUrl: await sealSlackWebhook(env, state.slackWebhookUrl) };
  await commit(
    db,
    accountId,
    fields,
    buildNotificationSettingsUpdate(db, accountId, stored),
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
 * The three merchant-context fields the Intelligence card writes. All three are set once and
 * forgotten, the form posts all three every time so nothing changes for it, and an agent updating
 * only the industry must not blank the other two. `alongside` is statements the CALLER builds and
 * wants committed in the same batch, after this write: the account page saves the name with these
 * three as one form, so a failed name write must not leave the context saved.
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
  alongside: BatchItem<"sqlite">[] = [],
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
    const industry = asLabel(input.merchantIndustry, "the industry");
    if (!industry.ok) return industry;
    fields.push("merchant_industry");
    state.merchantIndustry = industry.value;
  }
  if (input.primaryCustomerType !== undefined) {
    const type = asLabel(input.primaryCustomerType, "the customer type");
    if (!type.ok) return type;
    fields.push("primary_customer_type");
    state.primaryCustomerType = type.value;
  }
  if (input.merchantMrrSelfReported !== undefined) {
    const raw =
      typeof input.merchantMrrSelfReported === "number"
        ? String(input.merchantMrrSelfReported)
        : typeof input.merchantMrrSelfReported === "string"
          ? input.merchantMrrSelfReported
          : "";
    const cents = parseMoneyInput(raw, "usd");
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
