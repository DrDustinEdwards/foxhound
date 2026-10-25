import type { Db } from "~/db";

import { redactToolResult } from "./redact";

// The tool registry, and the refusal that is the point of it.
//
// THE LIVE TOOLS ARE IN ./tools.server.ts, regrouped to the 2026-10-10 MCP
// ruling (capsid/rulings/mcp-2026-10-10.md): twelve whole-job tools named
// foxhound_{action}_{resource}, each carrying all four behavior hints. This
// module is the gate every one of them passes through at load.
//
// THE DENYLIST IS THE HUMAN-FOREVER FIVE, ENFORCED BY CONSTRUCTION (368 ruling
// 4, ratified again at 370). Dispute submission, account cancel, Stripe
// disconnect, Stripe connect and any outcome or billing write never gain a tool.
// Two independent guarantees, and both are worth keeping because either alone is
// weaker than the pair:
//
//   1. STRUCTURAL. The transport resolves an ACCOUNT from a bearer key and never
//      a USER. `dispute_approvals` stores `approved_by_user_id` and
//      `approved_by_email`, so no caller on this path can produce a valid
//      approval row whatever tools exist.
//   2. CONSTRUCTIVE. `defineToolRegistry` THROWS if a denied name is registered,
//      so the tool cannot exist to be called by a jailbroken prompt, a confused
//      future session, or a merge that looked reasonable in isolation.
//
// The second is what a plant can watch, which is why it exists at all: the first
// is true today and depends on a fact about a different table.

/**
 * Names that must never appear in the registry, matched as substrings on the
 * lowercased tool name.
 *
 * SUBSTRINGS RATHER THAN EXACT NAMES, because the risk is not that somebody
 * registers exactly "submit_dispute", it is that they register
 * "disputes_submit_evidence" and nothing notices. A denylist keyed on exact
 * spellings is a guess about what the next name will be.
 */
export const DENIED_TOOL_FRAGMENTS: readonly string[] = [
  // Dispute submission: needs a human approver by schema.
  "submit_dispute",
  "dispute_submit",
  "approve_dispute",
  "dispute_approval",
  // Account and connection lifecycle: grant-level, consent lives on Stripe.
  "cancel_account",
  "account_cancel",
  "disconnect",
  "connect_stripe",
  "stripe_connect",
  "add_account",
  // Account deletion (row S40): a person deletes their own account, signed in,
  // and no key or agent ever can (RULES.md 3.6, cancel's family).
  "delete_account",
  "account_delete",
  "delete_user",
  "user_delete",
  // Anything that records an outcome or bills.
  "record_outcome",
  "outcome",
  "invoice_create",
  "create_invoice",
  "charge",
  "refund",
  // Key issuance: a key that mints keys is a privilege-escalation surface.
  "issue_key",
  "create_api_key",
  "api_key_create",
];

/**
 * What every executor receives. Declared HERE rather than in tools.server.ts so
 * the registry can type its executors without importing the tool module, which
 * would be a cycle: the tools import the registry to be defined by it.
 *
 * No user and no session, only the account the bearer key resolved to (371
 * binding 2). That absence is what makes the HUMAN-FOREVER five enforceable by
 * construction rather than by policy.
 */
export interface McpToolContext {
  env: Env;
  db: Db;
  accountId: string;
  now: Date;
  /**
   * WHO IS WRITING, carried so a write tool can record its trace in the same
   * batch as the write (372's item-4 ruling). Read tools ignore it.
   *
   * It is built from the bearer key the transport already verified, so a tool
   * cannot name a different author: the api key id is the one `verifyMcpToken`
   * returned, not an argument.
   */
  trace: { apiKeyId: string; tool: string; now: Date };
}

/**
 * The four behavior hints the 2026-10-10 ruling (rule 6) requires on every
 * tool, set honestly so a client can ask before acting. All four are REQUIRED
 * here rather than optional as in the spec: a missing hint is read by a client
 * as the spec's default, and the default for destructiveHint is true, so an
 * omission would be a statement nobody made.
 */
export interface McpToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** What a tool exposes to a client. No executor: this is the shape `tools/list`
 *  returns, and shipping the function with it would be a leak waiting to be
 *  serialized. */
