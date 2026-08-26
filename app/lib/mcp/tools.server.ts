import { getAuditRun, listAuditRuns } from "~/lib/audit/persist.server";
import { toStoredAuditRun } from "~/lib/audit/render";
import { getBillingPreview } from "~/lib/billing/preview.server";
import { getBillingLedger, listBillingInvoices } from "~/lib/billing/queries.server";
import { listDisputes } from "~/lib/disputes/queries.server";
import {
  getAlertsView,
  getChurnView,
  getCustomerHealthDetail,
  getIntelligenceOverview,
  listCustomerDirectory,
  listCustomerTiers,
} from "~/lib/intelligence/views.server";
import { listFailedPayments } from "~/lib/recovery/queries.server";
import { readAccountAuditSettings } from "~/lib/settings/audit-settings.server";
import { listAccountConnections } from "~/lib/settings/queries.server";

import { redactCustomerFields, redactPaymentFields } from "./redact";
import {
  defineToolRegistry,
  type McpTool,
  type McpToolContext,
  type McpToolRegistry,
} from "./registry";

// THE THIRTEEN READ TOOLS (370 Table 5, ruled at 371). Every one wraps a helper
// that already existed and was already account-scoped; this file is transport,
// not logic, which is what made the two-session estimate hold.
//
// THE ACCOUNT COMES FROM THE KEY AND NOWHERE ELSE. Each executor receives the
// account the bearer token resolved to and passes it to the helper. No tool
// takes an account id as an argument, and that is the design rather than an
// omission: an argument would be a thing an agent could be talked into changing,
// and the helpers all pin the account in their own predicates anyway, so the two
// layers agree by construction.
//
// READ ONLY, ENFORCED THREE WAYS. Every helper below is a SELECT; the registry's
// denylist refuses any name that smells like a write (368 ruling 4); and no
// executor here imports `executeMoneyWrite`, `recordOutcome` or a billing
// writer. A plant sweeps this file for all three.
//
// REDACTION IS DEFAULT-ON FOR THE THREE PII TOOLS (370). `list_customers`,
// `get_customer_health` and `list_failed_payments` return the customer id and a
// masked email and never a name. See ./redact.ts for what the ruling was and why
// the line falls there.

type ToolArgs = Record<string, unknown>;

/**
 * THE ONE PAGINATION SHAPE, stated here and reused by every tool that paginates,
 * so an agent learns it once. Helpers differ in whether they take a page number
 * or a row limit, and that difference is theirs; what an agent sees is the same
 * two optional integers everywhere.
 */
const PAGE_PROPERTIES = {
  page: { type: "integer", minimum: 1, description: "1-based page number. Defaults to 1." },
  limit: {
    type: "integer",
    minimum: 1,
    maximum: 100,
    description: "Maximum rows to return. Defaults to the helper's own page size.",
  },
} as const;

const EMPTY_SCHEMA = { type: "object" as const, properties: {}, required: [] as string[] };

function intArg(args: ToolArgs, name: string, fallback: number, max: number): number {
  const raw = args[name];
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) return fallback;
  return Math.min(raw, max);
}

