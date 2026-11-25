import {
  getAlertsView,
  getCustomerHealthDetail,
  getReportsArchive,
} from "~/lib/intelligence/views.server";
import {
  listActionableRecommendations,
  RECOMMENDATIONS_PAGE_SIZE,
} from "~/lib/intelligence/recommendations.server";
import { getChurnView } from "~/lib/intelligence/trends.server";
import { listCustomerDirectory, listCustomerTiers } from "~/lib/intelligence/directory.server";

import { type McpTool, ToolInputError } from "./registry";
import {
  result,
  READ,
  stringArg,
  required,
  CURSOR_PROPERTY,
  decodeOffsetCursor,
  pageInfo,
} from "./tool-input";

export const LIST_CUSTOMERS_TOOL: McpTool = {
  name: "foxhound_list_customers",
  title: "List customers",
  description:
    "List this account's customers with health score, plan tier and MRR, lowest health first, plus the plan tiers present. tier filters to one plan tier. Paginated, 50 a page: pass next_cursor back to read on. Names are never returned and emails are masked; the Stripe customer id is the key for foxhound_get_customer.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      tier: {
        type: "string",
        description: "Only customers on this plan tier, as listed in tiers.",
      },
      cursor: CURSOR_PROPERTY,
    },
    required: [],
  },
  outputSchema: result(
    ["customers", "total", "total_mrr_cents", "tiers", "has_more", "next_cursor"],
    ["customers", "has_more"],
  ),
  annotations: READ,
  scope: "read",
  execute: async (ctx, args) => {
    const tool = "foxhound_list_customers";
    const page = decodeOffsetCursor(tool, args);
    const [result, tiers] = await Promise.all([
      // No search, on purpose: the directory's search matches customer names, so it would let an agent confirm a guessed
      // name. A customer is found by tier or by paging.
      listCustomerDirectory(ctx.db, ctx.accountId, {
        search: null,
        tier: stringArg(args, "tier"),
        healthBand: null,
        sort: "health_asc",
        page,
      }),
      listCustomerTiers(ctx.db, ctx.accountId),
    ]);
    const customers = page > result.totalPages ? [] : result.customers;
    return {
      customers,
      total: result.totalCount,
      total_mrr_cents: result.totalMrrCents,
      tiers,
      ...pageInfo(tool, page, result.totalPages),
    };
  },
};

export const GET_CUSTOMER_TOOL: McpTool = {
  name: "foxhound_get_customer",
  title: "Get one customer",
  description:
    "Read one of this account's customers: health score, its factors, its history and the churn predictions, with when they became a customer, their current plan name and tier, monthly MRR contribution and lifetime value (null until Foxhound computes it). The name is never returned and the email is masked. Customer ids come from foxhound_list_customers.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      stripe_customer_id: {
        type: "string",
        description: "The Stripe customer id, from foxhound_list_customers.",
      },
    },
    required: ["stripe_customer_id"],
  },
  outputSchema: result(["customer"], []),
  annotations: READ,
  scope: "read",
  execute: async (ctx, args) => {
    const customerId = required(
      args,
      "stripe_customer_id",
      "Take one from foxhound_list_customers.",
    );
    const customer = await getCustomerHealthDetail(ctx.db, ctx.accountId, customerId);
    if (!customer) {
      throw new ToolInputError(
        `No customer ${customerId} on this account. Take an id from foxhound_list_customers.`,
      );
    }
    return { customer };
  },
};

export const GET_INTELLIGENCE_TOOL: McpTool = {
  name: "foxhound_get_intelligence",
  title: "Churn, alerts, recommendations and reports",
  description:
    "Read this account's subscription intelligence. view churn (the default): churn bands, the churn chart series, the highest-risk customers, and the metric alerts with their recent firings; alert ids from here are the ones foxhound_manage_alerts takes. view recommendations: customers with a recommended next action, largest MRR first, 50 a page (pass next_cursor back to read on). view reports: the monthly narrative reports, newest first, with Stripe customer ids in place of names. Read only: dismissing or snoozing a recommendation is not offered.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      view: {
        type: "string",
        enum: ["churn", "recommendations", "reports"],
        description: "What to read. Defaults to churn.",
      },
      cursor: CURSOR_PROPERTY,
    },
    required: [],
  },
  outputSchema: result(
    [
      "churn",
      "alerts",
      "alert_history",
      "recommendations",
      "reports",
      "total",
      "has_more",
      "next_cursor",
    ],
    [],
  ),
  annotations: READ,
  scope: "read",
  execute: async (ctx, args) => {
    const tool = "foxhound_get_intelligence";
    const view = stringArg(args, "view") ?? "churn";
    if (view === "recommendations") {
      const page = decodeOffsetCursor(tool, args);
      const { rows, totalCount } = await listActionableRecommendations(ctx.db, ctx.accountId, page);
      const totalPages = Math.max(1, Math.ceil(totalCount / RECOMMENDATIONS_PAGE_SIZE));
      return {
        recommendations: rows.map((r) => ({
          stripeCustomerId: r.stripeCustomerId,
          planName: r.planName,
          mrrContributionCents: r.mrrContributionCents,
          currency: r.currency,
          healthScore: r.healthScore,
          recommendedAction: r.recommendedAction,
        })),
        total: totalCount,
        ...pageInfo(tool, page, totalPages),
      };
    }
    if (view === "reports") {
      const reports = await getReportsArchive(ctx.db, ctx.accountId, { forAgent: true });
      return {
        reports: reports.map((r) => ({
          id: r.id,
          reportMonth: r.reportMonth,
          generatedAt: r.generatedAt,
          narrative: r.narrative,
        })),
      };
    }
    if (view !== "churn") {
      throw new ToolInputError("view must be one of churn, recommendations or reports.");
    }
    const [churn, alerts] = await Promise.all([
      getChurnView(ctx.db, ctx.accountId, ctx.now.getTime()),
      getAlertsView(ctx.db, ctx.accountId),
    ]);
    return { churn, alerts: alerts.alerts, alert_history: alerts.history };
  },
};
