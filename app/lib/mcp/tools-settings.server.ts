import { readVoiceSamples } from "~/lib/recovery/voice-samples";
import { readAccountAuditSettings } from "~/lib/settings/audit-settings.server";
import {
  applyAuditSettings,
  applyFeatureSettings,
  applyIntelligenceContext,
  applyNotificationSettings,
  type NotificationSettingsState,
} from "~/lib/settings/apply.server";
import { applyBrandVoice, applySenderName } from "~/lib/settings/apply-sender-voice.server";
import {
  getAccount,
  getMerchantContext,
  getPrimaryBrandVoices,
  getPrimarySenderConnection,
  listAccountConnections,
} from "~/lib/settings/queries.server";

import {
  CONFIRM_ARGUMENT,
  CONFIRM_PROPERTY,
  CONFIRM_RESULT_FIELDS,
  confirmationNeeded,
} from "./confirm.server";
import { type McpTool, type McpToolContext, ToolInputError } from "./registry";
import { result, READ, applied, type ToolArgs } from "./tool-input";

// The reader for every setting foxhound_update_settings writes: a writer an agent cannot read first forces it to guess.
// Each section returns the fields its writer takes, so read-then-write round-trips.
export const GET_SETTINGS_TOOL: McpTool = {
  name: "foxhound_get_settings",
  title: "Read settings",
  description:
    "Read every setting foxhound_update_settings can change: audit window, the two engine toggles, notification email and toggles, the connected Stripe accounts, the primary connection's sender name and brand voice, and the business context the email writer is given. The Slack webhook URL is never returned, only whether one is set.",
  inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] },
  outputSchema: result(
    [
      "audit",
      "features",
      "notifications",
      "connections",
      "sender",
      "brand_voice",
      "intelligence_context",
    ],
    ["features", "notifications"],
  ),
  annotations: READ,
  scope: "read",
  execute: async (ctx) => {
    const [account, audit, connections, sender, voices, intelligence_context] = await Promise.all([
      getAccount(ctx.db, ctx.accountId),
      readAccountAuditSettings(ctx.db, ctx.accountId),
      listAccountConnections(ctx.db, ctx.accountId),
      getPrimarySenderConnection(ctx.db, ctx.accountId),
      getPrimaryBrandVoices(ctx.db, ctx.accountId),
      getMerchantContext(ctx.db, ctx.accountId),
    ]);
    // Voice samples are left out: the merchant's past emails name customers, are one JSON string the field redactor cannot
    // see into, and no writer here takes them back.
    const brand_voice =
      voices === null
        ? null
        : {
            id: voices.id,
            general: voices.general,
            soft: voices.soft,
            expired: voices.expired,
            network: voices.network,
            fraud: voices.fraud,
            // Counts only: the samples name customers, so the text stays in the app.
            sample_count: readVoiceSamples(voices.samples).length,
            sample_characters: readVoiceSamples(voices.samples).map((x) => x.length),
          };
    return {
      audit,
      features: {
        winbackNotificationsEnabled: account?.winbackNotificationsEnabled ?? null,
        expiringCardNotificationsEnabled: account?.expiringCardNotificationsEnabled ?? null,
      },
      notifications: {
        notificationEmail: account?.notificationEmail ?? null,
        slackWebhookConfigured: Boolean(account?.slackWebhookUrl),
        slackNotificationsEnabled: account?.slackNotificationsEnabled ?? null,
        digestEnabled: account?.digestEnabled ?? null,
        recoveryNotificationsEnabled: account?.recoveryNotificationsEnabled ?? null,
        sequenceCompleteNotificationsEnabled: account?.sequenceCompleteNotificationsEnabled ?? null,
      },
      connections,
      sender,
      brand_voice,
      intelligence_context,
    };
  },
};

// The two writes. Every write goes through the form's own code path (the same `applyX` the route action calls: same
// bounds, allowlist and refusal string). Every write leaves a trace: a `WriteTrace` with the api key id and tool name goes
// in the SAME batch as the write. One section per call, so each call is one form's batch and all-or-nothing.

/** Copy only the keys the agent sent, renamed, so an omitted key stays omitted: `{ general: args.general ?? "" }` would
 *  silently and unrecoverably clear the column on every call that left it out. */
function sentOnly(section: ToolArgs, names: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [from, to] of Object.entries(names)) {
    if (section[from] !== undefined) out[to] = section[from];
  }
  return out;
}

function withoutWebhookUrl(result: Parameters<typeof applied<NotificationSettingsState>>[0]) {
  const { updated, state } = applied(result);
  const { slackWebhookUrl, ...rest } = state;
  return { updated, state: { ...rest, slackWebhookConfigured: Boolean(slackWebhookUrl) } };
}

/** Refuse a connection id that is not this account's, in words an agent can act on, before the writer runs. The writers
 *  prove ownership too, but refuse with the settings form's "Connect Stripe before setting a sender name.", which
 *  misleads an agent that sent a bad id. A second check, not the only one. */
