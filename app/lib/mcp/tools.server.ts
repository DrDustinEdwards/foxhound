import { getAuditRun, listAuditRuns } from "~/lib/audit/persist.server";
import { toStoredAuditRun } from "~/lib/audit/render";
import { getIntelligenceOverview } from "~/lib/intelligence/views.server";
import { getGlobalPaymentStatusCounts } from "~/lib/recovery/queries.server";
import { readAccountAuditSettings } from "~/lib/settings/audit-settings.server";
import { listAccountConnections } from "~/lib/settings/queries.server";

import { defineToolRegistry, type McpTool, type McpToolRegistry, ToolInputError } from "./registry";
import {
  result,
  READ,
  stringArg,
  CURSOR_PROPERTY,
  decodeOffsetCursor,
  slicePage,
} from "./tool-input";
import { LIST_PAYMENTS_TOOL, GET_PAYMENT_TOOL, GET_RECOVERY_TOOL } from "./tools-recovery.server";
import {
  LIST_CUSTOMERS_TOOL,
  GET_CUSTOMER_TOOL,
  GET_INTELLIGENCE_TOOL,
} from "./tools-intelligence.server";
import { LIST_DISPUTES_TOOL } from "./tools-disputes.server";
import { GET_BILLING_TOOL } from "./tools-billing.server";
import { GET_SETTINGS_TOOL, UPDATE_SETTINGS_TOOL } from "./tools-settings.server";
import { MANAGE_ALERTS_TOOL } from "./tools-alerts.server";

// The merchant tools: twelve whole-job tools named foxhound_{action}_{resource}, ten read and two write, each with all
// four behavior hints set honestly. Read and write are never one tool. Design: capsid/research/design-mcp-servers.md
// section 5; foxhound_get_settings gives every writer a reader.
// The account comes from the key and nowhere else: each executor receives the account the bearer token resolved to,
// and no tool takes an account id as an argument. Every id an agent passes is proved to be this account's (rule 12.1):
// the helpers pin the account in their own predicate, so another merchant's id reads as "not found";
// test/mcp-ownership.test.ts plants another merchant's row behind every id-taking argument.
// No money tool exists here and none will: the HUMAN-FOREVER denylist in ./registry.ts refuses one at construction;
// nothing imports `executeMoneyWrite`, `recordOutcome`, a billing writer or a dispute writer.
// Redaction is default-on and not in this file: registering a tool redacts it (./redact.ts). A tool chooses WHICH
// fields to return, never disguises one.

const AUDIT_RUN_PAGE_SIZE = 12;
/** The audit-run history window; the helper takes a limit, not an offset, so pages are cut from this many newest runs. */
const AUDIT_RUN_HISTORY_LIMIT = 120;

const OVERVIEW_TOOL: McpTool = {
  name: "foxhound_get_overview",
  title: "Account overview",
  description:
    "Start here. Read this account's recurring-revenue overview (MRR, movement, customer counts, the latest report summary), the failed-payment counts by recovery status, and the Stripe accounts connected to it. Access tokens are never returned, and nothing can be connected or disconnected here.",
  inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] },
  outputSchema: result(["overview", "payment_status_counts", "connections"], []),
  annotations: READ,
  scope: "read",
  execute: async (ctx) => {
    const [overview, payment_status_counts, connections] = await Promise.all([
      getIntelligenceOverview(ctx.db, ctx.accountId, { forAgent: true }),
      getGlobalPaymentStatusCounts(ctx.db, ctx.accountId),
      listAccountConnections(ctx.db, ctx.accountId),
    ]);
    return { overview, payment_status_counts, connections };
  },
};

const REVIEW_AUDITS_TOOL: McpTool = {
  name: "foxhound_review_audits",
  title: "Review audits",
  description:
    "Read this account's audit settings and its stored audit runs, newest first, with each scope's figures or null where a scope could not be read. Pass run_id for one run in full. Paginated, 12 a page: pass next_cursor back to read on.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      run_id: {
        type: "string",
        description: "One audit run's id, from an earlier answer. Omit to list runs.",
      },
      cursor: CURSOR_PROPERTY,
    },
    required: [],
  },
  outputSchema: result(["run", "settings", "runs", "total", "has_more", "next_cursor"], []),
  annotations: READ,
  scope: "read",
  execute: async (ctx, args) => {
    const tool = "foxhound_review_audits";
    const runId = stringArg(args, "run_id");
    if (runId !== null) {
      const row = await getAuditRun(ctx.db, ctx.accountId, runId);
      if (!row) {
        throw new ToolInputError(
          `No audit run ${runId} on this account. Omit run_id to list this account's runs.`,
        );
      }
      return { run: toStoredAuditRun(row) };
    }
    const page = decodeOffsetCursor(tool, args);
    const [settings, rows] = await Promise.all([
      readAccountAuditSettings(ctx.db, ctx.accountId),
      listAuditRuns(ctx.db, ctx.accountId, AUDIT_RUN_HISTORY_LIMIT),
    ]);
    const { items, ...rest } = slicePage(tool, rows, page, AUDIT_RUN_PAGE_SIZE);
    return { settings, runs: items.map(toStoredAuditRun), ...rest };
  },
};

const READ_TOOLS: McpTool[] = [
  OVERVIEW_TOOL,
  LIST_PAYMENTS_TOOL,
  GET_PAYMENT_TOOL,
  LIST_CUSTOMERS_TOOL,
  GET_CUSTOMER_TOOL,
  GET_INTELLIGENCE_TOOL,
  GET_RECOVERY_TOOL,
  LIST_DISPUTES_TOOL,
  REVIEW_AUDITS_TOOL,
  GET_BILLING_TOOL,
  GET_SETTINGS_TOOL,
];

const WRITE_TOOLS: McpTool[] = [UPDATE_SETTINGS_TOOL, MANAGE_ALERTS_TOOL];

/** The live registry. `defineToolRegistry` runs the HUMAN-FOREVER denylist and name rule over every name at module load
 *  and wraps every executor in the redactor. */
export const MERCHANT_TOOLS: McpToolRegistry = defineToolRegistry([...READ_TOOLS, ...WRITE_TOOLS]);

export const MERCHANT_TOOL_NAMES = [...READ_TOOLS, ...WRITE_TOOLS].map((t) => t.name);
export const MERCHANT_WRITE_TOOL_NAMES = WRITE_TOOLS.map((t) => t.name);
