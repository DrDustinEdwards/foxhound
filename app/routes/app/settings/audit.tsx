import { useState } from "react";
import { data, useNavigation } from "react-router";
import { eq } from "drizzle-orm";

import { Alert, Submit } from "~/components/auth-ui";
import { DemoGuardedForm } from "~/components/demo-guarded-form";
import { accounts, getDb } from "~/db";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import {
  LOOKBACK_OPTIONS,
  normalizeLookback,
  readAuditSettings,
} from "~/lib/settings/audit-settings";

import type { Route } from "./+types/audit";

// S30, /settings/audit, BUILT under 315. It was DEFECT-OPEN with foxhound source
// "none", and Session 25 halted the monthly digest cron precisely because this
// page did not exist: nothing could set audit_auto_run, so a cron gated on it
// would have iterated zero accounts forever. This is the surface that makes the
// column settable, which is why it lands before the cron rather than after.
//
// LEGACY IS THE SPEC, read whole at blob shas per 260: page.tsx 18e6a384,
// AuditForm.tsx 5bf81c10, AuditSection.tsx 58c5abce, Toggle.tsx 0ebdd395, and
// SettingsSidebar.tsx e1a283ec for the navigation placement.
//
// FOUR DIVERGENCES, each classed rather than glossed:
//
// 1. THE WRITE PATH. Legacy's form POSTs to a shared `/settings/update` handler,
//    which is ledger row S38 and is itself unbuilt here. This uses the route's
//    own RR8 action instead. Class (a) internals required by the stack,
//    invisible to the merchant, and it avoids building S38 as a side effect.
// 2. THE PAGE-VERSUS-CARD SPLIT, reported rather than resolved. Legacy gives
//    every setting its own sidebar page. Foxhound has already collapsed four of
//    the analogous ones (brand voice, email, notifications, intelligence) into
//    inline cards on /settings, which is the S25 divergence ruling 57 defers.
//    315 directed a ROUTE, and a route is also forward-compatible: when S25 ships
//    legacy's sidebar, the inline cards have to become pages anyway, and this one
//    already is.
// 3. NO SIDEBAR TO LIST IT IN. Legacy lists Audit in a "Products" group with a
//    ScanSearch icon. Foxhound has no settings sidebar at all, so the equivalent
//    listing is PLATFORM_LINKS, which is already the only navigation path to
//    /settings/team for exactly the same reason.
// 4. NO Toggle COMPONENT EXISTS HERE. Legacy's components/Toggle.tsx is ported
//    inline below at its own geometry rather than a new shared component being
//    minted for one consumer.
//
// 5. THE "written by AI" CLAUSE IS DROPPED from the digest description, ruled by
//    Dustin in 316's session. Class (c), a truthfulness fix: legacy's digest
//    leads with an AI summary this codebase cannot produce, so porting the
//    clause verbatim promised something no send could carry. The rest of the
//    sentence is legacy's, unchanged. See app/lib/audit/digest.server.ts.
//
// NULL IS OFF and legacy agrees: its own page reads `?? false` and `?? 90`, so
// the defaulting lives in the READ and no column DEFAULT is added. See
// app/lib/settings/audit-settings.ts.