async function requireOwnConnection(ctx: McpToolContext, section: ToolArgs): Promise<void> {
  const connectionId = section.connection_id;
  if (typeof connectionId !== "string" || connectionId.length === 0) return;
  const own = await listAccountConnections(ctx.db, ctx.accountId);
  if (!own.some((connection) => connection.id === connectionId)) {
    throw new ToolInputError(
      `Connection ${connectionId} is not one of this account's Stripe connections. Take a connection id from foxhound_get_settings.`,
    );
  }
}

type SettingsSection = (ctx: McpToolContext, section: ToolArgs) => Promise<unknown>;

const SETTINGS_SECTIONS: Record<string, SettingsSection> = {
  audit: async (ctx, s) =>
    applied(
      await applyAuditSettings(
        ctx.db,
        ctx.accountId,
        { lookbackDays: s.lookback_days, autoRun: s.auto_run },
        ctx.trace,
      ),
    ),
  features: async (ctx, s) =>
    applied(
      await applyFeatureSettings(
        ctx.db,
        ctx.accountId,
        {
          winbackNotificationsEnabled: s.winback_notifications_enabled,
          expiringCardNotificationsEnabled: s.expiring_card_notifications_enabled,
        },
        ctx.trace,
      ),
    ),
  // The webhook URL is a credential for the merchant's Slack, so the answer says whether one is set and never echoes it.
  notifications: async (ctx, s) =>
    withoutWebhookUrl(
      await applyNotificationSettings(
        ctx.env,
        ctx.db,
        ctx.accountId,
        {
          notificationEmail: s.notification_email,
          slackWebhookUrl: s.slack_webhook_url ?? "",
          slackNotificationsEnabled: s.slack_notifications_enabled,
          digestEnabled: s.digest_enabled,
          recoveryNotificationsEnabled: s.recovery_notifications_enabled,
          sequenceCompleteNotificationsEnabled: s.sequence_complete_notifications_enabled,
        },
        ctx.trace,
      ),
    ),
  sender_name: async (ctx, s) => {
    await requireOwnConnection(ctx, s);
    return applied(
      await applySenderName(
        ctx.db,
        ctx.accountId,
        { connectionId: s.connection_id, senderName: s.sender_name },
        ctx.trace,
      ),
    );
  },
  // This text lands in the system prompt that writes recovery emails. Not sanitized on the way in, as the form does not:
  // `sanitizeCopy` and `passesQualityGate` run on what comes out.
  brand_voice: async (ctx, s) => {
    await requireOwnConnection(ctx, s);
    const done = applied(
      await applyBrandVoice(
        ctx.db,
        ctx.accountId,
        {
          connectionId: s.connection_id,
          ...sentOnly(s, {
            general: "general",
            soft: "soft",
            expired: "expired",
            network: "network",
            fraud: "fraud",
            samples: "samples",
          }),
        },
        ctx.trace,
      ),
    );
    // The samples were written but are not echoed: they name customers, so the answer carries counts only.
    const { samples, ...state } = done.state;
    return {
      ...done,
      state: {
        ...state,
        sample_count: samples.length,
        sample_characters: samples.map((x) => x.length),
      },
    };
  },
  intelligence_context: async (ctx, s) =>
    applied(
      await applyIntelligenceContext(
        ctx.db,
        ctx.accountId,
        sentOnly(s, {
          merchant_industry: "merchantIndustry",
          primary_customer_type: "primaryCustomerType",
          merchant_mrr_self_reported: "merchantMrrSelfReported",
        }),
        ctx.trace,
      ),
    ),
};

const SECTION_NAMES = Object.keys(SETTINGS_SECTIONS);

/** What a settings call would do, in words the merchant can approve. A Slack webhook URL is a credential: named, never shown. */
function describeSettingsChange(name: string, section: ToolArgs): string {
  const shown = Object.entries(section).map(([field, value]) =>
    field === "slack_webhook_url"
      ? `${field}: ${value ? "a new Slack webhook URL" : "cleared"}`
      : `${field}: ${JSON.stringify(value)}`,
  );
  const cleared =
    name === "notifications" && section.slack_webhook_url === undefined
      ? ["slack_webhook_url: cleared"]
      : [];
  return `Overwrite the ${name} settings with ${[...shown, ...cleared].join(", ") || "nothing"}.${
    name === "notifications"
      ? " Every notification field is replaced, and clearing the email turns every notification off."
      : ""
  }`;
}

