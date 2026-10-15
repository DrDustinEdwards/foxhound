import { Link, useNavigation, useRevalidator } from "react-router";
import { Empty } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { Spinner } from "capsomer/react/skeleton";
import { StatTile, StatTiles } from "capsomer/react/stat-tile";
import { Status } from "capsomer/react/status";
import "capsomer/table.css";

import { AdminTime } from "~/components/admin-time";
import { getDb } from "~/db";
import { MCP_CALLS_SHOWN, MCPS_PATH, maskSecretsInText, outcomeWords, scopeWords } from "~/lib/admin/mcps";
import {
  getMcpSummary,
  listAdminApiKeys,
  listRecentMcpCalls,
  merchantToolCoverage,
  type AdminApiKeyRow,
  type AdminMcpCallRow,
} from "~/lib/admin/mcps.server";
import { plural } from "~/lib/admin/overview";
import { merchantHref, pagePending, type AdminHandle } from "~/lib/admin/page";
import { MCP_TOKEN_SCOPE } from "~/lib/auth/mcp-tokens";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/mcps";

export const handle: AdminHandle = { page: "MCP servers" };

export function meta() {
  return [{ title: "MCP servers - Foxhound admin" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const [summary, keys, calls] = await Promise.all([getMcpSummary(db), listAdminApiKeys(db), listRecentMcpCalls(db)]);
  return { summary, keys, calls, tools: merchantToolCoverage() };
}

const KEYS_HEADING_ID = "admin-mcps-keys-heading";
const TOOLS_HEADING_ID = "admin-mcps-tools-heading";
const CALLS_HEADING_ID = "admin-mcps-calls-heading";
// A link in a table cell is given a 24 px target (WCAG 2.2, 2.5.8).
const LINK = "inline-block min-h-6 leading-6 text-text underline underline-offset-2 hover:text-brand-text";

// The family admin pattern (Capsomer patterns.md, Dustin's Q9 of 2026-10-14)
// and his review of 2026-10-11: one page name (the shell's "MCP servers"), the
// figures first, then Capsomer tables with plain sentence-case words, relative
// times with the exact time on hover, and a pending and an empty state on
// every list. Recova's page (app/admin/mcps/page.tsx, blob d0381e5f) is the
// inventory: the API keys table with its total and active count, and the tool
// coverage. Its hard-coded server status, tool counts and list of workspace
// connectors are not copied (ruling 406 binding 6): the tools here are read
// from the merchant MCP's live registry, and the merchant MCP call log is
// Foxhound's own. Read only: nothing here issues or revokes a key, and no key
// material is read (app/lib/admin/mcps.server.ts).
export default function AdminMcps({ loaderData }: Route.ComponentProps) {
  const { summary, keys, calls, tools } = loaderData;
  const pending = pagePending(useNavigation(), useRevalidator().state, MCPS_PATH);
  const spinner = pending ? <Spinner size="sm" label="Reading again" /> : undefined;
  const writes = tools.filter((t) => t.writes).length;

  return (
    <div className="grid grid-cols-1 gap-6">
      <StatTiles label="MCP use">
        <StatTile label="API keys" figure={String(summary.keysTotal)} detail="Merchant and admin, revoked included" />
        <StatTile label="Active keys" figure={String(summary.keysActive)} detail="Not revoked" />
        <StatTile label="Calls" figure={String(summary.callsLast24h)} detail="Merchant MCP, in the last 24 hours" />
        <StatTile
          label="Failed calls"
          figure={String(summary.failedLast24h)}
          tone={summary.failedLast24h > 0 ? "crit" : undefined}
          detail="Refused or failed, in the last 24 hours"
        />
      </StatTiles>

      <div aria-busy={pending || undefined} className="grid grid-cols-1 gap-6">
        <Panel
          title="API keys"
          headingId={KEYS_HEADING_ID}
          src={spinner}
          description={`${plural(keys.length, "key", "keys")}, ${summary.keysActive} active, newest first.`}
          flush
        >
          {keys.length === 0 ? (
            <Empty kind="nothing-yet" title="No API keys yet.">
              A key appears here when a merchant creates one in their settings.
            </Empty>
          ) : (
            <div className="cap-table-wrap" data-cap="table" role="region" aria-labelledby={KEYS_HEADING_ID} tabIndex={0}>
              <table className="cap-table">
                <caption className="cap-sr-only">API keys, newest first.</caption>
                <thead>
                  <tr>
                    <th scope="col">Label</th>
                    <th scope="col">Scope</th>
                    <th scope="col">Account</th>
                    <th scope="col">Status</th>
                    <th scope="col">Created</th>
                    <th scope="col">Last used</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k) => (
                    <KeyRow key={k.id} apiKey={k} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel
          title="Merchant tools"
          headingId={TOOLS_HEADING_ID}
          src={spinner}
          description={`${plural(tools.length, "tool", "tools")} in the merchant MCP's registry: ${tools.length - writes} read, ${writes} write.`}
          flush
        >
          {tools.length === 0 ? (
            <Empty kind="nothing-yet" title="No merchant tools registered." />
          ) : (
            <div className="cap-table-wrap" data-cap="table" role="region" aria-labelledby={TOOLS_HEADING_ID} tabIndex={0}>
              <table className="cap-table">
                <caption className="cap-sr-only">Merchant MCP tools, as the registry lists them.</caption>
                <thead>
                  <tr>
                    <th scope="col">Tool</th>
                    <th scope="col">What it does</th>
                    <th scope="col">Access</th>
                  </tr>
                </thead>
                <tbody>
                  {tools.map((t) => (
                    <tr key={t.name}>
                      <th scope="row" className="font-mono text-micro font-normal break-all">
                        {t.name}
                      </th>
                      <td data-wrap="">{t.title}</td>
                      <td>{t.writes ? <Status tone="info">Writes</Status> : <Status tone="ok">Reads</Status>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel
          title="Recent calls"
          headingId={CALLS_HEADING_ID}
          src={spinner}
          description={`Up to the newest ${MCP_CALLS_SHOWN} merchant MCP calls, every account. Arguments are not shown.`}
          flush
        >
          {calls.length === 0 ? (
            <Empty kind="nothing-yet" title="No MCP calls yet.">
              Every tool call a merchant key makes is logged here.
            </Empty>
          ) : (
            <div className="cap-table-wrap" data-cap="table" role="region" aria-labelledby={CALLS_HEADING_ID} tabIndex={0}>
              <table className="cap-table">
                <caption className="cap-sr-only">Merchant MCP calls, newest first.</caption>
                <thead>
                  <tr>
                    <th scope="col">Tool</th>
                    <th scope="col">Account</th>
                    <th scope="col">Key</th>
                    <th scope="col">Outcome</th>
                    <th scope="col">When</th>
                    <th scope="col">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {calls.map((c) => (
                    <CallRow key={c.id} call={c} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

function AccountLink({ id, name }: { id: string; name: string | null }) {
  return (
    <Link to={merchantHref(id)} className={name ? LINK : `${LINK} font-mono text-micro break-all`}>
      {name ?? id}
    </Link>
  );
}

function KeyRow({ apiKey: k }: { apiKey: AdminApiKeyRow }) {
  return (
    <tr>
      <th scope="row" className="font-normal">
        {k.label ?? <span className="text-text-tertiary">Unlabelled</span>}
      </th>
      <td>{scopeWords(k.scope)}</td>
      <td>
        {k.accountId ? (
          <AccountLink id={k.accountId} name={k.accountName} />
        ) : (
          <span className="text-text-secondary">{k.scope === MCP_TOKEN_SCOPE.ADMIN ? "Platform" : "No account"}</span>
        )}
      </td>
      <td>{k.revokedAt ? <Status tone="nodata">Revoked</Status> : <Status tone="ok">Active</Status>}</td>
      <td>
        <AdminTime at={k.createdAt} />
      </td>
      <td>
        <AdminTime at={k.lastUsedAt} />
      </td>
    </tr>
  );
}

function CallRow({ call: c }: { call: AdminMcpCallRow }) {
  return (
    <tr>
      <th scope="row" className="font-mono text-micro font-normal break-all">
        {c.tool || <span className="text-text-tertiary">No tool named</span>}
      </th>
      <td>
        <AccountLink id={c.accountId} name={c.accountName} />
      </td>
      <td>{c.keyLabel ?? <span className="text-text-tertiary">{c.keyFound ? "Unlabelled" : "Removed key"}</span>}</td>
      <td>
        <Status tone={c.outcome === "ok" ? "ok" : "crit"}>{outcomeWords(c.outcome)}</Status>
      </td>
      <td>
        <AdminTime at={c.createdAt} />
      </td>
      <td data-wrap="" className={c.error ? "text-error-text" : "text-text-tertiary"}>
        {c.error === null ? "None" : maskSecretsInText(c.error)}
      </td>
    </tr>
  );
}
