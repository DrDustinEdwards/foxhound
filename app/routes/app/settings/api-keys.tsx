import { data, useNavigation, useSearchParams } from "react-router";

import { Alert } from "~/components/auth-ui";
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
// and api-keys/ApiKeysClient.tsx (blob 338db3db, 10,371 bytes).
//
// THE BACKEND CAME FIRST HERE, like S28: `issueMcpToken`, `verifyMcpToken` and
// `revokeMcpToken` have existed since Phase 3, whose own header says "the
// HTTP/MCP endpoints that call them are Phase 7 and are NOT built here". This
// is the merchant-facing half.
//
// TWO TRANSPORT FIXES, both the S8 class (a guard that lives only in the
// client), both recorded rather than ported:
//
// 1. LEGACY'S SCOPE IS CLIENT-GATED ONLY. It renders the Merchant/Admin picker
//    behind `isAdmin`, then its handler reads `body.scope` from the request, so
//    a non-admin who posts `scope: 'admin'` receives a PLATFORM-WIDE key that
//    can read any merchant. Here the scope is decided from the session's own
//    admin flag in `createAccountApiKey`, and the form field is advisory.
// 2. LEGACY REVOKES BY ID WITH NO ACCOUNT SCOPE, and Foxhound's own
//    `revokeMcpToken(db, keyId)` has the same shape. `revokeAccountApiKey` pins
//    account_id, so one merchant cannot revoke another's integration.
//
// Legacy also alerts() on failure and revokes with no confirm. The alert is
// replaced by an inline error; the missing confirm is legacy's and is kept,
// because a revoked key is recoverable by issuing another and the two-step
// confirm is reserved for what is not.

export function meta() {
  return [{ title: "API keys - Foxhound" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const keys = await listAccountApiKeys(getDb(env), auth.membership.accountId);
  return { keys, isAdmin: auth.isAdmin };
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
        { action: intent, ok: false, error: "Name the key so you can tell it apart later." },
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
    return data<ActionResult>({ action: intent, ok: true, rawKey: issued.token });
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
        { action: intent, ok: false, error: "That key is not on this account." },
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
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const TH = "px-2 py-3 text-left font-mono text-micro uppercase tracking-wide text-text-tertiary";
const TD = "px-2 py-3 text-label";

export default function ApiKeySettings({ loaderData, actionData }: Route.ComponentProps) {
  const { keys, isAdmin } = loaderData;
  const result = actionData as ActionResult | undefined;
  const busy = useNavigation().state !== "idle";
  const creating = useSearchParams()[0].get("new") === "1";
  const rawKey = result?.action === "create" && result.ok ? result.rawKey : undefined;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-8">
      <header>
        <h1 className="text-h2 text-text">API keys</h1>
        <p className="mt-1 text-label text-text-tertiary">
          Connect an AI agent to this account's Foxhound data at{" "}
          <span className="font-mono">/mcp</span>. A key lets an agent read your audit runs,
          recovery, disputes, billing and customer health, and change eight settings: audit,
          features, notifications, your sender name, your brand voice, your business context,
          and the alerts it can create, switch off and delete. Leaving a field out of a
          change leaves it as it is. Every change it makes is logged with the key that
          made it. It cannot move money, submit dispute evidence, disconnect Stripe or
          cancel your account, and customer names and full email addresses are never sent.
        </p>
      </header>

      <section className="rounded-lg border border-border bg-surface p-5">
        {result && !result.ok && result.error ? <Alert tone="error">{result.error}</Alert> : null}
        {result?.action === "revoke" && result.ok ? <Alert tone="success">Key revoked.</Alert> : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-label text-text-secondary">
            {keys.length} active {keys.length === 1 ? "key" : "keys"}
          </div>
          {creating || rawKey ? null : (
            <a
              href="?new=1"
              className="rounded-md bg-amber px-4 py-2 text-label font-semibold text-on-amber no-underline transition-opacity duration-500 hover:opacity-80"
            >
              Generate new key
            </a>
          )}
        </div>

        {keys.length === 0 && !creating && !rawKey ? (
          <p className="py-8 text-center text-label text-text-subtle">
            No API keys yet. Generate one to get started.
          </p>
        ) : null}

        {keys.length > 0 ? (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className={TH}>Label</th>
                  <th className={TH}>Created</th>
                  <th className={TH}>Last used</th>
                  <th className={`${TH} text-right`}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id} className="border-t border-border">
                    <td className={`${TD} text-text`}>{k.label}</td>
                    <td className={`${TD} font-mono text-text-subtle`}>{formatDate(k.createdAt)}</td>
                    <td className={`${TD} font-mono text-text-subtle`}>{formatDate(k.lastUsedAt)}</td>
                    <td className={`${TD} text-right`}>
                      <DemoGuardedForm method="post">
                        <input type="hidden" name="_action" value="revoke" />
                        <input type="hidden" name="keyId" value={k.id} />
                        <button
                          type="submit"
                          disabled={busy}
                          className="rounded-full border border-border px-3 py-0.5 font-mono text-micro text-text-subtle transition-colors duration-150 hover:border-text-tertiary disabled:opacity-60"
                        >
                          Revoke key
                        </button>
                      </DemoGuardedForm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {rawKey ? (
          <div className="mt-6 rounded-lg border border-border p-5">
            <p className="text-label font-medium text-text">Your new API key</p>
            <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-border bg-surface p-4 font-mono text-micro text-text">
              {rawKey}
            </pre>
            <p className="mt-3 text-micro text-amber">
              This key will not be shown again. Copy it now and store it somewhere safe.
            </p>
            <div className="mt-4">
              <a
                href="?"
                className="rounded-md border border-border px-3 py-1.5 text-label text-text-subtle no-underline transition-colors duration-150 hover:border-text-tertiary"
              >
                Done
              </a>
            </div>
          </div>
        ) : null}

        {creating && !rawKey ? (
          <DemoGuardedForm
            method="post"
            className="mt-6 flex flex-col gap-4 rounded-lg border border-border p-5"
          >
            <input type="hidden" name="_action" value="create" />
            <p className="text-label font-medium text-text">Generate a new API key</p>
            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Name</span>
              <input
                name="label"
                type="text"
                required
                maxLength={API_KEY_LABEL_MAX_LENGTH}
                placeholder="e.g. My AI agent"
                className="rounded-md border border-border bg-surface px-3 py-2 text-label text-text placeholder:text-text-subtle focus-visible:border-amber"
              />
            </label>

            {isAdmin ? (
              <fieldset className="flex flex-col gap-1.5 border-0 p-0">
                <legend className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
                  Scope
                </legend>
                <div className="mt-1.5 flex gap-4">
                  <label className="flex items-center gap-2 text-label text-text">
                    <input type="radio" name="scope" value="merchant" defaultChecked />
                    Merchant
                  </label>
                  <label className="flex items-center gap-2 text-label text-text">
                    <input type="radio" name="scope" value="admin" />
                    Admin
                  </label>
                </div>
                <span className="text-micro text-amber">
                  Admin keys are platform wide and can reach any merchant account. Use with care.
                </span>
              </fieldset>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={busy}
                className="rounded-md bg-amber px-4 py-2 text-label font-semibold text-on-amber transition-opacity duration-500 hover:opacity-80 disabled:opacity-60"
              >
                {busy ? "Generating..." : "Generate key"}
              </button>
              <a href="?" className="text-label text-text-subtle no-underline hover:opacity-80">
                Cancel
              </a>
            </div>
          </DemoGuardedForm>
        ) : null}
      </section>
    </div>
  );
}
