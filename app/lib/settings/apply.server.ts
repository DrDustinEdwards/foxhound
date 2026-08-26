import { and, eq } from "drizzle-orm";

import type { Db } from "~/db";
import { accounts, mcpWrites, stripeConnections } from "~/db";

import { normalizeLookback } from "./audit-settings";
import {
  buildFeatureSettingsUpdate,
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

/** Run the write, plus its trace when there is one, as one batch. */
async function commit(
  db: Db,
  accountId: string,
  fields: string[],
  statement: unknown,
  trace: WriteTrace | undefined,
) {
  const statements = trace
    ? [statement, traceInsert(db, accountId, fields, trace)]
    : [statement];
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
