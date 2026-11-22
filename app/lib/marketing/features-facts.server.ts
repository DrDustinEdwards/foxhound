import type { FeatureFacts } from "~/lib/marketing/features-content";

// The two /features counts only the server can read. Both are imported dynamically (as workers/app.ts does) so the cron and MCP graphs
// stay off every other page's render; the import is cached per isolate.
export async function readFeatureFacts(): Promise<FeatureFacts> {
  const [{ CRON_JOBS }, { MERCHANT_TOOL_NAMES }] = await Promise.all([
    import("~/lib/cron/registry"),
    import("~/lib/mcp/tools.server"),
  ]);
  return { cronJobCount: CRON_JOBS.length, merchantMcpToolCount: MERCHANT_TOOL_NAMES.length };
}
