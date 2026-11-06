import { data, Form, useNavigation } from "react-router";

import { AdminTime } from "~/components/admin-time";
import { Badge } from "~/components/badge";
import { getDb } from "~/db";
import {
  confirmStagedChange,
  describeStaged,
  listStagedChanges,
  rejectStagedChange,
  stagedConfirmPhrase,
} from "~/lib/admin/staged.server";
import { adminContext } from "~/lib/admin/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import type { AdminHandle } from "~/lib/admin/page";

import type { Route } from "./+types/staged";
import { NOINDEX } from "~/lib/seo/meta";
import { readForm } from "~/lib/http/body";

// /admin/staged: the changes the Foxhound Admin API was
// asked for that start or change money, waiting for a person. Confirming one
// applies it under the SIGNED-IN admin, through the same helper the matching
// screen uses, and asks for the same typed phrase where that screen does.

export const handle: AdminHandle = { page: "Staged changes" };

export function meta() {
  return [{ title: "Staged changes - Foxhound admin" }, NOINDEX];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const [pending, recent] = await Promise.all([listStagedChanges(db, "pending"), listStagedChanges(db, null, 50)]);
  return {
    pending: pending.map((row) => ({ ...row, summary: describeStaged(row), phrase: stagedConfirmPhrase(row) })),
    recent: recent
      .filter((row) => row.status !== "pending")
      .map((row) => ({ ...row, summary: describeStaged(row) })),
  };
}

interface ActionResult {
  ok: boolean;
  error?: string;
  message?: string;
}

export async function action({ context, request }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(adminContext);
  const db = getDb(env);

  const form = await readForm(request);
  const intent = String(form.get("intent") ?? "");
  const id = String(form.get("id") ?? "");
  const now = new Date();

  if (intent === "confirm") {
    const result = await confirmStagedChange(env, {
      id,
      actorEmail: auth.email,
      confirmPhrase: String(form.get("confirm") ?? ""),
      now,
    });
    return result.ok
      ? data<ActionResult>({ ok: true, message: `Applied: ${describeStaged(result.value)}.` })
      : data<ActionResult>({ ok: false, error: result.error }, { status: 400 });
  }
  if (intent === "reject") {
    const result = await rejectStagedChange(db, { id, actorEmail: auth.email, now });
    return result.ok
      ? data<ActionResult>({ ok: true, message: "Rejected. Nothing was changed." })
      : data<ActionResult>({ ok: false, error: result.error }, { status: 400 });
  }
  return data<ActionResult>({ ok: false, error: `Unknown action: ${intent}` }, { status: 400 });
}

const STATUS_TONE = { confirmed: "success", rejected: "neutral", failed: "failure" } as const;

export default function AdminStaged({ loaderData, actionData }: Route.ComponentProps) {
  const { pending, recent } = loaderData;
  const busy = useNavigation().state !== "idle";

  return (
    <div>

      <p className="mb-4 text-body text-text-tertiary">
        Changes the admin AI asked for that start or change money. Nothing here has happened yet.
        Confirming one applies it now, under your name.
      </p>

      {actionData && !actionData.ok && actionData.error ? (
        <p role="alert" className="mb-4 rounded-md border border-red bg-red-bg px-3 py-2 text-label text-error-text">
          {actionData.error}
        </p>
      ) : null}
      {actionData && actionData.ok && actionData.message ? (
        <p role="status" className="mb-4 rounded-md border border-border bg-surface px-3 py-2 text-label text-text">
          {actionData.message}
        </p>
      ) : null}

      {pending.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-body text-text-tertiary">
          Nothing is waiting.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {pending.map((row) => (
            <div key={row.id} className="rounded-lg border border-border bg-surface p-4">
              <p className="text-body text-text">{row.summary}</p>
              <p className="mt-1 text-label text-text-tertiary">
                Asked for by {row.requestedBy} via {row.requestedVia}, <AdminTime at={row.requestedAt} />
                {row.note ? `: ${row.note}` : ""}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Form method="post" className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="intent" value="confirm" />
                  <input type="hidden" name="id" value={row.id} />
                  {row.phrase ? (
                    <>
                      <label htmlFor={`confirm-${row.id}`} className="text-label text-text-secondary">
                        Type <span className="font-mono text-text">{row.phrase}</span> to confirm
                      </label>
                      <input
                        id={`confirm-${row.id}`}
                        name="confirm"
                        type="text"
                        autoComplete="off"
                        required
                        placeholder={row.phrase}
                        className="rounded-md border border-border bg-bg px-3 py-1.5 font-mono text-label text-text placeholder:text-text-subtle"
                      />
                    </>
                  ) : null}
                  <button
                    type="submit"
                    disabled={busy}
                    className="rounded-md border border-red px-3 py-1.5 text-label text-error-text hover:bg-red-bg disabled:opacity-60"
                  >
                    Confirm
                  </button>
                </Form>
                <Form method="post">
                  <input type="hidden" name="intent" value="reject" />
                  <input type="hidden" name="id" value={row.id} />
                  <button
                    type="submit"
                    disabled={busy}
                    className="rounded-md border border-border px-3 py-1.5 text-label text-text hover:border-brand disabled:opacity-60"
                  >
                    Reject
                  </button>
                </Form>
              </div>
            </div>
          ))}
        </div>
      )}

      {recent.length > 0 ? (
        <>
          <h2 className="mb-3 mt-8 text-label font-semibold text-text">Decided</h2>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-label">
              <tbody>
                {recent.map((row) => (
                  <tr key={row.id} className="border-b border-border-sub last:border-0">
                    <td className="px-4 py-3 text-text">{row.summary}</td>
                    <td className="px-4 py-3">
                      <Badge tone={STATUS_TONE[row.status as keyof typeof STATUS_TONE] ?? "neutral"}>{row.status}</Badge>
                    </td>
                    <td className="px-4 py-3 text-text-tertiary">{row.decidedBy ?? "-"}</td>
                    <td className="px-4 py-3 text-text-tertiary"><AdminTime at={row.decidedAt} empty="-" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
