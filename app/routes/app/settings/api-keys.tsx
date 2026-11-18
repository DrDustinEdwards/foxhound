import { Table } from "capsomer/react/table";
import { plural } from "@drdustinedwards/site-helpers/text";
import { formatDate } from "capsomer/behavior/time";
import { useEffect, useId } from "react";
import { data, useNavigation, useSearchParams } from "react-router";
import { logEvent } from "@dustinedwards/site-runtime/log";
import { Link, routerRenderLink, ButtonLink } from "capsomer/react/link";
import { Alert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Empty } from "capsomer/react/empty";
import { Field } from "capsomer/react/field";
import { SettingsLayout } from "capsomer/react/settings-row";
import { Panel } from "capsomer/react/panel";
import "capsomer/banner.css";
import "capsomer/empty.css";
import "capsomer/table.css";

import { DemoForm } from "~/lib/demo/use-demo-guard";
import { NewApiKey } from "~/components/new-api-key";
import { getDb } from "~/db";
import { MEMBER_ROLE } from "~/lib/auth";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import {
  createAccountApiKey,
  listAccountApiKeys,
  listAccountMcpCalls,
  type AccountMcpCallRow,
  revokeAccountApiKey,
} from "~/lib/settings/api-keys.server";
import { API_KEY_LABEL_MAX_LENGTH } from "~/lib/settings/api-key-label";

import type { Route } from "./+types/api-keys";
import { NOINDEX } from "~/lib/seo/meta";
import { MCP_CALLS_SHOWN, outcomeWords } from "~/lib/admin/mcps";
import { readForm } from "@dustinedwards/site-runtime/body";
import { BODY_MAX_BYTES } from "~/lib/http/body";

// S29, /settings/api-keys. Legacy: api-keys/page.tsx (blob b50fb228, 624 bytes)
// and api-keys/ApiKeysClient.tsx (blob 338db3db, 10,371 bytes), with its API at
// app/api/settings/api-keys/route.ts (blob 81e694f5) and [id]/route.ts (blob
// d0d306ba).
//
// J34 rebuilt it from Capsomer 0.9.0's parts under Dustin's
// Q10 and Q11 answers of 2026-10-14: PageHead, Panel, Table, Field,
// Button, Empty and Alert, amber throughout. Recova stays the spec for what is
// here and in what order: the phone-only back link, the title and its line,
// one card holding the count and Generate new key, the load failure, the empty
// sentence, the four-column table, then the generate form or the one-time
// reveal with Copy key and Done.
//
// THE BACKEND CAME FIRST HERE, like S28: `issueMcpToken`, `verifyMcpToken` and
// `revokeMcpToken` have existed since Phase 3. This is the merchant-facing half.
// Every key made here is a merchant key (`createAccountApiKey`): Recova's admin
// scope picker is gone, because an Admin API key is the admin area's, behind
// Access (Mythos billing review, finding 4). A revoke is pinned to the account
// (`revokeAccountApiKey`), as legacy's handler is; both are pinned in
// test/settings-api-keys-s29.test.ts.
//
// THE SAME RESULT THROUGH A DIFFERENT SHAPE: legacy opens the
// form and reveals the key in client state over a JSON API; here the form opens
// at ?new=1 and the key comes back once on the action's response, so both work
// without script. Legacy's browser alert() on a failure is an inline Capsomer
// alert, and legacy's revoke still has no confirm, because a revoked key is
// recoverable by issuing another.
//
// OWNERS ONLY. A key can change the account's settings and brand voice, so
// only the account's owner creates or revokes one, as only an owner invites
// (/settings/team). Legacy let any member mint one; the August audit's S3.
//
// THE SECRET IS SHOWN ONCE. It lives only on the action's response and in the
// one <pre>; it is never logged, never put in a URL, and never stored (only its
// hash is, in issueMcpToken).

export function meta() {
  return [{ title: "API keys - Foxhound" }, NOINDEX];
}

function isOwner(auth: { membership: { role: string } }): boolean {
  return auth.membership.role === MEMBER_ROLE.OWNER;
}

/** The owner's own call log, or why it is not shown: a failed read says so rather than looking like no calls. */
type CallLog =
  | { state: "owner-only" }
  | { state: "failed" }
  | { state: "ok"; calls: AccountMcpCallRow[]; more: boolean; newer: boolean };

// THE CALL LOG (area 11, A15 and L9). Beside the keys an owner can revoke, what their agents did with them: every call
// the merchant /mcp logged for this account, newest first, a page at a time. Owners only, as creating and revoking are.
async function readCallLog(
  env: Env,
  accountId: string,
  owner: boolean,
  request: Request,
): Promise<CallLog> {
  if (!owner) return { state: "owner-only" };
  const raw = new URL(request.url).searchParams.get("calls_before");
  // `<ms>.<id>`, the last row of the page before; anything else is the first page.
  const cursor = raw ? /^(\d{1,15})\.([\w-]{1,64})$/.exec(raw) : null;
  const before = cursor ? { at: new Date(Number(cursor[1])), id: cursor[2]! } : undefined;
  try {
    const { calls, more } = await listAccountMcpCalls(getDb(env), accountId, before);
    return { state: "ok", calls, more, newer: before !== undefined };
  } catch (err) {
    logEvent(
      "mcp_call_log_read_failed",
      { error: err instanceof Error ? err.message : "unknown error" },
      { level: "error" },
    );
    return { state: "failed" };
  }
}

