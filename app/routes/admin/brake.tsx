import { data, Form, useNavigation } from "react-router";

import { AdminNav } from "~/components/admin-nav";
import { Badge } from "~/components/badge";
import { getDb } from "~/db";
import { logAdminAction } from "~/lib/admin/audit.server";
import {
  BRAKE_CONFIRM_PHRASES,
  isBrakeIntent,
  isConfirmPhraseValid,
  type BrakeIntent,
} from "~/lib/admin/brake";
import {
  countStaleMarkers,
  engageBrake,
  getBrakeStatus,
  releaseBrake,
} from "~/lib/admin/brake.server";
import { setCronEnabled } from "~/lib/admin/crons.server";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { RECOVERY_TICK_CRON_NAME } from "~/lib/constants";

import type { Route } from "./+types/brake";

export function meta() {
  return [{ title: "Emergency brake - Foxhound Admin" }];
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
  const auth = context.get(authContext);
  const db = getDb(env);

  const form = await request.formData();
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
    return data<ActionResult>({
      ok: true,
      message:
        result.affectedCount === 0
          ? "Brake engaged. No accounts were eligible to pause (every account is demo, billing-exempt, or already paused)."
          : `Brake engaged. Paused ${result.affectedCount} account(s).`,
    });
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
    return data<ActionResult>({
      ok: true,
      message:
        result.affectedCount === 0
          ? "Brake released. No brake-paused accounts to resume."
          : `Brake released. Resumed ${result.affectedCount} account(s). Accounts paused outside the brake were left paused.`,
    });
  }

  const nextEnabled = intent === "tick-enable";
  await setCronEnabled(db, RECOVERY_TICK_CRON_NAME, nextEnabled);
  await logAdminAction(db, {
    actorEmail: auth.email,
    action: nextEnabled ? "cron.enable" : "cron.disable",
    metadata: { cronName: RECOVERY_TICK_CRON_NAME, via: "brake-panel" },
  });
  return data<ActionResult>({
    ok: true,
    message: nextEnabled ? "Recovery tick enabled." : "Recovery tick disabled. The loop is stopped for every account.",
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
  const phrase = BRAKE_CONFIRM_PHRASES[intent];
  const inputId = `confirm-${intent}`;
  return (
    <Form method="post" className="flex flex-col gap-2">
      <input type="hidden" name="intent" value={intent} />
      <p className="text-label text-text-tertiary">{description}</p>
      <label htmlFor={inputId} className="text-label text-text-secondary">
        Type <span className="font-mono text-text">{phrase}</span> to confirm
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={inputId}
          name="confirm"
          type="text"
          autoComplete="off"
          required
          placeholder={phrase}
          className="rounded-md border border-border bg-bg px-3 py-1.5 font-mono text-label text-text placeholder:text-text-subtle"
        />
        <button
          type="submit"
          disabled={busy}
          className={
            danger
              ? "rounded-md border border-red px-3 py-1.5 text-label text-error-text hover:bg-red-bg disabled:opacity-60"
              : "rounded-md border border-border px-3 py-1.5 text-label text-text hover:border-amber disabled:opacity-60"
          }
        >
          {label}
        </button>
      </div>
    </Form>
  );
}

function EventLine({ label, event }: { label: string; event: { actorEmail: string; at: Date; count: number | null } | null }) {
  if (!event) return <p className="text-label text-text-tertiary">{label}: never</p>;
  return (
    <p className="text-label text-text-tertiary">
      {label}: {event.at.toLocaleString()} by <span className="font-mono text-text-secondary">{event.actorEmail}</span>
      {/* "intended", because the umbrella row is written before the account
          writes so that a partial failure still leaves a record of the attempt.
          The live truth is the count in the state grid above. */}
      {event.count !== null ? ` (${event.count} account(s) intended)` : null}
    </p>
  );
}

export default function AdminBrake({ loaderData, actionData }: Route.ComponentProps) {
  const { status, staleMarkers } = loaderData;
  const busy = useNavigation().state !== "idle";
  const engaged = status.brakePausedCount > 0;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-title font-medium text-text">Emergency brake</h1>
      <AdminNav />

      {actionData?.error ? (
        <p role="alert" className="mb-4 rounded-md border border-red bg-red-bg px-3 py-2 text-label text-error-text">
          {actionData.error}
        </p>
      ) : null}
      {actionData?.ok && actionData.message ? (
        <p role="status" className="mb-4 rounded-md border border-green bg-green-bg px-3 py-2 text-label text-success-text">
          {actionData.message}
        </p>
      ) : null}

      <section className="mb-6 rounded-lg border border-border bg-surface p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-label font-semibold text-text">Current state</h2>
          <div className="flex items-center gap-2">
            <Badge tone={engaged ? "failure" : "neutral"}>{engaged ? "Brake ENGAGED" : "Brake not engaged"}</Badge>
            <Badge tone={status.tickEnabled ? "success" : "failure"}>
              {status.tickEnabled ? "Tick enabled" : "Tick DISABLED"}
            </Badge>
          </div>
        </div>
        <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <div>
            <dt className="text-micro text-text-subtle">Paused by brake</dt>
            <dd className="font-mono text-label text-text">{status.brakePausedCount}</dd>
          </div>
          <div>
            {/* Not "individually": the demo account is paused by the seeder, and
                a pre-pause_reason row carries no reason either. What the number
                actually means is "paused, and release will not touch it". */}
            <dt className="text-micro text-text-subtle">Paused outside the brake</dt>
            <dd className="font-mono text-label text-text">{status.individuallyPausedCount}</dd>
          </div>
          <div>
            <dt className="text-micro text-text-subtle">Eligible to pause now</dt>
            <dd className="font-mono text-label text-text">{status.eligibleCount}</dd>
          </div>
        </dl>
        <div className="mt-3 border-t border-border-sub pt-3">
          <EventLine label="Last engage" event={status.lastEngage} />
          <EventLine label="Last release" event={status.lastRelease} />
        </div>
        {staleMarkers.markedButNotPaused > 0 ? (
          <p role="status" className="mt-3 rounded-md border border-orange bg-orange-bg px-3 py-2 text-label text-warning-text">
            {staleMarkers.markedButNotPaused} account(s) carry a pause reason but are not paused. Something wrote
            processing_paused outside setProcessingPaused.
          </p>
        ) : null}
        {staleMarkers.pausedWithUnknownReason > 0 ? (
          <p role="status" className="mt-3 rounded-md border border-orange bg-orange-bg px-3 py-2 text-label text-warning-text">
            {staleMarkers.pausedWithUnknownReason} paused account(s) carry an unrecognised pause reason. Release
            matches only the brake marker, so it will never resume them.
          </p>
        ) : null}
      </section>

      <section className="mb-6 rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-1 text-label font-semibold text-text">The brake: pause every merchant</h2>
        <p className="mb-3 text-label text-text-tertiary">
          Pauses processing for every account that is not a demo account, not billing-exempt, and not already paused.
          Merchants paused individually keep their pause and are never resumed by a release.
        </p>
        <div className="flex flex-col gap-4">
          <ConfirmForm
            intent="engage"
            label="Engage brake"
            danger
            busy={busy}
            description={`Will pause ${status.eligibleCount} account(s).`}
            />
          <div className="border-t border-border-sub pt-4">
            <ConfirmForm
              intent="release"
              label="Release brake"
              busy={busy}
              description={`Will resume ${status.brakePausedCount} account(s) paused by the brake. ${status.individuallyPausedCount} individually paused account(s) will stay paused.`}
            />
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-1 text-label font-semibold text-text">The harder stop: recovery tick</h2>
        <p className="mb-3 text-label text-text-tertiary">
          The brake pauses accounts. This stops the loop itself, for everyone, including accounts the brake skips. Use
          it when the problem is the engine rather than a merchant.
        </p>
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
      </section>
    </div>
  );
}
