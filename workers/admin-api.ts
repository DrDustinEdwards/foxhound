import { WorkerEntrypoint } from "cloudflare:workers";

// THE FOXHOUND ADMIN API (job_21de68b30fc2) as a named entrypoint, reachable only
// through a service binding that names it (Grok audit FH-20). The Foxhound Admin
// MCP Worker binds it with "entrypoint": "AdminApi" (mcp/wrangler.jsonc). The
// public fetch handler in app.ts never routes /api/admin/v1, so a leaked admin
// key plus an admin address cannot call it over the internet: a public request
// for that path reaches the router and gets its 404. Inside, an admin-scope key
// AND an acting admin on ADMIN_EMAIL are still checked on every call.
export class AdminApi extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const { handleAdminApiRequest } = await import("~/lib/admin-api/handler.server");
    return (
      (await handleAdminApiRequest(request, this.env)) ??
      Response.json({ ok: false, error: "Not found." }, { status: 404, headers: { "Cache-Control": "no-store" } })
    );
  }
}
