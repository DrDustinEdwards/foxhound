// The tool registry, and the refusal that is the point of it.
//
// EMPTY THIS SESSION, DELIBERATELY. 370 split the transport and the thirteen
// tools across two sessions. What ships here is the endpoint plus a registry
// with nothing in it, NOT a stub tool: a placeholder tool would be a surface a
// client could call and a thing the S29 copy could be read as promising, and
// removing it later would be a breaking change to a published tool list. An
// empty list is honest and costs nothing to grow.
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

export interface McpTool {
  name: string;
  description: string;
  /** JSON Schema. Plain object rather than a zod schema: MCP's `inputSchema` IS
   *  JSON Schema, and the repo carries no schema library to convert one. */
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
}

export interface McpToolRegistry {
  list(): McpTool[];
  get(name: string): McpTool | null;
}

/** True when a name is one the registry must refuse. Exported so the plant can
 *  drive it directly rather than through a thrown error. */
export function isDeniedToolName(name: string): boolean {
  const lower = name.toLowerCase();
  return DENIED_TOOL_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

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
    if (byName.has(tool.name)) {
      throw new Error(`MCP tool "${tool.name}" is registered twice`);
    }
    byName.set(tool.name, tool);
  }
  return {
    list: () => [...byName.values()],
    get: (name: string) => byName.get(name) ?? null,
  };
}

/**
 * The registry this endpoint serves. EMPTY until session 77 registers the
 * thirteen read tools from the design's Table 5.
 *
 * Built through `defineToolRegistry` even while empty, so the denylist is on the
 * live path from the first commit rather than being wired up later beside the
 * tools it is supposed to police.
 */
export const MERCHANT_TOOLS: McpToolRegistry = defineToolRegistry([]);
