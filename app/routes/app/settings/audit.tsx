import { useId, useState } from "react";
import { data, useNavigation } from "react-router";
import { eq } from "drizzle-orm";
import { Button } from "capsomer/react/button";
import { PageHead } from "capsomer/react/page-head";
import { Segmented } from "capsomer/react/segmented";
import { Switch } from "capsomer/react/switch";
import "capsomer/button.css";
import "capsomer/page-head.css";
import "capsomer/panel.css";
import "capsomer/segmented.css";
import "capsomer/switch.css";
// Capsomer's tokens and the amber family, which the components above read, as
// /settings/alerts and /settings/api-keys load them.
import "~/site-header.css";

import { DemoGuardedForm } from "~/components/demo-guarded-form";
import { SettingsBackLink } from "~/components/settings-back-link";
import { accounts, getDb } from "~/db";
import { authContext } from "~/lib/auth/context";
import { applyAuditSettings } from "~/lib/settings/apply.server";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { LOOKBACK_OPTIONS, readAuditSettings } from "~/lib/settings/audit-settings";

import type { Route } from "./+types/audit";
import { NOINDEX } from "~/lib/seo/meta";

// S30, /settings/audit. Legacy, read whole at HEAD: page.tsx (blob 18e6a384),
// AuditForm.tsx (5bf81c10), settings/components/AuditSection.tsx (58c5abce),
// components/Toggle.tsx (0ebdd395) and settings/SaveBar.tsx (f1d6eb23).
//
// J35 (job_9ad6ef3e08f6) rebuilt the page on Capsomer 0.9.0's parts (Q10),
// amber throughout. Recova is the spec for what is on
// it and in what order: the phone-only Settings link, the head, one card with
// the lookback period and then the monthly digest, and the save bar. The
// settings layout gives the page Recova's 800px column and padding, so the
// page adds no width of its own. No Foxhound class sits on a Capsomer element;
// what Recova's look still needs is listed for Capsomer's per-site layer
// (capsomer job_ec5ec0754626) in the J35 pull request.
//
// THE LOOKBACK HAS A READER (RULES.md 3.18): the monthly audit cron reads the
// stored value through readAuditSettings and audits that window
// (app/lib/audit/monthly.server.ts), and so does the signed-in results page.
// test/audit-lookback-reader-j35.test.ts proves the window follows the setting.
//
// THE WRITE PATH. Legacy's form POSTs to a shared `/settings/update` handler
// (row S38). This uses the route's own action instead, which writes through
// applyAuditSettings, the same core the MCP `set_audit_settings` tool uses.
// Class (a), invisible to the merchant.
//
// THE "written by AI" CLAUSE IS DROPPED from the digest description, ruled by
// Dustin in 316's session. Class (c), a truthfulness fix: ANTHROPIC_API_KEY
// still has no credit, so an unfunded key would serve the fallback paragraph
// under a promise of AI, and naming the vendor in merchant copy is forbidden
// regardless. The rest of the sentence is legacy's, unchanged.
//
// NULL IS OFF and legacy agrees: its own page reads `?? false` and `?? 90`, so
// the defaulting lives in the READ and no column DEFAULT is added (RULES.md
// 3.17). See app/lib/settings/audit-settings.ts.

export function meta() {
  return [{ title: "Audit settings - Foxhound" }, NOINDEX];
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

  // THE CORE MOVED TO apply.server.ts IN SESSION 79, so this action and the
  // MCP `set_audit_settings` tool validate and write through one implementation.
  // Clamping is still SERVER-SIDE inside it: legacy clamps on render and posts
  // the clamped value, which is a client-side guarantee only.
  //
  // A FAILED WRITE THROWS rather than returning ok: false (the D1 batch either
  // lands or throws), so it is caught here. The whole error is logged, and the
  // page shows Recova's failure line, which Recova shows for exactly this case
  // (its `error=update_failed` after the shared update handler's write fails).
  try {
    const result = await applyAuditSettings(db, membership.accountId, {
      lookbackDays: form.get("audit_lookback_days"),
      autoRun: form.get("audit_auto_run"),
    });
    if (!result.ok) return data({ ok: false as const }, { status: 400 });
    return data({ ok: true as const, ...result.state });
  } catch (err) {
    console.error("audit settings write failed:", err);
    return data({ ok: false as const }, { status: 500 });
  }
}

