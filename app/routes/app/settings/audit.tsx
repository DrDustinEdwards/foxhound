import { useId, useState } from "react";
import { data, useNavigation } from "react-router";
import { SaveBar } from "capsomer/react/save-bar";
import { Segmented } from "capsomer/react/segmented";
import { Switch } from "capsomer/react/switch";
import "capsomer/segmented.css";

import { DemoForm } from "~/lib/demo/use-demo-guard";
import { SettingsLayout } from "capsomer/react/settings-row";
import { routerRenderLink } from "capsomer/react/link";
import { getDb } from "~/db";
import { authContext } from "~/lib/auth/context";
import { applyAuditSettings } from "~/lib/settings/apply.server";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { LOOKBACK_OPTIONS } from "~/lib/settings/audit-settings";
import { readAccountAuditSettings } from "~/lib/settings/audit-settings.server";

import type { Route } from "./+types/audit";
import { NOINDEX } from "~/lib/seo/meta";
import { readForm } from "@dustinedwards/site-runtime/body";
import { BODY_MAX_BYTES } from "~/lib/http/body";

// /settings/audit: the phone-only Settings link, the head, one card with the lookback period and then the monthly digest, and the save bar. The settings layout gives the page its 800px column and padding. No Foxhound class sits on a Capsomer element.
// THE LOOKBACK HAS A READER: the monthly audit cron reads the stored value through readAuditSettings and audits that window (app/lib/audit/monthly.server.ts), and so does the signed-in results page; test/audit-monthly.test.ts proves the window follows the setting.
// The route's own action writes through applyAuditSettings, the same core the MCP `set_audit_settings` tool uses. The digest description does not say "written by AI": an unfunded key would serve the fallback paragraph under a promise of AI, and naming the vendor in merchant copy is forbidden regardless.
// NULL IS OFF: the defaulting lives in the READ and no column DEFAULT is added (app/lib/settings/audit-settings.ts).

export function meta() {
  return [{ title: "Audit settings - Foxhound" }, NOINDEX];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const { membership } = context.get(authContext);
  const db = getDb(env);

  return readAccountAuditSettings(db, membership.accountId);
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const { membership } = context.get(authContext);
  const db = getDb(env);
  const form = await readForm(request, BODY_MAX_BYTES);

  // This action and the MCP `set_audit_settings` tool validate and write through one implementation (apply.server.ts). Clamping is SERVER-SIDE inside it.
  // A FAILED WRITE THROWS rather than returning ok: false (the D1 batch either lands or throws), so it is caught here. The whole error is logged, and the page shows the failure line.
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
  const digestHelp = useId();
  const saved = actionData?.ok === true;
  const failed = actionData?.ok === false;

  return (
    <SettingsLayout renderLink={routerRenderLink} title="Audit">
      <DemoForm method="post">
        {/* Recova's AuditSection card has no heading, so this is Capsomer's
            panel markup with its body only, as /settings/alerts does. */}
        <div className="fh-field-block">
          <div className="cap-panel">
            <div className="cap-panel-body">
              <div className="fh-shrink">
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
                <div className="fh-setting-label fh-small fh-text" aria-hidden="true">
                  Lookback period
                </div>
                <Segmented
                  legend={<span className="cap-sr-only">Lookback period</span>}
                  name="audit_lookback_days"
                  value={lookbackDays}
                  onChange={setLookbackDays}
                  options={LOOKBACK_OPTIONS.map((n) => ({ value: String(n), label: `${n} days` }))}
                />
              </div>

              <div className="fh-audit-switch">
                <div className="fh-audit-switch-text">
                  <div className="fh-setting-label fh-small fh-text" aria-hidden="true">
                    Monthly audit digest
                  </div>
                  <p id={digestHelp} className="fh-tiny fh-faint">
                    Monthly, on the 1st. No extra charge.
                  </p>
                </div>
                {/* Unchecked posts nothing, which the action reads as off, so
                    the form works with no script as well. */}
                <Switch
                  label={<span className="cap-sr-only">Monthly audit digest</span>}
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
        <SaveBar
          pending={busy}
          saved={saved}
          error={failed ? "Failed to save. Please try again." : null}
        />
      </DemoForm>
    </SettingsLayout>
  );
}
