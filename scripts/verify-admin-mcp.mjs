// The live gate's verify for the admin MCP Worker (ci.yml, admin-mcp-deploy): run by devkit's worker-deploy.yml after
// /health reports the commit this run deployed. Exit 0 passes, 1 refuses (devkit rolls the deploy back), 3 could not
// decide (the job fails, nothing moves). No dependencies: the live gate does not install.
//
// 1. The protected-resource metadata names this server's /mcp.
// 2. /mcp with a foreign Origin is refused 403 before any token check (DNS rebinding).
// 3. /mcp with no token is a 401 that points at that metadata.

const ORIGIN = "https://admin-mcp.foxhoundapp.com";
const RESOURCE = `${ORIGIN}/mcp`;
const ATTEMPTS = 6;
const WAIT_MS = 10_000;

const post = (headers) =>
  fetch(RESOURCE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    signal: AbortSignal.timeout(15_000),
  });

async function check() {
  const meta = await fetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`, { signal: AbortSignal.timeout(15_000) });
  if (meta.status !== 200) return `protected-resource metadata answered ${meta.status}`;
  const body = await meta.json().catch(() => ({}));
  if (body.resource !== RESOURCE) return `protected-resource metadata names ${JSON.stringify(body.resource)}, not ${RESOURCE}`;
  const foreign = await post({ Origin: "https://evil.example" });
  if (foreign.status !== 403) return `/mcp with a foreign Origin answered ${foreign.status}, not 403`;
  const bare = await post({});
  if (bare.status !== 401) return `/mcp with no token answered ${bare.status}, not 401`;
  if (!(bare.headers.get("WWW-Authenticate") ?? "").includes("resource_metadata=")) return "/mcp 401 has no resource_metadata in WWW-Authenticate";
  return "";
}

let last = "no attempt ran";
let reached = false;
for (let i = 1; i <= ATTEMPTS; i++) {
  try {
    last = await check();
    reached = true;
    if (!last) {
      console.log(`admin MCP verified live at ${ORIGIN}.`);
      process.exit(0);
    }
  } catch (error) {
    last = `could not reach ${ORIGIN}: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (i < ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
}
console.error(`::error::admin MCP verify: ${last}`);
process.exit(reached ? 1 : 3);