export async function loader({ context, request }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const callLog = await readCallLog(env, auth.membership.accountId, isOwner(auth), request);
  try {
    const keys = await listAccountApiKeys(getDb(env), auth.membership.accountId);
    return { keys, loadError: false, isOwner: isOwner(auth), callLog };
  } catch (err) {
    // Legacy's page shows "Couldn't load your API keys" when its read fails,
    // rather than an error page; this is that state. The message names the
    // failure only, never a key.
    console.error("api keys read failed:", err instanceof Error ? err.message : "unknown error");
    return { keys: null, loadError: true, isOwner: isOwner(auth), callLog };
  }
}

const OWNER_ONLY = "Only the account owner can create or revoke API keys.";

interface ActionResult {
  action: string;
  ok: boolean;
  error?: string;
  /** The plaintext token, returned ONCE and never stored. Only ever present on
   *  the response to the request that created it. */
  rawKey?: string;
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const accountId = auth.membership.accountId;
  const db = getDb(env);
  const form = await readForm(request, BODY_MAX_BYTES);
  const intent = String(form.get("_action") ?? "");

  if (!isOwner(auth)) {
    return data<ActionResult>({ action: intent, ok: false, error: OWNER_ONLY }, { status: 403 });
  }

  if (intent === "create") {
    const label = String(form.get("label") ?? "").trim();
    if (!label) {
      return data<ActionResult>(
        {
          action: intent,
          ok: false,
          error: "Name the key so you can tell it apart later.",
        },
        { status: 400 },
      );
    }
    if (label.length > API_KEY_LABEL_MAX_LENGTH) {
      return data<ActionResult>(
        {
          action: intent,
          ok: false,
          error: `Name must be ${API_KEY_LABEL_MAX_LENGTH} characters or fewer.`,
        },
        { status: 400 },
      );
    }
    const issued = await createAccountApiKey(db, accountId, label);
    return data<ActionResult>({
      action: intent,
      ok: true,
      rawKey: issued.token,
    });
  }

  if (intent === "revoke") {
    const keyId = String(form.get("keyId") ?? "").trim();
    if (!keyId) {
      return data<ActionResult>(
        { action: intent, ok: false, error: "Select a key to revoke." },
        { status: 400 },
      );
    }
    const revoked = await revokeAccountApiKey(db, accountId, keyId);
    if (!revoked) {
      return data<ActionResult>(
        {
          action: intent,
          ok: false,
          error: "That key is not on this account.",
        },
        { status: 403 },
      );
    }
    return data<ActionResult>({ action: intent, ok: true });
  }

  return data<ActionResult>(
    { action: intent, ok: false, error: "Unknown settings action." },
    { status: 400 },
  );
}

function dateOrNever(at: Date | null): string {
  return at ? (formatDate(new Date(at), { style: "medium" }) ?? "") : "Never";
}

/** Generate new key stays where it is while the form or the key is open, as
 *  legacy's does, but cannot be pressed. Capsomer's disabled button keeps focus
 *  and says why; the reason is read by a screen reader, not shown, because
 *  legacy shows none. */
function GenerateDisabled() {
  const reason = useId();
  return (
    <>
      <button
        type="button"
        className="cap-btn"
        data-variant="primary"
        aria-disabled="true"
        aria-describedby={reason}
      >
        Generate new key
      </button>
      <span id={reason} className="cap-sr-only">
        Finish with the key below first.
      </span>
    </>
  );
}

function GenerateForm({ error }: { error?: string }) {
  const navigation = useNavigation();
  const generating =
    navigation.state !== "idle" && navigation.formData?.get("_action") === "create";
  const name = useId();

  // Opening the form is a navigation to ?new=1, which leaves focus on the page;
  // it moves to the one field the form needs. Invisible.
  useEffect(() => {
    document.getElementById(name)?.focus();
  }, [name]);

  return (
    <Panel title="Generate a new API key">
      <DemoForm method="post" className="cap-stack" data-gap="5">
        <input type="hidden" name="_action" value="create" />
        <Field label="Name" error={error} announce>
          <input
            id={name}
            name="label"
            type="text"
            className="cap-input"
            required
            maxLength={API_KEY_LABEL_MAX_LENGTH}
            placeholder="e.g. My Claude agent"
            autoComplete="off"
          />
        </Field>
        <div className="cap-cluster" data-gap="4">
          <Button type="submit" variant="primary" pending={generating}>
            {generating ? "Generating..." : "Generate key"}
          </Button>
          <ButtonLink to="?" variant="quiet">
            Cancel
          </ButtonLink>
        </div>
      </DemoForm>
    </Panel>
  );
}

