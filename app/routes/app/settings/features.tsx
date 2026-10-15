import { useId } from "react";
import { data, Link, useNavigation } from "react-router";
import { eq } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { Button } from "capsomer/react/button";
import { PageHead } from "capsomer/react/page-head";
import { Status } from "capsomer/react/status";
import { Switch } from "capsomer/react/switch";
import "capsomer/button.css";
import "capsomer/page-head.css";
import "capsomer/panel.css";
import "capsomer/status.css";
import "capsomer/switch.css";
// Capsomer's tokens and the teal family, which the components above read. The
// shell loads the same file through its header; importing it here keeps the
// page whole under any layout, as /settings/api-keys does.
import "~/site-header.css";

import { DemoGuardedForm } from "~/components/demo-guarded-form";
import { accounts, getDb } from "~/db";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { applyFeatureSettings } from "~/lib/settings/apply.server";

import type { Route } from "./+types/features";

// S34, /settings/features. The writer for the two toggles sessions 49 and 52
// built their crons against.
//
// LEGACY IS THE SPEC, read whole:
//   settings/features/page.tsx        blob d130d2c8  1,160 bytes
//   settings/features/FeaturesForm.tsx blob 4aed5869    915 bytes
//   components/FeaturesSection.tsx    blob e7559f6b  1,536 bytes
//
// TWO TOGGLES, AND THE PAGE NEVER TOUCHES `account_products`. Its select names
// exactly the two booleans. That settles the conflict this session was
// dispatched on: the S34 row cell's "account_products gate" is wrong, session
// 44's walk is right, and 330's "account_products is dropped" stands unbothered.
//
// NULL IS ON, on both, and BOTH ENDS AGREE. Legacy renders `?? true`; Foxhound's
// crons skip on `=== false` (cron/winback.ts:178, cron/expiring-cards.ts:280),
// so a merchant who has never opened this page gets both features, which is
// what those two engines already assumed.
//
// J38 (job_4ed2f8dafcf4) rebuilt the page from Capsomer 0.9.0's parts under
// Dustin's Q10 and Q11 answers of 2026-10-14: PageHead, a Panel's card, Switch,
// Button and Status, teal throughout. Recova stays the spec for what is here
// and in what order: the phone-only back link, the title and its line, one
// card holding the two rows (label and help on the left, the toggle on the
// right), then SaveBar's right-aligned "Save changes" with "Saved" or
// "Failed to save. Please try again." beside it.
//
// IT UN-GATES NOTHING ELSE, and ruling 176's claim that it does is disproven in
// legacy's own source: `components/SiteNav.tsx:110-119` gates the product
// switcher (S2's disputes state, S6's Intelligence entry) on `account_products`
// with status active or trialing, not on these booleans. Foxhound's equivalent
// gate is `isIntelligenceEntitled` over `account_subscriptions`
// (nav/context.server.ts:56, ruling 292's rewire), also a different table.
// Nothing on this page can move either, and nothing here tries.

export function meta() {
  return [{ title: "Feature settings - Foxhound" }];
}

/** Legacy's `?? true` on both. A merchant who has never touched this page has
 *  both features on, which is 337 binding 3's NULL-is-ON pair. */
const NULL_IS_ON = true;

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const [row] = await getDb(env)
    .select({
      winbackNotificationsEnabled: accounts.winbackNotificationsEnabled,
      expiringCardNotificationsEnabled: accounts.expiringCardNotificationsEnabled,
    })
    .from(accounts)
    .where(eq(accounts.id, auth.membership.accountId))
    .limit(1);

  return {
    winbackNotificationsEnabled: row?.winbackNotificationsEnabled ?? NULL_IS_ON,
    expiringCardNotificationsEnabled: row?.expiringCardNotificationsEnabled ?? NULL_IS_ON,
  };
}

interface ActionResult {
  ok: boolean;
}

