import { applyAlertConfig, applyAlertCreate } from "~/lib/settings/apply-alerts.server";

import {
  CONFIRM_ARGUMENT,
  CONFIRM_PROPERTY,
  CONFIRM_RESULT_FIELDS,
  confirmationNeeded,
} from "./confirm.server";
import { type McpTool, ToolInputError } from "./registry";
import { result, required, applied } from "./tool-input";

const ALERT_ACTIONS = ["create", "enable", "disable", "delete"] as const;

export const MANAGE_ALERTS_TOOL: McpTool = {
  name: "foxhound_manage_alerts",
  title: "Manage alerts",
  // Deletion is named because it takes the alert's firing history with it, unrecoverably.
  description:
    "Create, enable, disable or delete one of this account's metric alerts. action create takes metric, direction and threshold (dollars for amount metrics, a percent for the recovery rate, a plain count otherwise), an optional label and an optional channel (email, the default, or slack); enable, disable and delete take alert_id from foxhound_get_intelligence, which must belong to this account. Deleting also removes that alert's recorded breaches. A breach is recorded in the app and sent to the alert's channel at most once a day. delete is confirmed first: the first call deletes nothing and answers what it would delete and a confirm code; show that to the merchant and call again with the same arguments and confirm only if they say yes.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: [...ALERT_ACTIONS], description: "What to do." },
      alert_id: {
        type: "string",
        description: "For enable, disable and delete: from foxhound_get_intelligence.",
      },
      metric: {
        type: "string",
        description: "For create: one of the metrics foxhound_get_intelligence reports.",
      },
      direction: {
        type: "string",
        description: "For create: whether the metric rising or dropping fires.",
      },
      threshold: {
        type: ["number", "string"],
        description: "For create: dollars for amount metrics, a plain count otherwise.",
      },
      label: { type: "string", description: "For create: an optional name for the alert." },
      channel: {
        type: "string",
        enum: ["email", "slack"],
        description: "For create: where a breach is sent. Defaults to email.",
      },
      [CONFIRM_ARGUMENT]: {
        ...CONFIRM_PROPERTY,
        description: `For delete. ${CONFIRM_PROPERTY.description}`,
      },
    },
    required: ["action"],
  },
  // Destructive because delete is, so confirmed first (./confirm.server.ts); not idempotent because create makes a new alert each time.
  outputSchema: result(["action", "updated", "state", ...CONFIRM_RESULT_FIELDS, "note"], []),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  scope: "write",
  execute: async (ctx, args) => {
    const action = args["action"];
    if (action === "create") {
      if (args["alert_id"] !== undefined) {
        throw new ToolInputError(
          "create makes a new alert and takes no alert_id. Drop alert_id, or use enable, disable or delete.",
        );
      }
      return {
        action,
        ...applied(
          await applyAlertCreate(
            ctx.db,
            ctx.accountId,
            {
              metric: args.metric,
              direction: args.direction,
              threshold: args.threshold,
              label: args.label,
              channel: args.channel,
            },
            ctx.now,
            ctx.trace,
          ),
        ),
      };
    }
    if (action === "enable" || action === "disable" || action === "delete") {
      const alertId = required(args, "alert_id", "Take one from foxhound_get_intelligence.");
      if (action === "delete") {
        const pending = await confirmationNeeded(
          ctx,
          "foxhound_manage_alerts",
          args,
          `Delete alert ${alertId} and every breach recorded for it. This cannot be undone.`,
        );
        if (pending) return pending;
      }
      return {
        action,
        ...applied(
          await applyAlertConfig(
            ctx.db,
            ctx.accountId,
            {
              alertId: args.alert_id,
              enabled: action === "enable",
              deleted: action === "delete",
            },
            ctx.trace,
          ),
        ),
      };
    }
    throw new ToolInputError(`action must be one of ${ALERT_ACTIONS.join(", ")}.`);
  },
};
