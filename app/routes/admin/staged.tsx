import { data, Form, useNavigation } from "react-router";
import { Alert, Banner } from "capsomer/react/banner";
import { Empty } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { Pill } from "capsomer/react/status";
import { Time } from "capsomer/react/time";
import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/field.css";
import "capsomer/status.css";

import { ConfirmPhraseField } from "~/components/admin-confirm-phrase";
import { BADGE_PILL } from "~/lib/recovery/labels";
import { getDb } from "~/db";
import {
  confirmStagedChange,
  describeStaged,
  listStagedChanges,
  rejectStagedChange,
  stagedConfirmPhrase,
} from "~/lib/admin/staged.server";
import { adminContext } from "~/lib/admin/context";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import type { AdminHandle } from "~/lib/admin/page";

import type { Route } from "./+types/staged";
import { NOINDEX } from "~/lib/seo/meta";
import { readForm } from "@dustinedwards/site-runtime/body";
import { BODY_MAX_BYTES } from "~/lib/http/body";

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
  const [pending, recent] = await Promise.all([
    listStagedChanges(db, "pending"),
    listStagedChanges(db, null, 50),
  ]);
  return {
    pending: pending.map((row) => ({
      ...row,
      summary: describeStaged(row),
      phrase: stagedConfirmPhrase(row),
    })),
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

  const form = await readForm(request, BODY_MAX_BYTES);
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
const DECIDED_HEADING_ID = "admin-staged-decided";

export default function AdminStaged({ loaderData, actionData }: Route.ComponentProps) {
  const { pending, recent } = loaderData;
  const busy = useNavigation().state !== "idle";

  return (
    <div className="cap-stack" data-gap="6">
      <p className="fh-body fh-quiet">
        Changes the admin AI asked for that start or change money. Nothing here has happened yet.
        Confirming one applies it now, under your name.
      </p>

      {actionData && !actionData.ok && actionData.error ? <Alert>{actionData.error}</Alert> : null}
      {actionData && actionData.ok && actionData.message ? (
        <Banner tone="ok">{actionData.message}</Banner>
      ) : null}

      {pending.length === 0 ? (
        <Empty kind="all-clear" title="Nothing is waiting." />
      ) : (
        pending.map((row) => (
          <Panel
            key={row.id}
            title={row.summary}
            description={
              <>
                Asked for by {row.requestedBy} via {row.requestedVia},{" "}
                <Time at={row.requestedAt} empty="never" tip />
                {row.note ? `: ${row.note}` : ""}
              </>
            }
          >
            <div className="cap-cluster">
              <Form method="post">
                <input type="hidden" name="intent" value="confirm" />
                <input type="hidden" name="id" value={row.id} />
                {row.phrase ? (
                  <ConfirmPhraseField phrase={row.phrase}>
                    <ConfirmButton busy={busy} />
                  </ConfirmPhraseField>
                ) : (
                  <ConfirmButton busy={busy} />
                )}
              </Form>
              <Form method="post" className="fh-staged-submit">
                <input type="hidden" name="intent" value="reject" />
                <input type="hidden" name="id" value={row.id} />
                <button type="submit" className="cap-btn" disabled={busy}>
                  Reject
                </button>
              </Form>
            </div>
          </Panel>
        ))
      )}

      {recent.length > 0 ? (
        <Panel title="Decided" headingId={DECIDED_HEADING_ID} flush>
          <div
            className="cap-table-wrap"
            data-reflow="medium"
            role="region"
            aria-labelledby={DECIDED_HEADING_ID}
            tabIndex={0}
          >
            <table className="cap-table">
              <caption className="cap-sr-only">
                Staged changes already confirmed, rejected or failed, most recently asked for first.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Change</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Decided by</th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((row) => (
                  <tr key={row.id}>
                    <th scope="row" className="fh-regular" data-wrap="">
                      {row.summary}
                    </th>
                    <td data-label="Outcome">
                      <Pill
                        {...BADGE_PILL[
                          STATUS_TONE[row.status as keyof typeof STATUS_TONE] ?? "neutral"
                        ]}
                      >
                        {row.status}
                      </Pill>
                    </td>
                    <td data-label="Decided by">{row.decidedBy ?? "-"}</td>
                    <td data-label="When">
                      <Time at={row.decidedAt} empty="-" tip />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

function ConfirmButton({ busy }: { busy: boolean }) {
  return (
    <button type="submit" className="cap-btn" data-variant="danger" disabled={busy}>
      Confirm
    </button>
  );
}
