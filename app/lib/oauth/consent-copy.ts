// What the consent page says a connected client can do. RECOVA'S THREE LINES DESCRIBED RECOVA'S
// MCP, not Foxhound's.

export interface ConsentCapability {
  text: string;
  /** The merchant MCP tools this line stands for. */
  tools: readonly string[];
  /** A line for tools that need merchant.write, shown beside "Allow changes"
   *  rather than in the list every grant gets. */
  write?: true;
}

export const CONSENT_CAPABILITIES: readonly ConsentCapability[] = [
  {
    text: "Read your failed payments and their recovery status",
    tools: [
      "foxhound_get_overview",
      "foxhound_list_payments",
      "foxhound_get_payment",
      "foxhound_get_recovery",
    ],
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
    text: "Read your settings",
    tools: ["foxhound_get_settings"],
  },
  {
    text: "Change your settings and alerts",
    tools: ["foxhound_update_settings", "foxhound_manage_alerts"],
    write: true,
  },
];
