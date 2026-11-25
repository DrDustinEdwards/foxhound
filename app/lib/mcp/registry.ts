import type { Db } from "~/db";

import { redactToolResult } from "./redact";

// The tool registry and the refusal that is the point of it. The live tools are in ./tools.server.ts; every one passes
// this gate at load. The denylist is the HUMAN-FOREVER five (dispute submission, account cancel, Stripe disconnect and
// connect, any outcome or billing write), enforced two ways: structurally (the transport resolves an ACCOUNT from a
// bearer key, never a USER, so no caller can produce a valid `dispute_approvals` row) and constructively
// (`defineToolRegistry` THROWS if a denied name is registered, so a jailbroken prompt or a merge that looked reasonable
// cannot create the tool). The second is what a plant can watch; the first depends on a fact about a different table.

/** Names that must never appear in the registry, matched as substrings of the lowercased tool name: the risk is
 *  "disputes_submit_evidence", not exactly "submit_dispute". */
export const DENIED_TOOL_FRAGMENTS: readonly string[] = [
  "submit_dispute",
  "dispute_submit",
  "approve_dispute",
  "dispute_approval",
  "cancel_account",
  "account_cancel",
  "disconnect",
  "connect_stripe",
  "stripe_connect",
  "add_account",
  // Account deletion: a person deletes their own account, signed in; no key or agent ever can.
  "delete_account",
  "account_delete",
  "delete_user",
  "user_delete",
  // Dispute auto-submit: turning it on is the merchant's standing approval to submit evidence to Stripe, the same act as
  // approving a submission. Readable (foxhound_list_disputes), changed only by the merchant on /settings/disputes.
  "auto_submit",
  "autosubmit",
  "record_outcome",
  "outcome",
  "invoice_create",
  "create_invoice",
  "charge",
  "refund",
  "issue_key",
  "create_api_key",
  "api_key_create",
];

/** What every executor receives. Declared here, not in tools.server.ts, to avoid an import cycle. No user and no session,
 *  only the account the bearer key resolved to: that absence is what makes the HUMAN-FOREVER five hold by construction. */
export interface McpToolContext {
  env: Env;
  db: Db;
  accountId: string;
  now: Date;
  /** Who is writing, so a write tool records its trace in the same batch as the write. Built from the verified bearer key
   *  (the api key id `verifyMcpToken` returned), so a tool cannot name a different author. Read tools ignore it. */
  trace: { apiKeyId: string; tool: string; now: Date };
}

/** The four behavior hints every tool must carry, set honestly so a client can ask before acting. All required: a
 *  missing hint reads as the spec's default, and destructiveHint defaults to true. */
export interface McpToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

interface McpToolDescriptor {
  name: string;
  title: string;
  description: string;
  /** JSON Schema, plain object (MCP's `inputSchema` is JSON Schema; the SDK's `fromJsonSchema` takes it as written). */
  inputSchema: {
    type: "object";
    additionalProperties: false;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  /** JSON Schema of the result's structuredContent; the SDK checks every successful result against it. */
  outputSchema?: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  annotations: McpToolAnnotations;
}

/** A registered tool: its descriptor plus the work it performs. No tool takes an account as an argument, so an agent
 *  cannot be talked into changing it. */
export interface McpTool extends McpToolDescriptor {
  /** The scope a call needs: "read" is merchant.read, "write" is merchant.write (which the owner ticked). Declared, never
   *  read from readOnlyHint (a hint is not an authorization); the registry refuses a tool whose hint and scope disagree. */
  scope: "read" | "write";
  execute: (ctx: McpToolContext, args: Record<string, unknown>) => Promise<unknown>;
}

export interface McpToolRegistry {
  list(): McpToolDescriptor[];
  get(name: string): McpTool | null;
}

export function isDeniedToolName(name: string): boolean {
  const lower = name.toLowerCase();
  return DENIED_TOOL_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

/** A refusal: the tool did nothing and says how to fix the input. The only error whose message is written for the agent,
 *  so the only one that reaches it (./server.ts). */
export class ToolInputError extends Error {}

const TOOL_NAME_PATTERN = /^foxhound(_[a-z]+){2,}$/;

/** Build a registry, refusing any denied name at construction. Throws rather than filters (a silently dropped tool would
 *  ship); duplicate names throw too, since a shadowed tool cannot be reasoned about. */
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
    if ((tool.scope === "read") !== tool.annotations.readOnlyHint) {
      throw new Error(
        `MCP tool "${tool.name}" declares scope ${tool.scope} but readOnlyHint ${tool.annotations.readOnlyHint}`,
      );
    }
    // Registration applies the redaction: the stored executor is the tool's own wrapped in `redactToolResult`, so every tool
    // is redacted rather than the ones whose authors remembered. Wrapped here, not at the handler, because `get()` hands the
    // tool to any caller, who would otherwise get the raw executor.
    byName.set(tool.name, {
      ...tool,
      execute: async (ctx, args) => redactToolResult(await tool.execute(ctx, args)),
    });
  }
  return {
    list: () =>
      [...byName.values()].map(
        ({ name, title, description, inputSchema, outputSchema, annotations }) => ({
          name,
          title,
          description,
          inputSchema,
          ...(outputSchema ? { outputSchema } : {}),
          annotations,
        }),
      ),
    get: (name: string) => byName.get(name) ?? null,
  };
}

/** An empty registry, the transport's default so `handleMcpRequest` has a safe fallback and tests can drive the transport
 *  without the tool module's import graph. */
export const EMPTY_REGISTRY: McpToolRegistry = defineToolRegistry([]);
