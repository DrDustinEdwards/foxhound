// What the consent page says a connected client can do.
//
// RECOVA'S THREE LINES DESCRIBED RECOVA'S MCP, not Foxhound's.
// ConsentButtons.tsx (eb31e8e9) listed "Read and manage your recovery
// sequences and failed payments", "Read and respond to disputes" and "Read
// your Intelligence data and customer health signals". Foxhound's merchant
// tools (app/lib/mcp/tools.server.ts) read payments and disputes but change
// neither, and submitting a dispute is one of the five actions no agent is
// ever given. The manifest's own note on that row said the
// list "should be re-grounded against what the Foxhound MCP surface actually
// exposes rather than copied". So each line below names the tools it stands
// for, and test/oauth-provider-j79.test.ts fails if a tool is added without a
// line or a line names a tool that does not exist. Recova's third line is
// true of Foxhound and is kept word for word. The change is listed under
// "Needs Dustin" in the pull request.

export interface ConsentCapability {
  text: string;
  /** The merchant MCP tools this line stands for. */
  tools: readonly string[];
}

export const CONSENT_CAPABILITIES: readonly ConsentCapability[] = [
  {
    text: "Read your failed payments and their recovery status",
    tools: ["foxhound_get_overview", "foxhound_list_payments", "foxhound_get_payment"],
  },
  {
    text: "Read your disputes",
    tools: ["foxhound_list_disputes"],
  },
  {
    text: "Read your Intelligence data and customer health signals",
    tools: ["foxhound_get_intelligence", "foxhound_list_customers", "foxhound_get_customer"],
  },
  {
    text: "Read your audits and your Foxhound billing",
    tools: ["foxhound_review_audits", "foxhound_get_billing"],
  },
  {
    text: "Read and change your settings and alerts",
    tools: ["foxhound_get_settings", "foxhound_update_settings", "foxhound_manage_alerts"],
  },
];
