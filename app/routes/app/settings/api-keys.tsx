import { useEffect, useId, useRef, useState } from "react";
import { data, Link, useNavigation, useSearchParams } from "react-router";
import { ArrowLeft } from "lucide-react";
import { Alert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Empty } from "capsomer/react/empty";
import { Field } from "capsomer/react/field";
import { PageHead } from "capsomer/react/page-head";
import { Panel } from "capsomer/react/panel";
import { Segmented } from "capsomer/react/segmented";
import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/empty.css";
import "capsomer/field.css";
import "capsomer/page-head.css";
import "capsomer/panel.css";
import "capsomer/segmented.css";
import "capsomer/table.css";
// Capsomer's tokens and the amber family, which the components above read. The
// shell loads the same file through its header; importing it here keeps the
// page whole under any layout, as /help does.
import "~/site-header.css";

import { DemoGuardedForm } from "~/components/demo-guarded-form";
import { getDb } from "~/db";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import {
  createAccountApiKey,
  listAccountApiKeys,
  revokeAccountApiKey,
} from "~/lib/settings/api-keys.server";
import { API_KEY_LABEL_MAX_LENGTH } from "~/lib/settings/api-key-label";

import type { Route } from "./+types/api-keys";

// S29, /settings/api-keys. Legacy: api-keys/page.tsx (blob b50fb228, 624 bytes)
// and api-keys/ApiKeysClient.tsx (blob 338db3db, 10,371 bytes), with its API at
// app/api/settings/api-keys/route.ts (blob 81e694f5) and [id]/route.ts (blob
// d0d306ba).
//
// J34 (job_cc3655778b55) rebuilt it from Capsomer 0.9.0's parts under Dustin's
// Q10 and Q11 answers of 2026-10-14: PageHead, Panel, Table, Field, Segmented,
// Button, Empty and Alert, amber throughout. Recova stays the spec for what is
// here and in what order: the phone-only back link, the title and its line,
// one card holding the count and Generate new key, the load failure, the empty
// sentence, the four-column table, then the generate form or the one-time
// reveal with Copy key and Done.
//
// THE BACKEND CAME FIRST HERE, like S28: `issueMcpToken`, `verifyMcpToken` and
// `revokeMcpToken` have existed since Phase 3. This is the merchant-facing half.
// The scope is the session's (`createAccountApiKey`) and a revoke is pinned to
// the account (`revokeAccountApiKey`); legacy's handlers check both too, and
// both are pinned in test/settings-api-keys-s29.test.ts.
//
// THE SAME RESULT THROUGH A DIFFERENT SHAPE (RULES.md 1.2): legacy opens the
// form and reveals the key in client state over a JSON API; here the form opens
// at ?new=1 and the key comes back once on the action's response, so both work
// without script. Legacy's browser alert() on a failure is an inline Capsomer
// alert, and legacy's revoke still has no confirm, because a revoked key is
// recoverable by issuing another.
//
// THE SECRET IS SHOWN ONCE. It lives only on the action's response and in the
// one <pre>; it is never logged, never put in a URL, and never stored (only its
// hash is, in issueMcpToken).