export function meta() {
  return [{ title: "Audit settings - Foxhound" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const { membership } = context.get(authContext);
  const db = getDb(env);

  const row = (
    await db
      .select({
        auditLookbackDays: accounts.auditLookbackDays,
        auditAutoRun: accounts.auditAutoRun,
      })
      .from(accounts)
      .where(eq(accounts.id, membership.accountId))
      .limit(1)
  )[0];

  return readAuditSettings(row ?? { auditLookbackDays: null, auditAutoRun: null });
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const { membership } = context.get(authContext);
  const db = getDb(env);
  const form = await request.formData();

  // Clamped SERVER-SIDE. Legacy clamps on render and posts the clamped value,
  // which is a client-side guarantee only; an action takes whatever is posted.
  const lookbackDays = normalizeLookback(form.get("audit_lookback_days"));
  const autoRun = form.get("audit_auto_run") === "true";

  await db
    .update(accounts)
    .set({ auditLookbackDays: lookbackDays, auditAutoRun: autoRun })
    .where(eq(accounts.id, membership.accountId));

  return data({ ok: true, lookbackDays, autoRun });
}

/** Legacy's components/Toggle.tsx at its own geometry (blob 0ebdd395): a
 *  role="switch" button, 24 by 40 track, 20px thumb translated 16px, amber when
 *  on and border when off. Inline rather than a shared component, because this is
 *  its only consumer in the tree today. */
function Toggle({
  enabled,
  onChange,
  label,
}: {
  enabled: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      onClick={() => onChange(!enabled)}
      className={`no-spring relative inline-flex h-6 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${
        enabled ? "bg-amber" : "bg-border"
      }`}
    >
      <span
        className="pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transition-transform duration-200"
        style={{ transform: enabled ? "translateX(16px)" : "translateX(0)" }}
        aria-hidden="true"
      />
    </button>
  );
}

export default function AuditSettings({ loaderData, actionData }: Route.ComponentProps) {
  const [lookbackDays, setLookbackDays] = useState<number>(loaderData.lookbackDays);
  const [autoRun, setAutoRun] = useState<boolean>(loaderData.autoRun);
  const busy = useNavigation().state !== "idle";

  return (
    <div className="mx-auto max-w-[1000px] px-8 py-10">
      <h1 className="text-title font-medium text-text">Audit</h1>
      <p className="mt-1 text-label text-text-tertiary">
        Lookback period and monthly digest options.
      </p>

      <DemoGuardedForm method="post" className="mt-6">
        {/* Legacy carries both values as hidden inputs beside the controls
            (AuditSection.tsx), so the form posts the current selection rather
            than relying on the controls being form fields themselves. */}
        <input type="hidden" name="audit_lookback_days" value={lookbackDays} />
        <input type="hidden" name="audit_auto_run" value={autoRun ? "true" : "false"} />

        <div className="mb-4 rounded-[12px] border border-border bg-surface p-6">
          <div className="py-4">
            <div className="mb-0.5 text-label text-text">Lookback period</div>
            <div className="mb-3 text-micro text-text-subtle">
              How far back we look when calculating your audit.
            </div>
            <div className="flex flex-wrap gap-2">
              {LOOKBACK_OPTIONS.map((n) => {
                const active = n === lookbackDays;
                return (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setLookbackDays(n)}
                    aria-pressed={active}
                    className={`rounded-md border px-3 py-1.5 text-label transition-colors duration-150 ${
                      active
                        ? "border-amber bg-amber font-semibold text-on-amber"
                        : "border-border bg-surface text-text-tertiary hover:bg-surface2 hover:text-text"
                    }`}
                  >
                    {n} days
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center justify-between border-t border-border py-4">
            <div className="pr-4">
              <div className="mb-0.5 text-label text-text">Monthly audit digest</div>
              {/* "written by AI" REMOVED under 316's session, ratified by Dustin.
                  Legacy's digest leads with runAudit()'s aiSummary; Foxhound's
                  audit entry point produces no summary and ANTHROPIC_API_KEY has
                  no credit balance (core.md blocker 2), so the clause promised
                  something the send cannot carry. Divergence 5, and the only
                  edit to legacy's verbatim copy. */}
              <div className="text-micro text-text-subtle">
                On the 1st of each month, we run a fresh audit and email you a comparison
                versus the prior month. No extra charge.
              </div>
            </div>
            <Toggle enabled={autoRun} onChange={setAutoRun} label="Monthly audit digest" />
          </div>
        </div>

        {actionData?.ok ? <Alert tone="success">Saved.</Alert> : null}
        <div className="mt-4">
          <Submit disabled={busy}>{busy ? "Saving..." : "Save"}</Submit>
        </div>
      </DemoGuardedForm>
    </div>
  );
}
