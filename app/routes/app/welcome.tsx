import { eq } from "drizzle-orm";
import { redirect, useNavigation } from "react-router";

import { Submit } from "~/components/auth-ui";
import { DemoGuardedForm } from "~/components/demo-guarded-form";
import { accounts, getDb } from "~/db";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/welcome";

export function meta() {
  return [{ title: "Welcome - Foxhound" }];
}

// Onboarding for a newly connected merchant. Reflects the honest current
// state: Recovery is live end to end, Disputes' approval flow is real (intake
// is a separate build, see foxhound-build-notes.md Open Items), Billing is a
// read-only evidence ledger. Intelligence is deliberately not mentioned here:
// neither the free MRR analytics nor paid risk scoring produce data yet (the
// Intelligence-engine gap, build-notes Open Items), so onboarding does not
// promise either. First value is the recovery path.
const STEPS = [
  {
    title: "Stripe is connected",
    body: "Foxhound is watching your subscriptions for failed payments.",
  },
  {
    title: "Recovery is running",
    body: "A failed payment gets a silent retry first, then a dunning email in your brand voice if the retry does not clear it. Track every attempt under Recovery.",
  },
  {
    title: "Billing is transparent",
    body: "You are only charged on a payment Foxhound recovered, once it has matured. The Billing ledger shows the exact chain from action to fee, and marks the recoveries Stripe would have collected anyway as free.",
  },
  {
    title: "Disputes get reviewed, never auto-submitted",
    body: "If a chargeback comes in, you will review the drafted evidence and explicitly approve it in Disputes before anything is sent.",
  },
] as const;

export async function loader({ context }: Route.LoaderArgs) {
  const auth = context.get(authContext);
  return { accountName: auth.membership.accountName };
}

export async function action({ context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  await getDb(env)
    .update(accounts)
    .set({ onboardingCompleted: true })
    .where(eq(accounts.id, auth.membership.accountId));
  return redirect("/dashboard");
}

export default function WelcomePage({ loaderData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-title font-medium text-text">
          Welcome{loaderData.accountName ? `, ${loaderData.accountName}` : ""}
        </h1>
        <p className="text-label text-text-tertiary">Here is what Foxhound does for you.</p>
      </div>

      <ol className="flex flex-col gap-4">
        {STEPS.map((step, i) => (
          <li key={step.title} className="rounded-lg border border-border bg-surface p-5">
            <div className="flex items-center gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-brand-border font-mono text-micro text-brand-text">
                {i + 1}
              </span>
              <h2 className="text-label font-semibold text-text">{step.title}</h2>
            </div>
            <p className="mt-2 text-body text-text-secondary">{step.body}</p>
          </li>
        ))}
      </ol>

      <DemoGuardedForm method="post">
        <Submit disabled={busy}>{busy ? "Loading..." : "Go to dashboard"}</Submit>
      </DemoGuardedForm>
    </div>
  );
}