export default function ApiKeySettings({ loaderData, actionData }: Route.ComponentProps) {
  const { keys, loadError, isOwner: owner, callLog } = loaderData;
  const result = actionData as ActionResult | undefined;
  const navigation = useNavigation();
  const revoking =
    navigation.state !== "idle" && navigation.formData?.get("_action") === "revoke"
      ? String(navigation.formData.get("keyId") ?? "")
      : null;
  const creating = useSearchParams()[0].get("new") === "1";
  const rawKey = result?.action === "create" && result.ok ? result.rawKey : undefined;
  const panelOpen = creating || rawKey !== undefined;
  const createError = result?.action === "create" && !result.ok ? result.error : undefined;
  const revokeError = result?.action === "revoke" && !result.ok ? result.error : undefined;

  return (
    <SettingsLayout renderLink={routerRenderLink} title="API Keys">
      <section className="cap-panel">
        <div className="cap-panel-body">
          <div className="fh-keys-head">
            {keys ? (
              <p className="fh-small fh-soft">{plural(keys.length, "active key")}</p>
            ) : (
              <span />
            )}
            {!owner ? (
              <p className="fh-small fh-soft">{OWNER_ONLY}</p>
            ) : panelOpen ? (
              <GenerateDisabled />
            ) : (
              <ButtonLink to="?new=1" variant="primary">
                Generate new key
              </ButtonLink>
            )}
          </div>

          {loadError ? (
            <Alert tone="crit">
              {"Couldn't load your API keys. Refresh the page or try again later."}
            </Alert>
          ) : null}
          {revokeError ? <Alert tone="crit">{revokeError}</Alert> : null}
          <p role="status" className="cap-sr-only">
            {result?.action === "revoke" && result.ok ? "Key revoked." : ""}
          </p>

          {keys && keys.length === 0 && !panelOpen ? (
            <Empty kind="nothing-yet" flush title="No API keys yet." />
          ) : null}

          {keys && keys.length > 0 ? (
            <Table caption="API keys" captionHidden reflow>
              <thead>
                <tr>
                  <th scope="col">Label</th>
                  <th scope="col">Created</th>
                  <th scope="col">Last used</th>
                  <th scope="col" data-num>
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id}>
                    <th scope="row">{k.label}</th>
                    <td data-label="Created">{dateOrNever(k.createdAt)}</td>
                    <td data-label="Last used">{dateOrNever(k.lastUsedAt)}</td>
                    <td data-label="Actions" data-num>
                      {owner ? (
                        <DemoForm method="post">
                          <input type="hidden" name="_action" value="revoke" />
                          <input type="hidden" name="keyId" value={k.id} />
                          <Button type="submit" size="xs" pending={revoking === k.id}>
                            Revoke key
                            <span className="sr-only"> {k.label}</span>
                          </Button>
                        </DemoForm>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : null}

          {rawKey !== undefined ? <NewApiKey rawKey={rawKey} /> : null}
          {owner && creating && rawKey === undefined ? <GenerateForm error={createError} /> : null}
        </div>
      </section>

      {callLog.state === "owner-only" ? null : <CallLogPanel log={callLog} />}
    </SettingsLayout>
  );
}

/** What the account's agents did, newest first: the time, the tool, the key and whether it worked. */
function CallLogPanel({ log }: { log: Exclude<CallLog, { state: "owner-only" }> }) {
  const headingId = useId();
  const last = log.state === "ok" ? log.calls.at(-1) : undefined;
  return (
    <section className="fh-keys-panel cap-panel" aria-labelledby={headingId}>
      <div className="cap-panel-body">
        <h2 id={headingId} className="">
          Agent activity
        </h2>
        <p className="fh-small fh-soft">
          Every call an agent made with this account&apos;s keys, newest first, {MCP_CALLS_SHOWN} at
          a time. Revoke a key above to stop an agent.
        </p>
        {log.state === "failed" ? (
          <Alert tone="crit">
            {"Couldn't load the agent activity. Refresh the page or try again later."}
          </Alert>
        ) : log.calls.length === 0 ? (
          <Empty
            kind="nothing-yet"
            flush
            title={
              log.newer ? "No older calls." : "No agent has called Foxhound with these keys yet."
            }
          />
        ) : (
          <Table caption="Agent activity" captionHidden reflow>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Tool</th>
                <th scope="col">Key</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {log.calls.map((call) => (
                <tr key={call.id}>
                  <th scope="row">
                    {formatDate(new Date(call.createdAt), { style: "medium", time: true }) ?? ""}
                  </th>
                  <td data-label="Tool" className="fh-mono">
                    {call.tool}
                  </td>
                  <td data-label="Key">{call.keyLabel ?? "A deleted key"}</td>
                  <td data-label="Result">
                    {outcomeWords(call.outcome)}
                    {call.error ? <span className="fh-line fh-soft">{call.error}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {log.state === "ok" && (log.more || log.newer) ? (
          <div className="fh-keys-actions">
            {log.newer ? <Link to="?">Newest calls</Link> : null}
            {log.more && last ? (
              <Link to={`?calls_before=${new Date(last.createdAt).getTime()}.${last.id}`}>
                Older calls
              </Link>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
