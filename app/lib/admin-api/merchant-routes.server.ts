import type { Db } from "~/db";
import { logAdminAction } from "~/lib/admin/audit.server";
import { getMerchantDetail, listMerchants } from "~/lib/admin/merchants.server";
import { ToolInputError } from "~/lib/mcp/registry";
import { MERCHANT_TOOLS } from "~/lib/mcp/tools.server";

import { ADMIN_API_PREFIX, ApiError, page, slice, type ApiRoute, type Json } from "./route.server";

const MERCHANT_FILTERS = ["paused", "billing_exempt", "canceled"] as const;
type MerchantFilter = (typeof MERCHANT_FILTERS)[number];

/**
 * One merchant, minus every credential its rows carry: the Stripe access token
 * on each connection and the Slack webhook URL on the account.
 */
async function merchantForAgent(db: Db, accountId: string) {
  const detail = await getMerchantDetail(db, accountId);
  if (!detail) {
    throw new ApiError(
      404,
      `No merchant ${accountId}. Find one with GET ${ADMIN_API_PREFIX}/merchants?query=.`,
    );
  }
  const { account } = detail;
  return {
    account: {
      id: account.id,
      name: account.name,
      currency: account.currency,
      createdAt: account.createdAt,
      cancelledAt: account.cancelledAt,
      billingExempt: account.billingExempt,
      processingPaused: account.processingPaused,
      pauseReason: account.pauseReason,
      notificationEmail: account.notificationEmail,
      slackWebhookConfigured: Boolean(account.slackWebhookUrl),
    },
    connections: detail.connections.map((c) => ({
      id: c.id,
      name: c.name,
      stripeUserId: c.stripeUserId,
      isPrimary: c.isPrimary,
      connectedAt: c.connectedAt,
      disconnectedAt: c.disconnectedAt,
    })),
    recoveryActivity: detail.recoveryActivity,
    disputeActivity: detail.disputeActivity,
    recentInvoices: detail.recentInvoices,
  };
}

export const MERCHANT_ROUTES: ApiRoute[] = [
  {
    method: "GET",
    pattern: "/merchants",
    handler: async ({ db, url }) => {
      const query = (url.searchParams.get("query") ?? "").trim().toLowerCase();
      const filter = url.searchParams.get("filter");
      if (filter !== null && !MERCHANT_FILTERS.includes(filter as MerchantFilter)) {
        throw new ApiError(400, `filter must be one of ${MERCHANT_FILTERS.join(", ")}.`);
      }
      const all = (await listMerchants(db)).filter(
        (m) =>
          filter === null ||
          (filter === "paused" && m.processingPaused) ||
          (filter === "billing_exempt" && m.billingExempt) ||
          (filter === "canceled" && m.cancelledAt !== null),
      );
      const matching = query
        ? all.filter(
            (m) =>
              m.id.toLowerCase().includes(query) || (m.name ?? "").toLowerCase().includes(query),
          )
        : all;
      const { items, ...rest } = slice("/merchants", matching, page(url, "/merchants"));
      return { merchants: items, ...rest };
    },
  },
  {
    method: "GET",
    pattern: "/merchants/:id",
    handler: async ({ db, params }) => ({ merchant: await merchantForAgent(db, params[0]) }),
  },
  {
    // VIEW AS MERCHANT for an agent: one of the merchant MCP's own READ tools, run
    // for the named account, so an admin sees exactly the answer the merchant's
    // agent would get (the same picks, masking and pagination) and nothing the
    // merchant's key could not read. Allowlisted by the registry itself (a tool
    // whose scope is "read"): a write tool cannot be named, and a new one is covered.
    method: "POST",
    pattern: "/merchants/:id/view",
    handler: async ({ db, env, caller, params, body, now }) => {
      const accountId = params[0];
      await merchantForAgent(db, accountId);
      const toolName = typeof body.tool === "string" ? body.tool : "";
      const tool = MERCHANT_TOOLS.get(toolName);
      if (!tool || tool.scope !== "read") {
        throw new ApiError(
          400,
          `tool must be one of the merchant read tools: ${MERCHANT_TOOLS.list()
            .filter((t) => MERCHANT_TOOLS.get(t.name)?.scope === "read")
            .map((t) => t.name)
            .join(", ")}.`,
        );
      }
      const args =
        body.arguments && typeof body.arguments === "object" && !Array.isArray(body.arguments)
          ? (body.arguments as Record<string, unknown>)
          : {};
      await logAdminAction(db, {
        actorEmail: caller.actorEmail,
        action: "merchant.view_as_read",
        metadata: { accountId, tool: toolName },
      });
      try {
        const result = await tool.execute(
          { env, db, accountId, now, trace: { apiKeyId: caller.keyId, tool: toolName, now } },
          args,
        );
        return { tool: toolName, result } as Json;
      } catch (error) {
        // A refusal written for the agent (a missing id, a bad cursor) is the
        // same sentence the merchant's agent would read.
        if (error instanceof ToolInputError) throw new ApiError(400, error.message);
        throw error;
      }
    },
  },
];
