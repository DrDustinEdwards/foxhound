import { Alert, Banner } from "capsomer/react/banner";
import { Panel } from "capsomer/react/panel";
import { RecordFacts } from "capsomer/react/record-facts";
import { Pill } from "capsomer/react/status";
import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/field.css";
import "capsomer/record-facts.css";
import "capsomer/status.css";
import { data, Form, useNavigation } from "react-router";

import { Time } from "capsomer/react/time";
import { ConfirmPhraseField } from "~/components/admin-confirm-phrase";
import { BADGE_PILL } from "~/lib/recovery/labels";
import { getDb } from "~/db";
import { logAdminAction } from "~/lib/admin/audit.server";
import {
  BRAKE_CONFIRM_PHRASES,
  engageResultMessage,
  isBrakeIntent,
  isConfirmPhraseValid,
  releaseResultMessage,
  type BrakeIntent,
} from "~/lib/admin/brake";
import {
  countStaleMarkers,
  engageBrake,
  getBrakeStatus,
  releaseBrake,
} from "~/lib/admin/brake.server";
import { setCronEnabled } from "~/lib/admin/crons.server";
import { adminContext } from "~/lib/admin/context";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { RECOVERY_TICK_CRON_NAME } from "~/lib/constants";
import type { AdminHandle } from "~/lib/admin/page";

import type { Route } from "./+types/brake";
import { NOINDEX } from "~/lib/seo/meta";
import { readForm } from "@dustinedwards/site-runtime/body";
import { BODY_MAX_BYTES } from "~/lib/http/body";

export const handle: AdminHandle = { page: "Emergency brake" };

export function meta() {
  return [{ title: "Emergency brake - Foxhound admin" }, NOINDEX];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const [status, staleMarkers] = await Promise.all([getBrakeStatus(db), countStaleMarkers(db)]);
  return { status, staleMarkers };
}

interface ActionResult {
  ok: boolean;
  error?: string;
  message?: string;
}

/**
 * Two independent stops, both type-to-confirm, both audited.
 *
 * The brake pauses ACCOUNTS (the tick still runs, it just finds nothing eligible
 * for those merchants). Disabling recovery-tick stops the LOOP itself for
 * everyone, including accounts the brake deliberately skipped. They are offered
 * side by side because during an incident the right answer is sometimes one,
 * sometimes the other, and an operator should not have to know which page the
 * other one lives on.
 */
export async function action({ context, request }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(adminContext);
  const db = getDb(env);

  const form = await readForm(request, BODY_MAX_BYTES);
  const intent = String(form.get("intent") ?? "");
  const confirm = String(form.get("confirm") ?? "");

  if (!isBrakeIntent(intent)) {
    return data<ActionResult>({ ok: false, error: `Unknown action: ${intent}` }, { status: 400 });
  }

  // Validated BEFORE any write and before any audit row, so a mistyped
  // confirmation never records an attempt that did not happen.
  if (!isConfirmPhraseValid(intent, confirm)) {
    return data<ActionResult>(
      {
        ok: false,
        error: `Type ${BRAKE_CONFIRM_PHRASES[intent]} exactly to confirm. Nothing was changed.`,
      },
      { status: 400 },
    );
  }

  if (intent === "engage") {
    const result = await engageBrake(db, { actorEmail: auth.email });
    if (result.error) {
      // Partial, not failed. The committed accounts are paused AND marked, so a
      // release will clean them up; say so rather than leaving the operator to
      // guess whether re-engaging is safe (it is: engage skips paused rows).
      return data<ActionResult>({
        ok: false,
        error:
          `Brake PARTIALLY engaged: ${result.affectedCount} of ${result.intendedCount} account(s) paused before a ` +
          `write failed (${result.error}). The paused accounts carry the brake marker, so Release will resume exactly ` +
          `them. Re-engaging is safe and will pick up the remainder.`,
      });
    }
    return data<ActionResult>({ ok: true, message: engageResultMessage(result) });
  }

  if (intent === "release") {
    const result = await releaseBrake(db, { actorEmail: auth.email });
    if (result.error) {
      return data<ActionResult>({
        ok: false,
        error:
          `Brake PARTIALLY released: ${result.affectedCount} of ${result.intendedCount} account(s) resumed before a ` +
          `write failed (${result.error}). The rest are still paused and still marked; run Release again.`,
      });
    }
    return data<ActionResult>({ ok: true, message: releaseResultMessage(result) });
  }

  const nextEnabled = intent === "tick-enable";
  // INTENT before STATE, the ordering applyBrakeTransition deliberately adopted
  // and this branch of the same panel did not (review LOW-4). If the audit
  // insert fails, nothing has changed and there is nothing to have recorded. The
  // other way round, a failed insert left the tick's enabled state flipped with
  // no record that anyone flipped it, which is the exact failure the umbrella
  // row was moved first to prevent.
  await logAdminAction(db, {
    actorEmail: auth.email,
    action: nextEnabled ? "cron.enable" : "cron.disable",
    metadata: { cronName: RECOVERY_TICK_CRON_NAME, via: "brake-panel" },
  });
  await setCronEnabled(db, RECOVERY_TICK_CRON_NAME, nextEnabled);
  return data<ActionResult>({
    ok: true,
    message: nextEnabled
      ? "Recovery tick enabled."
      : "Recovery tick disabled. The loop is stopped for every account.",
  });
}

