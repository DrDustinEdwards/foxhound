import { useId } from "react";
import { data, useNavigation } from "react-router";
import { SaveBar } from "capsomer/react/save-bar";
import { Pill } from "capsomer/react/status";

import { DemoForm } from "~/lib/demo/use-demo-guard";
import { SettingsLayout, SwitchRow } from "capsomer/react/settings-row";
import { routerRenderLink } from "capsomer/react/link";
import { getDb } from "~/db";
import { MEMBER_ROLE } from "~/lib/auth";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { readDisputeSettings } from "~/lib/disputes/queries.server";
import { applyDisputeSettings, applyDisputesEnabled } from "~/lib/settings/apply.server";
import { DISPUTE_PRODUCT_DESCRIPTION_MAX_LENGTH } from "~/lib/settings/dispute-description";

import type { Route } from "./+types/disputes";
import { noindexMeta } from "~/lib/seo/meta";
import { readForm } from "@dustinedwards/site-runtime/body";
import { BODY_MAX_BYTES } from "~/lib/http/body";

// /settings/disputes: one panel card of rows with Switch, a cap-input textarea, Button and Status. ONLY SETTINGS WITH A READER: - Auto-submit disputes: the disputes cron submits an unsubmitted dispute 24 hours before its deadline while it is on (app/lib/cron/dispute-auto-submit.ts). Off by default. Turning it on is the merchant's standing approval: who turned it on and when is stored with it (applyDisputeSettings), and each automatic submission's approval row names them, so the approval gate holds. - Product description: dispute intake reads it into every response's product_description evidence (readDisputeProductDescription). - Ships physical goods: the dispute page shows tracking number, carrier and ship date inputs when it is on (disputes/detail.tsx).
// THE DISPUTES ON/OFF SWITCH lives on accounts.disputes_enabled (default on). It saves at once, apart from the Save button, and leaves the description and ships-physical as stored. Its reader is dispute intake: while it is off, the charge.dispute.created webhook and the manual import create no dispute (readDisputesEnabled). The "active" pill shows only while it is on, and while it is off an "Enable Disputes above to configure ..." line takes the place of the other settings.

export const meta = noindexMeta("Dispute settings - Foxhound");

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const settings = await readDisputeSettings(getDb(env), auth.membership.accountId);
  return { ...settings, isOwner: auth.membership.role === MEMBER_ROLE.OWNER };
}

type ActionResult = { ok: true; toggled?: true } | { ok: false; error?: string };

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const form = await readForm(request, BODY_MAX_BYTES);
  if (form.get("_action") === "toggle_disputes") {
    const enabled = form.get("enabled") === "true";
    try {
      await applyDisputesEnabled(getDb(env), auth.membership.accountId, {
        enabled,
      });
    } catch (err) {
      console.error("disputes switch write failed:", err);
      return data<ActionResult>(
        {
          ok: false,
          error: `Could not ${enabled ? "enable" : "disable"} Disputes.`,
        },
        { status: 500 },
      );
    }
    // No "Saved" for the switch: it shows only its new state.
    return data<ActionResult>({ ok: true, toggled: true });
  }
  const autoSubmit = form.get("dispute_auto_submit") === "on";
  // Auto-submit sends responses to Stripe without anyone pressing Approve, so only the account owner turns it on or off. A member may still save the other fields, with auto-submit posted as it stands.
  if (auth.membership.role !== MEMBER_ROLE.OWNER) {
    const current = await readDisputeSettings(getDb(env), auth.membership.accountId);
    if (current.autoSubmit !== autoSubmit) {
      return data<ActionResult>(
        { ok: false, error: "Only the account owner can do this." },
        { status: 403 },
      );
    }
  }
  try {
    const result = await applyDisputeSettings(
      getDb(env),
      auth.membership.accountId,
      {
        productDescription: form.get("dispute_product_description"),
        // A checkbox posts its name only when checked, so an absent key is OFF.
        shipsPhysical: form.get("dispute_ships_physical") === "on",
        autoSubmit,
      },
      // The signed-in user: turning auto-submit on is their standing approval.
      { userId: auth.userId, email: auth.email, now: new Date() },
    );
    if (!result.ok) return data<ActionResult>({ ok: false, error: result.error }, { status: 400 });
  } catch (err) {
    console.error("dispute settings write failed:", err);
    return data<ActionResult>({ ok: false }, { status: 500 });
  }
  return data<ActionResult>({ ok: true });
}

