import { data, useNavigation } from "react-router";
import { eq } from "drizzle-orm";

import { Alert, Submit } from "~/components/auth-ui";
import { DemoGuardedForm } from "~/components/demo-guarded-form";
import { accounts, getDb } from "~/db";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { buildFeatureSettingsUpdate } from "~/lib/settings/persist.server";

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
  error?: string;
}

/** A checkbox posts its name only when checked, so an absent key is OFF. */
function checked(form: FormData, name: string): boolean {
  return form.get(name) === "on";
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const form = await request.formData();

  // TWO columns. A form posting digestEnabled beside them writes neither,
  // because the builder names these two and nothing else.
  await buildFeatureSettingsUpdate(getDb(env), auth.membership.accountId, {
    winbackNotificationsEnabled: checked(form, "winbackNotificationsEnabled"),
    expiringCardNotificationsEnabled: checked(form, "expiringCardNotificationsEnabled"),
  });
  return data<ActionResult>({ ok: true });
}

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
  return (
    <div
      className={`flex items-center justify-between gap-4 py-4${first ? "" : " border-t border-border"}`}
    >
      <div>
        <label htmlFor={name} className="text-label text-text">
          {label}
        </label>
        <p className="mt-0.5 text-caption text-text-subtle">{help}</p>
      </div>
      <input id={name} type="checkbox" name={name} defaultChecked={defaultChecked} />
    </div>
  );
}

export default function FeatureSettings({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const result = actionData as ActionResult | undefined;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-8">
      <header>
        <h1 className="text-h2 text-text">Features</h1>
        <p className="mt-1 text-label text-text-tertiary">
          Turn optional recovery features on or off.
        </p>
      </header>

      <section className="rounded-lg border border-border bg-surface p-5">
        {result?.ok ? <Alert tone="success">Saved.</Alert> : null}
        {result && !result.ok && result.error ? <Alert tone="error">{result.error}</Alert> : null}

        <DemoGuardedForm method="post">
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

          <div className="mt-5">
            <Submit disabled={busy}>{busy ? "Saving..." : "Save"}</Submit>
          </div>
        </DemoGuardedForm>
      </section>
    </div>
  );
}
