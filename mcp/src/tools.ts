import { callAdminApi, segment, type ApiResult } from "./api-client";
import type { AdminMcpEnv } from "./env";
import { SCOPE_WRITE } from "./scopes";

// THE NINE FOXHOUND ADMIN TOOLS (capsid/research/design-mcp-servers.md section
// 5; MCP ruling 2026-10-10, DECIDE answer 4).
//
// Seven read and two write. Pause is the one direct write, because pausing stops
// money moving. Everything that starts or changes money (resuming a merchant,
// releasing the brake, enabling a cron, billing exemption, a plan grant) can
// only be STAGED: the API records it, and an admin confirms it, signed in, in
// /admin/staged on foxhoundapp.com. There is no tool for refunds, adjustments,
// cancel or Stripe disconnect, and the API offers no route for one either.
//
// Every tool is one call to the admin API. The rules are the API's; a tool
// chooses the route and passes the arguments, and the API's own sentence is
// what the agent reads when it refuses.

export interface AdminToolSession {
  env: AdminMcpEnv;
  /** The signed-in admin, re-checked by the API on every call. */
  actor: string;
  scopes: readonly string[];
}

export interface AdminTool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required: string[] };
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  run: (session: AdminToolSession, args: Record<string, unknown>) => Promise<ApiResult>;
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const CURSOR = {
  type: "string",
  description: "Omit for the first page. To read on, pass next_cursor from the previous answer.",
} as const;

const text = (args: Record<string, unknown>, name: string): string | undefined =>
  typeof args[name] === "string" && args[name] !== "" ? (args[name] as string) : undefined;

const refuse = (error: string): ApiResult => ({ ok: false, status: 400, error });

const get = (session: AdminToolSession, path: string, query?: Record<string, string | undefined>) =>
  callAdminApi(session.env, session.actor, { method: "GET", path, query });

