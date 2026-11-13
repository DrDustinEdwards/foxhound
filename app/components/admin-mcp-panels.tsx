import { Link } from "capsomer/react/link";
import { Empty } from "capsomer/react/empty";
import { TablePanel } from "capsomer/react/panel";
import { StatTile, StatTiles } from "capsomer/react/stat-tile";
import { Status } from "capsomer/react/status";
import "capsomer/table.css";

import { Time } from "capsomer/react/time";
import { MCP_CALLS_SHOWN, maskSecretsInText, outcomeWords, scopeWords } from "~/lib/admin/mcps";
import type { AdminApiKeyRow, AdminMcpCallRow, loadMcpOverview } from "~/lib/admin/mcps.server";
import { plural } from "@drdustinedwards/site-helpers/text";
import { merchantHref } from "~/lib/admin/page";
import { MCP_TOKEN_SCOPE } from "~/lib/auth/mcp-tokens";

const KEYS_HEADING_ID = "admin-mcps-keys-heading";
const TOOLS_HEADING_ID = "admin-mcps-tools-heading";
const CALLS_HEADING_ID = "admin-mcps-calls-heading";
// A link in a table cell is given a 24 px target (WCAG 2.2, 2.5.8).
const LINK = "fh-row-link";

// The MCP part of /admin/operations. It was its own page, /admin/mcps,
// with no row in the admin menu; Dustin had it folded into Operations on
// 2026-10-29. The family admin pattern (Capsomer patterns.md, Dustin's Q9 of
// 2026-10-14) and his review of 2026-10-11: the figures first, then Capsomer tables with plain sentence-case words, relative
// times with the exact time on hover, and a pending and an empty state on
// every list. Recova's page (app/admin/mcps/page.tsx, blob d0381e5f) is the
// inventory: the API keys table with its total and active count, and the tool
// coverage. Its hard-coded server status, tool counts and list of workspace
// connectors are not copied: the tools here are read
// from the merchant MCP's live registry, and the merchant MCP call log is
// Foxhound's own. Read only: nothing here issues or revokes a key, and no key
// material is read (app/lib/admin/mcps.server.ts).
export function AdminMcpPanels({
  data: { summary, keys, calls, tools },
  reading,
}: {
  data: Awaited<ReturnType<typeof loadMcpOverview>>;
  reading?: boolean;
}) {
  const writes = tools.filter((t) => t.writes).length;

  return (
    <div className="cap-stack" data-gap="6">
      <StatTiles label="MCP use">
        <StatTile
          label="API keys"
          figure={String(summary.keysTotal)}
          detail="Merchant and admin, revoked included"
        />
        <StatTile label="Active keys" figure={String(summary.keysActive)} detail="Not revoked" />
        <StatTile
          label="Calls"
          figure={String(summary.callsLast24h)}
          detail="Merchant MCP, in the last 24 hours"
        />
        <StatTile
          label="Failed calls"
          figure={String(summary.failedLast24h)}
          tone={summary.failedLast24h > 0 ? "crit" : undefined}
          detail="Refused or failed, in the last 24 hours"
        />
      </StatTiles>

      <div className="cap-stack" data-gap="6">
        <TablePanel
          title="API keys"
          headingId={KEYS_HEADING_ID}
          reading={reading}
          description={`${plural(keys.length, "key", "keys")}, ${summary.keysActive} active, newest first.`}
          reflow
          isEmpty={keys.length === 0}
          empty={
            <Empty kind="nothing-yet" title="No API keys yet.">
              A key appears here when a merchant creates one in their settings.
            </Empty>
          }
        >
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
        </TablePanel>

        <TablePanel
          title="Merchant tools"
          headingId={TOOLS_HEADING_ID}
          reading={reading}
          description={`${plural(tools.length, "tool", "tools")} in the merchant MCP's registry: ${tools.length - writes} read, ${writes} write.`}
          reflow
          isEmpty={tools.length === 0}
          empty={<Empty kind="nothing-yet" title="No merchant tools registered." />}
        >
          <table className="cap-table">
            <caption className="cap-sr-only">
              Merchant MCP tools, as the registry lists them.
            </caption>
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
                  <th scope="row" className="fh-mono fh-tiny fh-regular fh-break">
                    {t.name}
                  </th>
                  <td data-label="What it does" data-wrap="">
                    {t.title}
                  </td>
                  <td data-label="Access">
                    {t.writes ? (
                      <Status tone="info">Writes</Status>
                    ) : (
                      <Status tone="ok">Reads</Status>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TablePanel>

        <TablePanel
          title="Recent calls"
          headingId={CALLS_HEADING_ID}
          reading={reading}
          description={`Up to the newest ${MCP_CALLS_SHOWN} merchant MCP calls, every account. Arguments are not shown.`}
          reflow
          isEmpty={calls.length === 0}
          empty={
            <Empty kind="nothing-yet" title="No MCP calls yet.">
              Every tool call a merchant key makes is logged here.
            </Empty>
          }
        >
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
        </TablePanel>
      </div>
    </div>
  );
}

function AccountLink({ id, name }: { id: string; name: string | null }) {
  return (
    <Link to={merchantHref(id)} className={name ? LINK : `${LINK} fh-mono fh-tiny fh-break`}>
      {name ?? id}
    </Link>
  );
}

function KeyRow({ apiKey: k }: { apiKey: AdminApiKeyRow }) {
  return (
    <tr>
      <th scope="row" className="fh-regular">
        {k.label ?? <span className="fh-quiet">Unlabelled</span>}
      </th>
      <td data-label="Scope">{scopeWords(k.scope)}</td>
      <td data-label="Account">
        {k.accountId ? (
          <AccountLink id={k.accountId} name={k.accountName} />
        ) : (
          <span className="fh-soft">
            {k.scope === MCP_TOKEN_SCOPE.ADMIN ? "Platform" : "No account"}
          </span>
        )}
      </td>
      <td data-label="Status">
        {k.revokedAt ? <Status tone="nodata">Revoked</Status> : <Status tone="ok">Active</Status>}
      </td>
      <td data-label="Created">
        <Time at={k.createdAt} empty="never" tip />
      </td>
      <td data-label="Last used">
        <Time at={k.lastUsedAt} empty="never" tip />
      </td>
    </tr>
  );
}

function CallRow({ call: c }: { call: AdminMcpCallRow }) {
  return (
    <tr>
      <th scope="row" className="fh-mono fh-tiny fh-regular fh-break">
        {c.tool || <span className="fh-quiet">No tool named</span>}
      </th>
      <td data-label="Account">
        <AccountLink id={c.accountId} name={c.accountName} />
      </td>
      <td data-label="Key">
        {c.keyLabel ?? (
          <span className="fh-quiet">{c.keyFound ? "Unlabelled" : "Removed key"}</span>
        )}
      </td>
      <td data-label="Outcome">
        <Status tone={c.outcome === "ok" ? "ok" : "crit"}>{outcomeWords(c.outcome)}</Status>
      </td>
      <td data-label="When">
        <Time at={c.createdAt} empty="never" tip />
      </td>
      <td data-label="Error" data-wrap="" className={c.error ? "fh-error" : "fh-quiet"}>
        {c.error === null ? "None" : maskSecretsInText(c.error)}
      </td>
    </tr>
  );
}