export const UPDATE_SETTINGS_TOOL: McpTool = {
  name: "foxhound_update_settings",
  title: "Change settings",
  description:
    "Change one group of this account's settings per call: send exactly one of audit, features, notifications, sender_name, brand_voice or intelligence_context. Read the current values first with foxhound_get_settings. Values overwrite what is there: in notifications every field is replaced and an omitted Slack webhook is cleared; in brand_voice and intelligence_context an omitted field is left alone and an empty string clears it. Connection ids come from foxhound_get_settings and must belong to this account. Every change is confirmed first: the first call changes nothing and answers what it would change and a confirm code; show that to the merchant and call again with the same arguments and confirm only if they say yes.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      audit: {
        type: "object",
        description: "The audit window and the monthly audit report.",
        properties: {
          lookback_days: {
            type: "integer",
            description: "30, 60, 90 or 180. Other values clamp.",
          },
          auto_run: { type: "boolean", description: "Send the monthly audit report." },
        },
        required: ["lookback_days", "auto_run"],
      },
      features: {
        type: "object",
        description:
          "Switch the win-back and expiring-card engines on or off (the engines, not the notifications about them).",
        properties: {
          winback_notifications_enabled: { type: "boolean" },
          expiring_card_notifications_enabled: { type: "boolean" },
        },
        required: ["winback_notifications_enabled", "expiring_card_notifications_enabled"],
      },
      notifications: {
        type: "object",
        description:
          "Notification email, Slack webhook and the four notification toggles. Every field is replaced. Clearing the email turns every notification off.",
        properties: {
          notification_email: { type: "string", description: "Empty or omitted clears it." },
          slack_webhook_url: {
            type: "string",
            description:
              "Must be on https://hooks.slack.com/. Empty or omitted clears it; send it again to keep it.",
          },
          slack_notifications_enabled: { type: "boolean" },
          digest_enabled: { type: "boolean" },
          recovery_notifications_enabled: { type: "boolean" },
          sequence_complete_notifications_enabled: { type: "boolean" },
        },
        required: [],
      },
      sender_name: {
        type: "object",
        description: "The From name on one connection's recovery emails.",
        properties: {
          connection_id: { type: "string", description: "From foxhound_get_settings." },
          sender_name: {
            type: "string",
            description: "Up to 80 characters. Empty clears it and mail goes out from Support.",
          },
        },
        required: ["connection_id"],
      },
      brand_voice: {
        type: "object",
        description:
          "The tone Foxhound writes one connection's recovery emails in: free-form guidance for the writer, not a template, and optionally the merchant's own past emails as samples.",
        properties: {
          connection_id: { type: "string", description: "From foxhound_get_settings." },
          general: {
            type: "string",
            description: "The voice for every category with no override.",
          },
          soft: {
            type: "string",
            description: "Soft declines: insufficient funds and the like.",
          },
          expired: { type: "string", description: "Expired card." },
          network: { type: "string", description: "Network and issuer declines." },
          fraud: { type: "string", description: "Suspected fraud." },
          samples: {
            type: "array",
            items: { type: "string" },
            maxItems: 5,
            description:
              "Up to five past emails the merchant wrote themselves, up to 3,000 characters each, that the writer matches in length, greeting and sign-off. Replaces the stored samples; an empty list clears them. The merchant supplies the text. They are never read back: foxhound_get_settings reports only how many there are and how long.",
          },
        },
        required: ["connection_id"],
      },
      intelligence_context: {
        type: "object",
        description: "What kind of business this is. The recovery-email writer is given these.",
        properties: {
          merchant_industry: { type: "string", description: 'For example "B2B SaaS".' },
          primary_customer_type: {
            type: "string",
            description: 'For example "small businesses".',
          },
          merchant_mrr_self_reported: {
            type: ["number", "string"],
            description:
              "US dollars, not cents. foxhound_get_settings reports it in cents as merchantMrrSelfReportedCents, so divide by 100 before sending it back. Empty clears it.",
          },
        },
        required: [],
      },
      [CONFIRM_ARGUMENT]: CONFIRM_PROPERTY,
    },
    required: [],
  },
  // Destructive because a value is overwritten and clearing the notification email silences every notification, so it is
  // confirmed first (./confirm.server.ts). Idempotent: the same call twice leaves the same settings.
  outputSchema: result(["section", "updated", "state", ...CONFIRM_RESULT_FIELDS, "note"], []),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  scope: "write",
  execute: async (ctx, args) => {
    const sent = SECTION_NAMES.filter((name) => args[name] !== undefined);
    if (sent.length !== 1) {
      throw new ToolInputError(
        `Send exactly one of ${SECTION_NAMES.join(", ")}; this call sent ${sent.length === 0 ? "none" : sent.join(" and ")}. Make one call per group.`,
      );
    }
    const name = sent[0];
    const section = args[name];
    if (!section || typeof section !== "object" || Array.isArray(section)) {
      throw new ToolInputError(`${name} must be an object of that group's fields.`);
    }
    const pending = await confirmationNeeded(
      ctx,
      "foxhound_update_settings",
      args,
      describeSettingsChange(name, section as ToolArgs),
    );
    if (pending) return pending;
    return {
      section: name,
      ...((await SETTINGS_SECTIONS[name](ctx, section as ToolArgs)) as object),
    };
  },
};
