import { useId, useRef } from "react";
import { data, useNavigation } from "react-router";
import { Button } from "capsomer/react/button";
import { PageHead } from "capsomer/react/page-head";
import { Pill, Status } from "capsomer/react/status";
import { Switch } from "capsomer/react/switch";
import "capsomer/button.css";
import "capsomer/field.css";
import "capsomer/page-head.css";
import "capsomer/panel.css";
import "capsomer/status.css";
import "capsomer/switch.css";
// Capsomer's tokens and the amber family, which the components above read, as
// /settings/features loads them.
import "~/site-header.css";

import { DemoGuardedForm } from "~/components/demo-guarded-form";
import { SettingsBackLink } from "~/components/settings-back-link";
import { getDb } from "~/db";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { readDisputeSettings } from "~/lib/disputes/queries.server";
import { applyDisputeSettings, applyDisputesEnabled } from "~/lib/settings/apply.server";
import { DISPUTE_PRODUCT_DESCRIPTION_MAX_LENGTH } from "~/lib/settings/dispute-description";

import type { Route } from "./+types/disputes";

// S32, /settings/disputes (J06, job_4f4c9c2f5383).
//
// LEGACY IS THE SPEC, read whole:
//   settings/disputes/page.tsx            blob 9d927c62  1,550 bytes
//   settings/disputes/DisputesForm.tsx    blob 6a769d95  1,193 bytes
//   settings/components/DisputesSection   blob eb7bba4d  4,979 bytes
//   components/DisputesToggle.tsx         blob 89436149  1,757 bytes
//
// ONLY SETTINGS WITH A READER (RULES.md 3.18; parity/S-CLOSEOUT.md found all
// three columns without one). Each has one now:
// - Auto-submit disputes: the disputes cron submits an unsubmitted dispute 24
//   hours before its deadline while it is on (app/lib/cron/dispute-auto-submit.ts,
//   Recova's process-disputes "Thing 2"). Off by default. Turning it on is the
//   merchant's standing approval: who turned it on and when is stored with it
//   (applyDisputeSettings), and each automatic submission's approval row names
//   them, so the approval gate holds.
// - Product description: dispute intake reads it into every response's
//   product_description evidence (readDisputeProductDescription, Recova's
//   buildEvidenceFields).
// - Ships physical goods: the dispute page shows Recova's tracking number,
//   carrier and ship date inputs when it is on (disputes/detail.tsx).
//
// THE DISPUTES ON/OFF SWITCH (parity gap 7): Recova's DisputesToggle, which
// posted to /api/disputes/{enable,disable} over account_products, is ported
// onto accounts.disputes_enabled (migration 0048, default on, as Recova
// activated Disputes on Stripe connect). Like Recova's toggle it saves at once,
// apart from the Save button, and leaves the description and ships-physical as
// stored. Its reader is dispute intake: while it is off, the
// charge.dispute.created webhook and the manual import create no dispute
// (readDisputesEnabled, Recova's handleDisputeCreated step 1). The "active"
// pill shows only while it is on, and while it is off Recova's "Enable Disputes
// above to configure ..." line takes the place of the other settings.
//
// LOOK FROM CAPSOMER (Q10): PageHead, one panel card with Recova's rows,
// Switch, a cap-input textarea, Button and Status, amber throughout. Recova's
// content, order and arrangement stay, as /settings/features does.

export function meta() {
  return [{ title: "Dispute settings - Foxhound" }];
}

/** The page's line and the Disputes row's line, Recova's. */
export const DISPUTES_SETTINGS_LINE =
  "Automatically triage chargebacks, stage evidence, and submit responses to Stripe.";

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  return readDisputeSettings(getDb(env), auth.membership.accountId);
}