export default function AuditSettings({ loaderData, actionData }: Route.ComponentProps) {
  const [lookbackDays, setLookbackDays] = useState<string>(String(loaderData.lookbackDays));
  const [autoRun, setAutoRun] = useState<boolean>(loaderData.autoRun);
  const busy = useNavigation().state !== "idle";
  const lookbackHelp = useId();
  const digestHelp = useId();
  const saved = actionData?.ok === true;
  const failed = actionData?.ok === false;

  return (
    <>
      <SettingsBackLink />
      {/* Recova's PageHeader sits mb-8 above the first card. */}
      <div className="mb-8">
        <PageHead title="Audit" lead="Lookback period and monthly digest options." />
      </div>

      <DemoGuardedForm method="post">
        {/* Recova's AuditSection card has no heading, so this is Capsomer's
            panel markup with its body only, as /settings/alerts does. */}
        <div className="mb-4">
          <div className="cap-panel">
            <div className="cap-panel-body">
              <div className="min-w-0">
                {/* Recova shows the label, then the helper, then the four
                    choices. The visible label is the same words as the
                    fieldset's legend, which names the group for screen
                    readers, so it is hidden from them here to be read once.
                    The legend's words are visually hidden inside it, not with
                    Capsomer's hideLegend: that sets .cap-sr-only, which lives
                    in capsomer/base.css, and the merchant app does not load
                    base.css (app/site-header.css). The legend keeps Capsomer's
                    margin below it, so the helper's own margin is the rest of
                    Recova's 12px. */}
                <div className="mb-0.5 text-label text-text" aria-hidden="true">
                  Lookback period
                </div>
                <p id={lookbackHelp} className="m-0 mb-1 text-micro text-text-subtle">
                  How far back we look when calculating your audit.
                </p>
                <Segmented
                  legend={<span className="sr-only">Lookback period</span>}
                  name="audit_lookback_days"
                  describedBy={lookbackHelp}
                  value={lookbackDays}
                  onChange={setLookbackDays}
                  options={LOOKBACK_OPTIONS.map((n) => ({ value: String(n), label: `${n} days` }))}
                />
              </div>

              <div className="flex min-w-0 items-center justify-between gap-4 border-t border-border pt-4">
                <div className="pr-4">
                  <div className="mb-0.5 text-label text-text" aria-hidden="true">
                    Monthly audit digest
                  </div>
                  <p id={digestHelp} className="m-0 text-micro text-text-subtle">
                    On the 1st of each month, we run a fresh audit and email you a comparison
                    versus the prior month. No extra charge.
                  </p>
                </div>
                {/* Unchecked posts nothing, which the action reads as off, so
                    the form works with no script as well. */}
                <Switch
                  label={<span className="sr-only">Monthly audit digest</span>}
                  name="audit_auto_run"
                  value="true"
                  checked={autoRun}
                  onCheckedChange={setAutoRun}
                  aria-describedby={digestHelp}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Recova's SaveBar (blob f1d6eb23): a right-aligned row, the result
            in words, then Save changes. */}
        <div className="mt-6 flex items-center justify-end gap-3 text-label">
          {saved ? (
            <span role="status" className="text-green">
              Saved
            </span>
          ) : null}
          {failed ? (
            <span role="alert" className="text-red">
              Failed to save. Please try again.
            </span>
          ) : null}
          <Button type="submit" variant="primary" pending={busy}>
            Save changes
          </Button>
        </div>
      </DemoGuardedForm>
    </>
  );
}