function stringArg(args: ToolArgs, name: string): string | null {
  const raw = args[name];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/** A tool that took a required argument and did not get it. Returned as a tool
 *  error rather than thrown, so the agent can correct itself. */
class ToolInputError extends Error {}

function required(args: ToolArgs, name: string): string {
  const value = stringArg(args, name);
  if (value === null) throw new ToolInputError(`Missing required argument: ${name}`);
  return value;
}

// ---------------------------------------------------------------------------
// The thirteen
// ---------------------------------------------------------------------------

const TOOLS: McpTool[] = [
  {
    name: "list_audit_runs",
    description:
      "List this account's stored audit runs, newest first, with each scope's figures or null where a scope could not be read on that run.",
    inputSchema: { type: "object", properties: { limit: PAGE_PROPERTIES.limit }, required: [] },
    execute: async (ctx, args) => {
      const rows = await listAuditRuns(ctx.db, ctx.accountId, intArg(args, "limit", 24, 100));
      return { runs: rows.map(toStoredAuditRun) };
    },
  },
  {
    name: "get_audit_run",
    description:
      "Fetch one stored audit run by id. Returns null figures for any scope that could not be read, never a zero standing in for unknown.",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "string", description: "The audit run's id." } },
      required: ["run_id"],
    },
    execute: async (ctx, args) => {
      const row = await getAuditRun(ctx.db, ctx.accountId, required(args, "run_id"));
      return { run: row ? toStoredAuditRun(row) : null };
    },
  },
  {
    name: "get_audit_settings",
    description:
      "Read this account's audit lookback window and whether the monthly audit report is switched on. Cannot change them.",
    inputSchema: EMPTY_SCHEMA,
    execute: async (ctx) => readAccountAuditSettings(ctx.db, ctx.accountId),
  },
  {
    name: "get_intelligence_overview",
    description:
      "Read the account's recurring-revenue overview: MRR, movement, customer counts and the latest report summary.",
    inputSchema: EMPTY_SCHEMA,
    execute: async (ctx) => getIntelligenceOverview(ctx.db, ctx.accountId),
  },
  {
    name: "get_churn",
    description:
      "Read churn bands, the churn chart series and the highest-risk customers for this account.",
    inputSchema: EMPTY_SCHEMA,
    execute: async (ctx) => getChurnView(ctx.db, ctx.accountId, ctx.now.getTime()),
  },
  {
    name: "list_customers",
    description:
      "List this account's customers with health, tier and MRR. Customer names are never returned and emails are masked; the Stripe customer id is the key for follow-up calls.",
    inputSchema: {
      type: "object",
      properties: {
        ...PAGE_PROPERTIES,
        search: { type: "string", description: "Match against the customer id or email." },
        tier: { type: "string", description: "Filter to one plan tier." },
      },
      required: [],
    },
    execute: async (ctx, args) => {
      const result = await listCustomerDirectory(ctx.db, ctx.accountId, {
        search: stringArg(args, "search"),
        tier: stringArg(args, "tier"),
        healthBand: null,
        sort: "health_asc",
        page: intArg(args, "page", 1, 10_000),
      });
      return { ...result, customers: result.customers.map(redactCustomerFields) };
    },
  },
  {
    name: "get_customer_health",
    description:
      "Read one customer's health score, its factors and its history. The name is never returned and the email is masked.",
    inputSchema: {
      type: "object",
      properties: {
        stripe_customer_id: { type: "string", description: "The Stripe customer id." },
      },
      required: ["stripe_customer_id"],
    },
    execute: async (ctx, args) => {
      const detail = await getCustomerHealthDetail(
        ctx.db,
        ctx.accountId,
        required(args, "stripe_customer_id"),
      );
      return { customer: detail ? redactCustomerFields(detail) : null };
    },
  },
  {
    name: "list_customer_tiers",
    description: "List the distinct plan tiers present on this account's customers.",
    inputSchema: EMPTY_SCHEMA,
    execute: async (ctx) => ({ tiers: await listCustomerTiers(ctx.db, ctx.accountId) }),
  },
  {
    name: "get_alerts",
    description:
      "Read this account's configured metric alerts and their recent firings. Cannot create, enable or delete one.",
    inputSchema: EMPTY_SCHEMA,
    execute: async (ctx) => getAlertsView(ctx.db, ctx.accountId),
  },
  {
    name: "list_failed_payments",
    description:
      "List this account's failed payments with amounts, decline categories and recovery status. Customer emails are masked and no name is returned.",
    inputSchema: {
      type: "object",
      properties: { limit: PAGE_PROPERTIES.limit },
      required: [],
    },
    execute: async (ctx, args) => {
      const rows = await listFailedPayments(ctx.db, ctx.accountId);
      const limit = intArg(args, "limit", 50, 100);
      return { payments: rows.slice(0, limit).map(redactPaymentFields), total: rows.length };
    },
  },
  {
    name: "list_disputes",
    description:
      "List this account's disputes with their state, amount and deadline. Cannot submit evidence or approve a submission.",
    inputSchema: { type: "object", properties: { limit: PAGE_PROPERTIES.limit }, required: [] },
    execute: async (ctx, args) => {
      const rows = await listDisputes(ctx.db, ctx.accountId);
      const limit = intArg(args, "limit", 50, 100);
      return { disputes: rows.slice(0, limit), total: rows.length };
    },
  },
  {
    name: "get_billing",
    description:
      "Read this account's own Foxhound billing: the attributed-recovery ledger, past invoices and the next run's preview. Cannot issue, pay or void anything.",
    inputSchema: EMPTY_SCHEMA,
    execute: async (ctx) => {
      const [ledger, invoices, preview] = await Promise.all([
        getBillingLedger(ctx.db, ctx.accountId),
        listBillingInvoices(ctx.db, ctx.accountId),
        getBillingPreview(ctx.db, ctx.accountId, ctx.now.getTime()),
      ]);
      return { ledger, invoices, preview };
    },
  },
  {
    name: "list_connections",
    description:
      "List the Stripe accounts connected to this Foxhound account, with their names and live state. Access tokens are never returned and cannot be connected or disconnected here.",
    inputSchema: EMPTY_SCHEMA,
    execute: async (ctx) => ({
      connections: await listAccountConnections(ctx.db, ctx.accountId),
    }),
  },
];

/** The live registry. Built through `defineToolRegistry`, so the HUMAN-FOREVER
 *  denylist runs over these thirteen names at module load. */
export const MERCHANT_TOOLS: McpToolRegistry = defineToolRegistry(TOOLS);

/** The tool names, exported so a plant can assert the set without re-listing it. */
export const MERCHANT_TOOL_NAMES = TOOLS.map((t) => t.name);

export { ToolInputError };
export type { McpToolContext };