export interface McpToolDescriptor {
  name: string;
  title: string;
  description: string;
  /** JSON Schema. Plain object rather than a zod schema: MCP's `inputSchema` IS
   *  JSON Schema, and the SDK's `fromJsonSchema` takes it as written. */
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
  annotations: McpToolAnnotations;
}

/** A registered tool: its descriptor plus the work it performs. The context
 *  carries the account the bearer key resolved to; no tool takes an account as
 *  an argument, so an agent cannot be talked into changing it. */
export interface McpTool extends McpToolDescriptor {
  execute: (ctx: McpToolContext, args: Record<string, unknown>) => Promise<unknown>;
}

export interface McpToolRegistry {
  /** The PUBLIC shape only. `tools/list` must never serialize an executor. */
  list(): McpToolDescriptor[];
  get(name: string): McpTool | null;
}

/** True when a name is one the registry must refuse. Exported so the plant can
 *  drive it directly rather than through a thrown error. */
export function isDeniedToolName(name: string): boolean {
  const lower = name.toLowerCase();
  return DENIED_TOOL_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

/**
 * A REFUSAL: the tool did nothing and says how to fix the input. The one kind
 * of error whose message is written for the agent, so the only kind whose
 * message reaches it (./server.ts). Declared here so the transport can tell it
 * apart without importing the tool module.
 */
export class ToolInputError extends Error {}

/** Every name is `foxhound_{action}_{resource}` (ruling rule 5): the service
 *  prefix, then at least an action and a resource, snake case. */
const TOOL_NAME_PATTERN = /^foxhound(_[a-z]+){2,}$/;

/**
 * Build a registry, refusing any denied name at construction time.
 *
 * THROWS RATHER THAN FILTERS. A registry that silently dropped a denied tool
 * would let the mistake ship and be discovered by a merchant noticing a tool
 * missing; throwing turns it into a failed build. Duplicate names throw for the
 * same reason: a shadowed tool is a tool nobody can reason about.
 */
export function defineToolRegistry(tools: McpTool[]): McpToolRegistry {
  const byName = new Map<string, McpTool>();
  for (const tool of tools) {
    if (isDeniedToolName(tool.name)) {
      throw new Error(
        `MCP tool "${tool.name}" is on the HUMAN-FOREVER denylist (368 ruling 4) and cannot be registered`,
      );
    }
    if (!TOOL_NAME_PATTERN.test(tool.name)) {
      throw new Error(`MCP tool "${tool.name}" is not named foxhound_{action}_{resource}`);
    }
    if (byName.has(tool.name)) {
      throw new Error(`MCP tool "${tool.name}" is registered twice`);
    }
    // REGISTRATION IS WHAT APPLIES THE REDACTION (376 item 7). The executor
    // stored here is the tool's own wrapped in `redactToolResult`, so 370's
    // DEFAULT-REDACT holds for every tool in the registry rather than for the
    // three tools whose authors remembered to call a helper. A tool cannot skip
    // it by forgetting, because a tool never calls it, and it cannot skip it by
    // not registering, because an unregistered tool has no way to be called.
    //
    // WRAPPED HERE RATHER THAN AT THE HANDLER for one reason worth stating: the
    // handler is not the only caller. `get()` hands the tool to whoever asks,
    // and a future caller that is not the JSON-RPC dispatch would otherwise get
    // the raw executor and be redaction-free by default.
    byName.set(tool.name, {
      ...tool,
      execute: async (ctx, args) => redactToolResult(await tool.execute(ctx, args)),
    });
  }
  return {
    list: () =>
      [...byName.values()].map(({ name, title, description, inputSchema, annotations }) => ({
        name,
        title,
        description,
        inputSchema,
        annotations,
      })),
    get: (name: string) => byName.get(name) ?? null,
  };
}

/**
 * An empty registry, kept as the transport's DEFAULT so `handleMcpRequest` has a
 * safe fallback and so a test can drive the transport without the tool module's
 * import graph. The live ones are in ./tools.server.ts, which the worker entry
 * passes in.
 */
export const EMPTY_REGISTRY: McpToolRegistry = defineToolRegistry([]);