export function meta() {
  return [{ title: "API keys - Foxhound" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  try {
    const keys = await listAccountApiKeys(
      getDb(env),
      auth.membership.accountId,
    );
    return { keys, loadError: false, isAdmin: auth.isAdmin };
  } catch (err) {
    // Legacy's page shows "Couldn't load your API keys" when its read fails,
    // rather than an error page; this is that state. The message names the
    // failure only, never a key.
    console.error(
      "api keys read failed:",
      err instanceof Error ? err.message : "unknown error",
    );
    return { keys: null, loadError: true, isAdmin: auth.isAdmin };
  }
}

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
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "");

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
    // `auth.isAdmin` is the session's, never the form's.
    const issued = await createAccountApiKey(
      db,
      accountId,
      label,
      String(form.get("scope") ?? "") === "admin",
      auth.isAdmin,
    );
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

function formatDate(at: Date | null): string {
  if (!at) return "Never";
  return new Date(at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Legacy's SettingsBackLink (components/SettingsBackLink.tsx, blob 64d4a153):
 *  on a phone, where the settings menu is hidden, a link back to the hub. */
function SettingsBackLink() {
  return (
    <Link
      to="/settings"
      className="mb-6 inline-flex min-h-6 items-center gap-1.5 text-label text-text-secondary no-underline hover:text-text md:hidden"
    >
      <ArrowLeft className="h-4 w-4" strokeWidth={2} aria-hidden />
      Settings
    </Link>
  );
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
      <span id={reason} className="sr-only">
        Finish with the key below first.
      </span>
    </>
  );
}

function ScopePicker() {
  const [scope, setScope] = useState<"merchant" | "admin">("merchant");
  const warning = useId();
  return (
    <div>
      <Segmented
        legend="Scope"
        name="scope"
        value={scope}
        onChange={setScope}
        describedBy={scope === "admin" ? warning : undefined}
        options={[
          { value: "merchant", label: "Merchant" },
          { value: "admin", label: "Admin" },
        ]}
      />
      {scope === "admin" ? (
        <p id={warning} className="cap-field-help">
          Admin keys are platform-wide and can access any merchant account. Use with care.
        </p>
      ) : null}
    </div>
  );
}

function RevealKey({ rawKey }: { rawKey: string }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const heading = useId();
  const keyBlock = useRef<HTMLPreElement>(null);

  // The form that had focus is gone once the key shows, which would drop focus
  // to the page. It moves to the key instead, named by the panel's heading, so a
  // keyboard or screen reader lands on what has to be copied. Nothing visible
  // changes (RULES.md 1.5).
  useEffect(() => {
    keyBlock.current?.focus();
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copyKey() {
    try {
      await navigator.clipboard.writeText(rawKey);
      setCopyFailed(false);
      setCopied(true);
    } catch {
      setCopyFailed(true);
    }
  }

  return (
    <Panel title="Your new API key" headingId={heading}>
      {/* Capsomer 0.9.0 has no code block for a secret to copy; this is
          legacy's <pre>, on Foxhound's tokens, until it does. */}
      <pre
        ref={keyBlock}
        tabIndex={-1}
        aria-labelledby={heading}
        className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-border bg-surface p-4 font-mono text-micro text-text"
      >
        {rawKey}
      </pre>
      <p className="cap-field-help">
        This key will not be shown again. Copy it now and store it somewhere
        safe.
      </p>
      {copyFailed ? (
        <Alert tone="crit">
          {
            "Couldn't copy the key to your clipboard. Select and copy it manually."
          }
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={copyKey}>{copied ? "Copied" : "Copy key"}</Button>
        <Link to="?" className="cap-btn" data-variant="quiet">
          Done
        </Link>
      </div>
      <p role="status" className="sr-only">
        {copied ? "Copied" : ""}
      </p>
    </Panel>
  );
}

function GenerateForm({
  isAdmin,
  error,
}: {
  isAdmin: boolean;
  error?: string;
}) {
  const navigation = useNavigation();
  const generating =
    navigation.state !== "idle" &&
    navigation.formData?.get("_action") === "create";
  const name = useId();

  // Opening the form is a navigation to ?new=1, which leaves focus on the page;
  // it moves to the one field the form needs. Invisible (RULES.md 1.5).
  useEffect(() => {
    document.getElementById(name)?.focus();
  }, [name]);

  return (
    <Panel title="Generate a new API key">
      <DemoGuardedForm method="post" className="flex flex-col gap-4">
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
        {isAdmin ? <ScopePicker /> : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" pending={generating}>
            {generating ? "Generating..." : "Generate key"}
          </Button>
          <Link to="?" className="cap-btn" data-variant="quiet">
            Cancel
          </Link>
        </div>
      </DemoGuardedForm>
    </Panel>
  );
}

export default function ApiKeySettings({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { keys, loadError, isAdmin } = loaderData;
  const result = actionData as ActionResult | undefined;
  const navigation = useNavigation();
  const revoking =
    navigation.state !== "idle" &&
    navigation.formData?.get("_action") === "revoke"
      ? String(navigation.formData.get("keyId") ?? "")
      : null;
  const creating = useSearchParams()[0].get("new") === "1";
  const rawKey =
    result?.action === "create" && result.ok ? result.rawKey : undefined;
  const panelOpen = creating || rawKey !== undefined;
  const createError =
    result?.action === "create" && !result.ok ? result.error : undefined;
  const revokeError =
    result?.action === "revoke" && !result.ok ? result.error : undefined;

  return (
    <>
      <SettingsBackLink />
      {/* Legacy's PageHeader leaves 32px under the head (mb-8); the wrapper
          keeps that space without styling Capsomer's head. */}
      <div className="mb-8">
        <PageHead
          title="API Keys"
          lead={
            <>
              Connect an AI agent to this account&apos;s Foxhound data at{" "}
              <span className="font-mono">/mcp</span>. A key lets an agent read your audit runs,
              recovery, disputes, billing and customer health, and change your settings: audit,
              features, notifications, your sender name, your brand voice, your business context,
              and the alerts it can create, switch off and delete. Leaving a field out of
              the brand voice or business context leaves it as it is. Every change it makes is logged with the key that
              made it. It cannot move money, submit dispute evidence, disconnect Stripe or
              cancel your account, and customer names and full email addresses are never sent.
            </>
          }
        />
      </div>

      <section className="cap-panel">
        <div className="cap-panel-body">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {keys ? (
              <p className="text-label text-text-secondary">
                {keys.length} active {keys.length === 1 ? "key" : "keys"}
              </p>
            ) : (
              <span />
            )}
            {panelOpen ? (
              <GenerateDisabled />
            ) : (
              <Link to="?new=1" className="cap-btn" data-variant="primary">
                Generate new key
              </Link>
            )}
          </div>

          {loadError ? (
            <Alert tone="crit">
              {
                "Couldn't load your API keys. Refresh the page or try again later."
              }
            </Alert>
          ) : null}
          {revokeError ? <Alert tone="crit">{revokeError}</Alert> : null}
          <p role="status" className="sr-only">
            {result?.action === "revoke" && result.ok ? "Key revoked." : ""}
          </p>

          {keys && keys.length === 0 && !panelOpen ? (
            <Empty
              kind="nothing-yet"
              flush
              title="No API keys yet. Generate one to get started."
            />
          ) : null}

          {keys && keys.length > 0 ? (
            <div
              className="cap-table-wrap"
              data-cap="table"
              role="region"
              aria-label="API keys"
              tabIndex={0}
            >
              <table className="cap-table">
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
                      <td>{formatDate(k.createdAt)}</td>
                      <td>{formatDate(k.lastUsedAt)}</td>
                      <td data-num>
                        <DemoGuardedForm method="post">
                          <input type="hidden" name="_action" value="revoke" />
                          <input type="hidden" name="keyId" value={k.id} />
                          <Button
                            type="submit"
                            size="xs"
                            pending={revoking === k.id}
                          >
                            Revoke key
                            <span className="sr-only"> {k.label}</span>
                          </Button>
                        </DemoGuardedForm>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {rawKey !== undefined ? <RevealKey rawKey={rawKey} /> : null}
          {creating && rawKey === undefined ? (
            <GenerateForm isAdmin={isAdmin} error={createError} />
          ) : null}
        </div>
      </section>
    </>
  );
}