type ActionResult = { ok: true; toggled?: true } | { ok: false; error?: string };

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const form = await request.formData();
  if (form.get("_action") === "toggle_disputes") {
    const enabled = form.get("enabled") === "true";
    try {
      await applyDisputesEnabled(getDb(env), auth.membership.accountId, { enabled });
    } catch (err) {
      console.error("disputes switch write failed:", err);
      return data<ActionResult>(
        { ok: false, error: `Could not ${enabled ? "enable" : "disable"} Disputes.` },
        { status: 500 },
      );
    }
    // No "Saved" for the switch: Recova's toggle showed only its new state.
    return data<ActionResult>({ ok: true, toggled: true });
  }
  try {
    const result = await applyDisputeSettings(
      getDb(env),
      auth.membership.accountId,
      {
        productDescription: form.get("dispute_product_description"),
        // A checkbox posts its name only when checked, so an absent key is OFF.
        shipsPhysical: form.get("dispute_ships_physical") === "on",
        autoSubmit: form.get("dispute_auto_submit") === "on",
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
  const toggling = navigation.state !== "idle" && navigation.formData?.get("_action") === "toggle_disputes";
  const saving = navigation.state === "submitting" && !toggling;
  const result = actionData as ActionResult | undefined;
  const toggleForm = useRef<HTMLFormElement>(null);
  const { enabled } = loaderData;
  const id = useId();
  const disputesLabelId = `${id}-disputes-label`;
  const descriptionHelpId = `${id}-description-help`;
  const autoLabelId = `${id}-auto-label`;
  const autoHelpId = `${id}-auto-help`;
  const shipsLabelId = `${id}-ships-label`;
  const shipsHelpId = `${id}-ships-help`;

  return (
    <>
      <SettingsBackLink />
      <div className="mb-8">
        <PageHead title="Disputes" lead={DISPUTES_SETTINGS_LINE} />
      </div>

      {/* The switch's own form, as Recova's DisputesToggle posted on its own:
          it carries the new value, and the switch below submits it at once.
          The switch follows the stored value, so a refused change (the demo,
          a failed write) springs back. */}
      <DemoGuardedForm method="post" ref={toggleForm} id={`${id}-toggle`}>
        <input type="hidden" name="_action" value="toggle_disputes" />
        <input type="hidden" name="enabled" value={enabled ? "false" : "true"} />
      </DemoGuardedForm>

      <DemoGuardedForm method="post">
        <section className="cap-panel">
          <div className="cap-panel-body">
            {/* Recova's top row: the product's name, its active pill while on,
                its line and the switch. */}
            <div className="flex items-start justify-between gap-4 border-b border-border pb-4">
              <div className="flex-1 pr-4">
                <div className="mb-0.5 flex items-center gap-2">
                  <div id={disputesLabelId} className="text-label text-text">
                    Disputes
                  </div>
                  {enabled ? <Pill tone="ok">Active</Pill> : null}
                </div>
                <p className="m-0 text-micro text-text-subtle">{DISPUTES_SETTINGS_LINE}</p>
              </div>
              <Switch
                id={`${id}-enabled`}
                form={`${id}-toggle`}
                label={null}
                checked={enabled}
                busy={toggling}
                aria-labelledby={disputesLabelId}
                onCheckedChange={() => toggleForm.current?.requestSubmit()}
              />
            </div>

            {enabled ? (
              <>
                <div className="flex items-center justify-between gap-4 py-4">
                  <div className="pr-4">
                    <div id={autoLabelId} className="mb-0.5 text-label text-text">
                      Auto-submit disputes
                    </div>
                    <p id={autoHelpId} className="m-0 text-micro text-text-subtle">
                      Foxhound will automatically submit your dispute response 24 hours before the deadline if you
                      haven&apos;t acted. Off by default.
                    </p>
                  </div>
                  <Switch
                    id={`${id}-auto`}
                    name="dispute_auto_submit"
                    label={null}
                    defaultChecked={loaderData.autoSubmit}
                    aria-labelledby={autoLabelId}
                    aria-describedby={autoHelpId}
                  />
                </div>

                <div className="border-t border-border py-4">
                  <label htmlFor={`${id}-description`} className="mb-0.5 block text-label text-text">
                    Product description
                  </label>
                  <p id={descriptionHelpId} className="m-0 mb-2 text-micro text-text-subtle">
                    Describe what your product or service is. Used in all dispute responses.
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

                <div className="flex items-center justify-between gap-4 border-t border-border py-4">
                  <div className="pr-4">
                    <div id={shipsLabelId} className="mb-0.5 text-label text-text">
                      Ships physical goods
                    </div>
                    <p id={shipsHelpId} className="m-0 text-micro text-text-subtle">
                      Enable if you ship physical products. Adds shipping evidence fields to dispute responses.
                    </p>
                  </div>
                  <Switch
                    id={`${id}-ships`}
                    name="dispute_ships_physical"
                    label={null}
                    defaultChecked={loaderData.shipsPhysical}
                    aria-labelledby={shipsLabelId}
                    aria-describedby={shipsHelpId}
                  />
                </div>
              </>
            ) : (
              <p className="m-0 pt-4 text-micro text-text-subtle">
                Enable Disputes above to configure auto-submit, product description, and shipping settings.
              </p>
            )}
          </div>
        </section>

        {/* Recova's SaveBar: right-aligned, the result beside the button. Only
            while Disputes is on: with the settings hidden there is nothing to
            save, and a save would post them empty. */}
        <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
          <p role="status" className="text-label">
            {result?.ok === true && !result.toggled ? <Status tone="ok">Saved</Status> : null}
            {result?.ok === false ? (
              <Status tone="crit">{result.error ?? "Failed to save. Please try again."}</Status>
            ) : null}
          </p>
          {enabled ? (
            <Button type="submit" variant="primary" pending={saving}>
              Save changes
            </Button>
          ) : null}
        </div>
      </DemoGuardedForm>
    </>
  );
}
