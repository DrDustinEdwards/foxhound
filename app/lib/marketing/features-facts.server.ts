import type { FeatureFacts } from "~/lib/marketing/features-content";

// The two /features counts only the server can read (J60). Both are imported
// dynamically, as workers/app.ts imports them, so the cron graph and the MCP
// tool graph stay off every other page's render; a module import is cached per
// isolate after the first /features request.
export async function readFeatureFacts(): Promise<FeatureFacts> {
  const [{ CRON_JOBS }, { MERCHANT_TOOL_NAMES }] = await Promise.all([
    import("~/lib/cron/registry"),
    import("~/lib/mcp/tools.server"),
  ]);
  return { cronJobCount: CRON_JOBS.length, merchantMcpToolCount: MERCHANT_TOOL_NAMES.length };
}
