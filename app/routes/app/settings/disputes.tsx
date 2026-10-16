import { useId } from "react";
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
// Capsomer's tokens and the teal family, which the components above read, as
// /settings/features loads them.
import "~/site-header.css";

import { DemoGuardedForm } from "~/components/demo-guarded-form";
import { SettingsBackLink } from "~/components/settings-back-link";
import { getDb } from "~/db";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { readDisputeSettings } from "~/lib/disputes/queries.server";
import { applyDisputeSettings, DISPUTE_PRODUCT_DESCRIPTION_MAX_LENGTH } from "~/lib/settings/apply.server";

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
// three columns without one). This job built the readers:
// - Product description: dispute intake reads it into every response's
//   product_description evidence (readDisputeProductDescription, Recova's
//   buildEvidenceFields).
// - Ships physical goods: the dispute page shows Recova's tracking number,
//   carrier and ship date inputs when it is on (disputes/detail.tsx).
//
// LEFT OUT, and why:
// - Auto-submit disputes: deliberately not built (RULES.md 5.6). Its column is
//   never written here.
// - The Disputes on/off toggle (DisputesToggle, /api/disputes/{enable,disable}
//   over account_products): Foxhound has no disputes entitlement for it to
//   write; dispute intake runs for every connected account. A control that
//   cannot do its job is left out (RULES.md 2.7). The row keeps its label, its
//   "active" pill, which is true for every account, and its line. Listed under
//   "Needs Dustin" in the J06 pull request.
// - Recova's "Enable Disputes above to configure ..." branch, which only shows
//   while the toggle is off, so it cannot occur.
//
// ONE LINE IS NOT RECOVA'S: its page line and section line read "Automatically
// triage chargebacks, stage evidence, and submit responses to Stripe." Foxhound
// does not triage and never submits without the merchant's approval, so the
// line says what it does (RULES.md 1.2, copy where Recova was untrue).
//
// LOOK FROM CAPSOMER (Q10, Q11): PageHead, one panel card with Recova's rows,
// Switch, a cap-input textarea, Button and Status, teal throughout. Recova's
// content, order and arrangement stay, as /settings/features does.

export function meta() {
  return [{ title: "Dispute settings - Foxhound" }];
}

/** The page's line and the Disputes row's line (see above). */
export const DISPUTES_SETTINGS_LINE = "Draft evidence for chargebacks and submit the responses you approve to Stripe.";

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  return readDisputeSettings(getDb(env), auth.membership.accountId);
}

type ActionResult = { ok: true } | { ok: false; error?: string };

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const form = await request.formData();
  try {
    const result = await applyDisputeSettings(getDb(env), auth.membership.accountId, {
      productDescription: form.get("dispute_product_description"),
      // A checkbox posts its name only when checked, so an absent key is OFF.
      shipsPhysical: form.get("dispute_ships_physical") === "on",
    });
    if (!result.ok) return data<ActionResult>({ ok: false, error: result.error }, { status: 400 });
  } catch (err) {
    console.error("dispute settings write failed:", err);
    return data<ActionResult>({ ok: false }, { status: 500 });
  }
  return data<ActionResult>({ ok: true });
}

export default function DisputeSettings({ loaderData, actionData }: Route.ComponentProps) {
  const saving = useNavigation().state === "submitting";
  const result = actionData as ActionResult | undefined;
  const id = useId();
  const descriptionHelpId = `${id}-description-help`;
  const shipsLabelId = `${id}-ships-label`;
  const shipsHelpId = `${id}-ships-help`;

  return (
    <>
      <SettingsBackLink />
      <div className="mb-8">
        <PageHead title="Disputes" lead={DISPUTES_SETTINGS_LINE} />
      </div>

      <DemoGuardedForm method="post">
        <section className="cap-panel">
          <div className="cap-panel-body">
            {/* Recova's top row: the product's name, its active pill and its line. */}
            <div className="border-b border-border pb-4">
              <div className="mb-0.5 flex items-center gap-2">
                <div className="text-label text-text">Disputes</div>
                <Pill tone="ok">Active</Pill>
              </div>
              <p className="m-0 text-micro text-text-subtle">{DISPUTES_SETTINGS_LINE}</p>
            </div>

            <div className="py-4">
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
          </div>
        </section>

        {/* Recova's SaveBar: right-aligned, the result beside the button. */}
        <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
          <p role="status" className="text-label">
            {result?.ok === true ? <Status tone="ok">Saved</Status> : null}
            {result?.ok === false ? (
              <Status tone="crit">{result.error ?? "Failed to save. Please try again."}</Status>
            ) : null}
          </p>
          <Button type="submit" variant="primary" pending={saving}>
            Save changes
          </Button>
        </div>
      </DemoGuardedForm>
    </>
  );
}