function ConfirmForm({
  intent,
  label,
  description,
  busy,
  danger,
}: {
  intent: BrakeIntent;
  label: string;
  description: string;
  busy: boolean;
  danger?: boolean;
}) {
  return (
    <Form method="post">
      <input type="hidden" name="intent" value={intent} />
      <ConfirmPhraseField phrase={BRAKE_CONFIRM_PHRASES[intent]} help={description}>
        <button
          type="submit"
          className="cap-btn"
          data-variant={danger ? "danger" : undefined}
          disabled={busy}
        >
          {label}
        </button>
      </ConfirmPhraseField>
    </Form>
  );
}

function EventLine({
  label,
  event,
}: {
  label: string;
  event: { actorEmail: string; at: Date; count: number | null } | null;
}) {
  if (!event) return <p className="text-label text-text-tertiary">{label}: never</p>;
  return (
    <p className="text-label text-text-tertiary">
      {label}: <Time at={event.at} empty="never" tip /> by{" "}
      <span className="font-mono text-text-secondary">{event.actorEmail}</span>
      {/* "intended", because the umbrella row is written before the account
          writes so that a partial failure still leaves a record of the attempt.
          The live truth is the count in the facts above. */}
      {event.count !== null ? ` (${event.count} account(s) intended)` : null}
    </p>
  );
}

export default function AdminBrake({ loaderData, actionData }: Route.ComponentProps) {
  const { status, staleMarkers } = loaderData;
  const busy = useNavigation().state !== "idle";
  const engaged = status.brakePausedCount > 0;

  return (
    <div className="grid grid-cols-1 gap-6">
      {actionData?.error ? <Alert>{actionData.error}</Alert> : null}
      {actionData?.ok && actionData.message ? (
        <Banner tone="ok">{actionData.message}</Banner>
      ) : null}

      <Panel
        title="Current state"
        actions={
          <>
            <Pill {...BADGE_PILL[engaged ? "failure" : "neutral"]}>
              {engaged ? "Brake ENGAGED" : "Brake not engaged"}
            </Pill>
            <Pill {...BADGE_PILL[status.tickEnabled ? "success" : "failure"]}>
              {status.tickEnabled ? "Tick enabled" : "Tick DISABLED"}
            </Pill>
          </>
        }
      >
        <div className="cap-stack">
          {/* "Outside the brake", not "individually": the demo account is paused by
              the seeder, and a pre-pause_reason row carries no reason either. What
              the number means is "paused, and release will not touch it". */}
          <RecordFacts
            facts={[
              { label: "Paused by brake", value: status.brakePausedCount, mono: true },
              {
                label: "Paused outside the brake",
                value: status.individuallyPausedCount,
                mono: true,
              },
              { label: "Eligible to pause now", value: status.eligibleCount, mono: true },
            ]}
          />
          <div>
            <EventLine label="Last engage" event={status.lastEngage} />
            <EventLine label="Last release" event={status.lastRelease} />
          </div>
          {staleMarkers.markedButNotPaused > 0 ? (
            <Banner tone="warn">
              {staleMarkers.markedButNotPaused} account(s) carry a pause reason but are not paused.
              Something wrote processing_paused outside setProcessingPaused.
            </Banner>
          ) : null}
          {staleMarkers.pausedWithUnknownReason > 0 ? (
            <Banner tone="warn">
              {staleMarkers.pausedWithUnknownReason} paused account(s) carry an unrecognized pause
              reason. Release matches only the brake marker, so it will never resume them.
            </Banner>
          ) : null}
        </div>
      </Panel>

      <Panel
        title="The brake: pause every merchant"
        description="Pauses processing for every account except demo accounts, accounts already paused, and canceled accounts. Merchants paused outside the brake keep their pause and are never resumed by a release."
      >
        <div className="cap-stack">
          <p className="text-label text-text-tertiary">
            What this does not stop: a canceled account still pays fees it already owed, because
            those were earned before it canceled and the brake has no lever over them. Everything
            else, including billing-exempt accounts, stops.
          </p>
          <ConfirmForm
            intent="engage"
            label="Engage brake"
            danger
            busy={busy}
            description={`Will pause ${status.eligibleCount} account(s).`}
          />
          <ConfirmForm
            intent="release"
            label="Release brake"
            busy={busy}
            description={`Will resume ${status.brakePausedCount} account(s) paused by the brake. ${status.individuallyPausedCount} account(s) paused outside the brake will stay paused.`}
          />
        </div>
      </Panel>

      <Panel
        title="The harder stop: recovery tick"
        description="The brake pauses accounts. This stops the loop itself, for everyone, including accounts the brake skips. Use it when the problem is the engine rather than a merchant."
      >
        {status.tickEnabled ? (
          <ConfirmForm
            intent="tick-disable"
            label="Disable recovery tick"
            danger
            busy={busy}
            description="Stops all retries and dunning sends until re-enabled."
          />
        ) : (
          <ConfirmForm
            intent="tick-enable"
            label="Enable recovery tick"
            busy={busy}
            description="Resumes the five-minute loop. Due steps that piled up while disabled will run on the next tick."
          />
        )}
      </Panel>
    </div>
  );
}