/** A checkbox posts its name only when checked, so an absent key is OFF. */
function checked(form: FormData, name: string): boolean {
  return form.get(name) === "on";
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const form = await request.formData();

  // TWO columns, through the shared apply layer (session 79) so this action and
  // the MCP `set_feature_settings` tool cannot disagree. A form posting
  // digestEnabled beside them writes neither, because the builder names these
  // two and nothing else.
  //
  // A failed write says Recova's SaveBar line on this page instead of throwing
  // an error page. (Recova redirects a failure to /settings?error=update_failed;
  // the line it shows is the same.)
  try {
    await applyFeatureSettings(getDb(env), auth.membership.accountId, {
      winbackNotificationsEnabled: checked(form, "winbackNotificationsEnabled"),
      expiringCardNotificationsEnabled: checked(form, "expiringCardNotificationsEnabled"),
    });
  } catch (err) {
    console.error(
      "feature settings write failed:",
      err instanceof Error ? err.message : "unknown error",
    );
    return data<ActionResult>({ ok: false }, { status: 500 });
  }
  return data<ActionResult>({ ok: true });
}

/** Legacy's SettingsBackLink (components/SettingsBackLink.tsx, blob 64d4a153):
 *  on a phone, where the settings menu is hidden, a link back to the hub. The
 *  same element as /settings/api-keys; it moves to the shared
 *  app/components/settings-back-link.tsx once that lands (pull request 101). */
function SettingsBackLink() {
  return (
    <Link
      to="/settings"
      className="mb-6 inline-flex min-h-6 items-center gap-1.5 text-label text-text-secondary no-underline hover:text-text md:hidden"
    >
      <ArrowLeft className="h-4 w-4" strokeWidth={2} aria-hidden />
      Settings
    </Link>
  );
}

/** One of FeaturesSection's two rows: the label and its help on the left, the
 *  toggle on the right, a rule between rows. The toggle is Capsomer's Switch, a
 *  real checkbox that posts "on" with the form, named by the visible label and
 *  described by the help line. Clicking the label flips it, as in Recova. */
function ToggleRow({
  name,
  label,
  help,
  defaultChecked,
  first,
}: {
  name: string;
  label: string;
  help: string;
  defaultChecked: boolean;
  first?: boolean;
}) {
  const id = useId();
  const labelId = `${id}-label`;
  const helpId = `${id}-help`;
  return (
    <div
      className={`flex items-center justify-between gap-4 py-4${first ? "" : " border-t border-border"}`}
    >
      <div>
        <label id={labelId} htmlFor={id} className="mb-0.5 block text-label text-text">
          {label}
        </label>
        <p id={helpId} className="text-micro text-text-subtle">
          {help}
        </p>
      </div>
      <Switch
        id={id}
        name={name}
        label={null}
        defaultChecked={defaultChecked}
        aria-labelledby={labelId}
        aria-describedby={helpId}
      />
    </div>
  );
}

export default function FeatureSettings({ loaderData, actionData }: Route.ComponentProps) {
  const saving = useNavigation().state === "submitting";
  const result = actionData as ActionResult | undefined;

  return (
    <>
      <SettingsBackLink />
      {/* Legacy's PageHeader leaves 32px under the head (mb-8); the wrapper
          keeps that space without styling Capsomer's head. */}
      <div className="mb-8">
        <PageHead title="Features" lead="Turn optional recovery features on or off." />
      </div>

      <DemoGuardedForm method="post">
        <section className="cap-panel">
          <div className="cap-panel-body">
            <ToggleRow
              first
              name="winbackNotificationsEnabled"
              label="Win-back sequences"
              help="Send re-engagement emails to customers who cancel their subscription"
              defaultChecked={loaderData.winbackNotificationsEnabled}
            />
            <ToggleRow
              name="expiringCardNotificationsEnabled"
              label="Expiring card alerts"
              help="Email customers before their card expires to prevent future failures"
              defaultChecked={loaderData.expiringCardNotificationsEnabled}
            />
          </div>
        </section>

        {/* Recova's SaveBar: right-aligned, the result beside the button. */}
        <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
          <p role="status" className="text-label">
            {result?.ok === true ? <Status tone="ok">Saved</Status> : null}
            {result?.ok === false ? (
              <Status tone="crit">Failed to save. Please try again.</Status>
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