export default function DisputeSettings({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const toggling =
    navigation.state !== "idle" && navigation.formData?.get("_action") === "toggle_disputes";
  const saving = navigation.state === "submitting" && !toggling;
  const result = actionData as ActionResult | undefined;
  const { enabled } = loaderData;
  const id = useId();
  const descriptionHelpId = `${id}-description-help`;

  return (
    <SettingsLayout renderLink={routerRenderLink} title="Disputes">
      {/* The switch's own form, as Recova's DisputesToggle posted on its own:
          it carries the new value, and the switch below sends it at once
          (SwitchRow submitOnChange; without script its Save button does).
          The switch follows the stored value, so a refused change (the demo,
          a failed write) springs back. */}
      <DemoForm method="post" id={`${id}-toggle`}>
        <input type="hidden" name="_action" value="toggle_disputes" />
        <input type="hidden" name="enabled" value={enabled ? "false" : "true"} />
      </DemoForm>

      <DemoForm method="post">
        <section className="cap-panel">
          <div className="cap-panel-body">
            {/* Recova's top row: the product's name, its active pill while on,
                its line and the switch, which sends its own form at once. */}
            <SwitchRow
              form={`${id}-toggle`}
              submitOnChange
              label={
                <span className="fh-toggle-label fh-inline-row">
                  Disputes
                  {enabled ? <Pill tone="ok">Active</Pill> : null}
                </span>
              }
              checked={enabled}
              busy={toggling}
            />

            {enabled ? (
              <>
                {/* A member sees the switch but cannot move it: auto-submit sends
                    responses to Stripe on the account's behalf, so it is the owner's.
                    The hidden field posts the stored value, so saving the other
                    fields leaves it as it is. */}
                {loaderData.isOwner ? null : loaderData.autoSubmit ? (
                  <input type="hidden" name="dispute_auto_submit" value="on" />
                ) : null}
                <SwitchRow
                  name={loaderData.isOwner ? "dispute_auto_submit" : undefined}
                  label="Auto-submit disputes 24 hours before the deadline if you have not acted"
                  defaultChecked={loaderData.autoSubmit}
                  disabledReason={
                    loaderData.isOwner ? undefined : "Only the account owner can change this."
                  }
                />

                <div className="fh-dispute-setting">
                  <label
                    htmlFor={`${id}-description`}
                    className="fh-setting-label fh-line fh-small fh-text"
                  >
                    Product description
                  </label>
                  <p id={descriptionHelpId} className="fh-dispute-help fh-tiny fh-faint">
                    Used in all dispute responses.
                  </p>
                  <textarea
                    id={`${id}-description`}
                    name="dispute_product_description"
                    className="cap-input"
                    rows={3}
                    maxLength={DISPUTE_PRODUCT_DESCRIPTION_MAX_LENGTH}
                    defaultValue={loaderData.productDescription}
                    placeholder="e.g. Monthly SaaS subscription for project management software"
                    aria-describedby={descriptionHelpId}
                  />
                </div>

                <SwitchRow
                  name="dispute_ships_physical"
                  label="Ships physical goods"
                  defaultChecked={loaderData.shipsPhysical}
                />
              </>
            ) : null}
          </div>
        </section>

        {/* Recova's SaveBar: right-aligned, the result beside the button. While
            Disputes is off the settings are hidden and a save would post them
            empty, so Save stays, unusable, and says why. */}
        <SaveBar
          pending={saving}
          saved={result?.ok === true && !result.toggled}
          error={
            result?.ok === false ? (result.error ?? "Failed to save. Please try again.") : null
          }
          disabledReason={enabled ? undefined : "Enable Disputes above to save these settings."}
        />
      </DemoForm>
    </SettingsLayout>
  );
}