export const ADMIN_TOOLS: AdminTool[] = [
  {
    name: "foxhound_admin_whats_next",
    title: "What needs me",
    description:
      "Start here. What on Foxhound needs an admin now: whether the emergency brake is engaged, accounts with stale brake markers, crons that are off or failed their last run, webhook failures in the last day, and the staged changes waiting for confirmation in /admin/staged.",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: READ,
    run: (session) => get(session, "/whats-next"),
  },
  {
    name: "foxhound_admin_get_platform",
    title: "Platform overview",
    description: "Read the platform overview: merchant count, active recoveries, MRR by currency and cron health.",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: READ,
    run: (session) => get(session, "/platform"),
  },
  {
    name: "foxhound_admin_find_merchant",
    title: "Find a merchant",
    description:
      "Find merchants by name or account id, or pass account_id for one merchant in full: its account state, Stripe connections (never their tokens), subscriptions, recovery and dispute activity and recent invoices. Paginated: pass next_cursor back to read on.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Part of a merchant's name or account id." },
        account_id: { type: "string", description: "One merchant's account id, for its full detail." },
        cursor: CURSOR,
      },
      required: [],
    },
    annotations: READ,
    run: (session, args) => {
      const accountId = text(args, "account_id");
      if (accountId) return get(session, `/merchants/${segment(accountId)}`);
      return get(session, "/merchants", { query: text(args, "query"), cursor: text(args, "cursor") });
    },
  },
  {
    name: "foxhound_admin_read_merchant_data",
    title: "Read a merchant's data",
    description:
      "Read one merchant's own data as an admin: their recurring-revenue overview, failed-payment counts by status and their latest disputes. Customer names are never returned and emails are masked. Read only.",
    inputSchema: {
      type: "object",
      properties: { account_id: { type: "string", description: "From foxhound_admin_find_merchant." } },
      required: ["account_id"],
    },
    annotations: READ,
    run: (session, args) => {
      const accountId = text(args, "account_id");
      if (!accountId) return Promise.resolve(refuse("account_id is required. Find one with foxhound_admin_find_merchant."));
      return get(session, `/merchants/${segment(accountId)}/data`);
    },
  },
  {
    name: "foxhound_admin_check_health",
    title: "Check health",
    description:
      "Check Foxhound's health: webhook delivery in the last day, every cron's state and last run, which migrations are applied, the D1 database size, and the most-hit missing pages this week.",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: READ,
    run: (session) => get(session, "/health"),
  },
  {
    name: "foxhound_admin_read_audit_log",
    title: "Read the audit log",
    description:
      "Read the admin audit log, newest first: who did what and when, including every pause, staging and confirmation. Paginated: pass next_cursor back to read on.",
    inputSchema: { type: "object", properties: { cursor: CURSOR }, required: [] },
    annotations: READ,
    run: (session, args) => get(session, "/audit-log", { cursor: text(args, "cursor") }),
  },
  {
    name: "foxhound_admin_pause",
    title: "Pause processing",
    description:
      "Pause recovery and dispute processing now, for one merchant (account_id) or for every merchant through the emergency brake (all: true). Pausing stops money moving, so it happens at once and is recorded under your name. Resuming is not offered here: stage it with foxhound_admin_stage_change and confirm it in /admin/staged.",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "string", description: "The merchant to pause." },
        all: { type: "boolean", description: "True to pause every merchant through the brake." },
      },
      required: [],
    },
    // Destructive because it halts a merchant's recoveries until someone
    // resumes them; idempotent because pausing a paused merchant changes nothing.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (session, args) => {
      const accountId = text(args, "account_id");
      if (args.all === true && !accountId) {
        return callAdminApi(session.env, session.actor, { method: "POST", path: "/pause", body: { all: true } });
      }
      if (accountId && args.all !== true) {
        return callAdminApi(session.env, session.actor, { method: "POST", path: "/pause", body: { account_id: accountId } });
      }
      return Promise.resolve(refuse("Send account_id to pause one merchant, or all: true to pause every merchant, not both."));
    },
  },
  {
    name: "foxhound_admin_stage_change",
    title: "Stage a change",
    description:
      "Ask for a change that starts or changes money, for an admin to confirm in /admin/staged. Nothing changes until then. kind is resume_account (account_id), release_brake, cron_enable (cron_name), billing_exempt (account_id and exempt true or false) or intelligence_grant (account_id). Add a note saying why.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["resume_account", "release_brake", "cron_enable", "billing_exempt", "intelligence_grant"],
        },
        account_id: { type: "string" },
        cron_name: { type: "string", description: "For cron_enable: a cron foxhound_admin_check_health lists." },
        exempt: { type: "boolean", description: "For billing_exempt: true to exempt, false to bill again." },
        note: { type: "string", description: "Why, for the admin who confirms it." },
      },
      required: ["kind"],
    },
    // Not destructive: it only records a request. Not idempotent: each call
    // stages another request.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: async (session, args) => {
      const result = await callAdminApi(session.env, session.actor, {
        method: "POST",
        path: "/staged",
        body: {
          kind: args.kind,
          account_id: args.account_id,
          cron_name: args.cron_name,
          exempt: args.exempt,
          note: args.note,
        },
      });
      if (!result.ok) return result;
      return {
        ok: true,
        data: {
          ...result.data,
          next: "Nothing has changed yet. An admin confirms or rejects this in /admin/staged on foxhoundapp.com.",
        },
      };
    },
  },
  {
    name: "foxhound_admin_list_staged",
    title: "List staged changes",
    description:
      "List staged changes, newest first, with who asked, when, and whether each is pending, confirmed, rejected or failed. Paginated: pass next_cursor back to read on.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["pending", "confirmed", "rejected", "failed"] },
        cursor: CURSOR,
      },
      required: [],
    },
    annotations: READ,
    run: (session, args) => get(session, "/staged", { status: text(args, "status"), cursor: text(args, "cursor") }),
  },
];

export const ADMIN_TOOL_NAMES = ADMIN_TOOLS.map((tool) => tool.name);

/** Run one tool for one session. A write needs the write scope (rule 12.3). */
export async function runAdminTool(
  tool: AdminTool,
  session: AdminToolSession,
  args: Record<string, unknown>,
): Promise<ApiResult> {
  if (!tool.annotations.readOnlyHint && !session.scopes.includes(SCOPE_WRITE)) {
    return refuse(
      `This grant is read-only, so ${tool.name} is not available. Reconnect and allow pausing and staging on the consent page to use it.`,
    );
  }
  return tool.run(session, args);
}
