import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { data, Form, redirect, useNavigation } from "react-router";
import { applyTheme } from "capsomer/behaviour/theme-switch";
import { Alert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { InputGroup, InputGroupAddon } from "capsomer/react/field";
import { PageHead } from "capsomer/react/page-head";
import { Segmented } from "capsomer/react/segmented";
import { Select } from "capsomer/react/select";
import { Status } from "capsomer/react/status";
import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/field.css";
import "capsomer/page-head.css";
import "capsomer/panel.css";
import "capsomer/segmented.css";
import "capsomer/select.css";
import "capsomer/status.css";
// Capsomer's tokens and the teal family, which the components above read. The
// shell loads the same file through its header; importing it here keeps the
// page whole under any layout, as /settings/features does.
import "~/site-header.css";

import { DemoGuardedForm } from "~/components/demo-guarded-form";
import { SettingsBackLink } from "~/components/settings-back-link";
import { THEME_PREF_KEY } from "~/components/site-header";
import { getDb } from "~/db";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { applyIntelligenceContext, MRR_ERROR } from "~/lib/settings/apply.server";
import { buildAccountProfileUpdate } from "~/lib/settings/persist.server";
import { getAccount } from "~/lib/settings/queries.server";
import { cancelMerchant } from "~/lib/admin/merchants.server";
import { getAuth, getSession, listMemberships, setSessionActiveAccount } from "~/lib/auth";
import { deleteUserAccount } from "~/lib/auth/delete-account.server";
import { deletionConsequence, ownedAccountNames } from "~/lib/auth/deletion-copy";
import { DEFAULT_THEME, isTheme, THEMES, type Theme } from "~/lib/theme";

import type { Route } from "./+types/account";

// S27, /settings/account, legacy's hub entry 12, "My account".
//
// LEGACY IS THE SPEC, read whole at HEAD (J32, job_54cb0e7420dc):
//   settings/account/page.tsx                     blob b42f9159  1,661 bytes
//   settings/account/AccountProfileForm.tsx       blob 85bd1a33    863 bytes
//   settings/components/AccountNameSection.tsx    blob bb58b169    875 bytes
//   settings/components/AccountProfileSection.tsx blob 13a68d29  3,318 bytes
//   settings/components/AppearanceSection.tsx     blob a687d482    503 bytes
//   settings/components/AccountSection.tsx        blob a154ac8f  3,839 bytes
//   settings/SaveBar.tsx                          blob f1d6eb23    830 bytes
//   components/ThemeToggle.tsx                    blob 8f32b6c7  2,123 bytes
//   settings/update/route.ts                      blob 878c0637 10,356 bytes
//
// RECOVA'S ORDER, top to bottom: the phone-only back link; "My account" and its
// line; ONE form holding the account name card and the profile card (industry,
// customer type, MRR) with one SaveBar under them; the Appearance card; then
// the account card, the signed-in address with Sign out, and the Danger zone
// below a rule in the same card.
//
// J32 rebuilt it from Capsomer 0.9.0's parts under Dustin's Q10 and Q11 answers
// of 2026-10-14: PageHead, panels, field, Select, Segmented, Button, Status and
// Alert, teal throughout.
//
// THE ENGINE IS FOXHOUND'S. The three context fields feed the recovery email
// prompt ("Merchant context: ..." in recovery/email-generation.ts, the S27
// reader of parity/SETTINGS-READERS.md), so Recova's "Used to personalize
// recovery emails." is true here. They are written through
// applyIntelligenceContext, the one writer the merchant's agent tool shares
// (372, 374), and the name through buildAccountProfileUpdate.
//
// THE APPROVED DIFFERENCES ON THIS PAGE. "Cancel account" keeps billing
// records where Recova's "Delete account" erased them (APPROVED-DIFFERENCES,
// "yes", 2026-09-19); Delete account is Recova's control, and it keeps the
// record of recovered payments the fees are billed on (Q14, row S40, "yes",
// 2026-10-14); Sign out is a button that posts ("yes", 2026-09-19).

export function meta() {
  return [{ title: "My account - Foxhound" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const account = await getAccount(getDb(env), auth.membership.accountId);
  if (!account) throw new Response("Not Found", { status: 404 });
  return {
    account,
    cancelledAt: account.cancelledAt,
    // The signed-in address, which legacy's AccountSection displays beside its
    // sign-out control.
    userEmail: auth.email,
    // Every account this person owns, which a deletion clears, so the
    // confirmation can say which (S40 review fix F2). From the session's
    // memberships, so this loader reads no other account's rows (ruling 326).
    ownedAccountNames: ownedAccountNames(auth.memberships),
    // The theme this account stores, which is the one the root drew the page
    // in: accounts.theme is NOT NULL, so for a signed-in merchant
    // resolveThemePreference always takes it (lib/theme.ts).
    theme: isTheme(account.theme) ? account.theme : DEFAULT_THEME,
  };
}

type ProfileField = "name" | "merchantMrrSelfReported";

interface ActionResult {
  action: string;
  ok: boolean;
  /** A refusal's words, shown beside `field` when there is one. */
  error?: string;
  field?: ProfileField;
  warning?: string;
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const accountId = auth.membership.accountId;
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "");

  switch (intent) {
    case "profile": {
      // Recova's one save for the name and the three context fields. Each
      // context field is passed only when the form carries it, which is
      // Recova's `formData.has(...)`: a Customer Type with no radio chosen
      // posts nothing and leaves the stored value alone, where reading it as
      // blank would clear it.
      const name = String(form.get("name") ?? "").trim();
      if (!name) {
        // Foxhound's rule, not Recova's: Recova stores an empty name as NULL.
        // The name is the business's name in the header and in every recovery
        // email's prompt, so an empty one is refused before anything is written.
        return data<ActionResult>(
          {
            action: intent,
            ok: false,
            error: "Account name is required.",
            field: "name",
          },
          { status: 400 },
        );
      }
      const posted = (key: string) => (form.has(key) ? String(form.get(key)) : undefined);
      try {
        // The context first, because its MRR check refuses before it writes:
        // a refused save writes nothing, the name included.
        const result = await applyIntelligenceContext(getDb(env), accountId, {
          merchantIndustry: posted("merchantIndustry"),
          primaryCustomerType: posted("primaryCustomerType"),
          merchantMrrSelfReported: posted("merchantMrrSelfReported"),
        });
        if (!result.ok) {
          return data<ActionResult>(
            result.error === MRR_ERROR
              ? {
                  action: intent,
                  ok: false,
                  error: result.error,
                  field: "merchantMrrSelfReported",
                }
              : { action: intent, ok: false, error: result.error },
            { status: 400 },
          );
        }
        await buildAccountProfileUpdate(getDb(env), accountId, { name });
      } catch (err) {
        // Recova answers a failed update with its SaveBar line, not an error
        // page. The whole error is logged, stack included; it carries no form
        // values.
        console.error("account settings write failed:", err);
        return data<ActionResult>({ action: intent, ok: false }, { status: 500 });
      }
      return data<ActionResult>({ action: intent, ok: true });
    }
    case "cancel-account": {
      // Unchanged by J32: S37's cancel, reaching no agent tool (cancelling an
      // account is on the HUMAN-FOREVER denylist).
      const db = getDb(env);
      const outcome = await cancelMerchant(env, accountId);
      // Move this session to another account the caller holds, if any. With none
      // left, the marker is cleared and the app shell lands them on the
      // signed-in empty state at /connect the way an accountless session does.
      const session = await getSession(env, request);
      if (session) {
        const remaining = (await listMemberships(db, auth.userId)).filter((m) => m.accountId !== accountId);
        if (remaining.length > 0) {
          await setSessionActiveAccount(db, session.session.id, remaining[0].accountId);
        }
      }
      return data<ActionResult>({
        action: intent,
        ok: true,
        warning:
          outcome.deauthorizeErrors.length > 0
            ? "Account cancelled. Revoking access at Stripe did not complete for every connection, so check your Stripe dashboard."
            : undefined,
      });
    }
    case "delete-account": {
      // The SIGNED-IN user, never an id from the form: a person deletes
      // themselves and nobody else (RULES.md 4.6). Recova's route does the same
      // with supabase.auth.getUser().
      try {
        await deleteUserAccount(env, auth.userId);
      } catch (err) {
        console.error("account deletion failed:", err);
        // Recova's own words for this failure (AccountSection.tsx, blob a154ac8f).
        return data<ActionResult>(
          {
            action: intent,
            ok: false,
            error: "Failed to delete account. Please contact support.",
          },
          { status: 500 },
        );
      }
      // The user and their sessions are gone; this clears the cookie the
      // browser still holds, and Recova then sends the person to "/".
      const signedOut = await getAuth(env).api.signOut({
        headers: request.headers,
        asResponse: true,
      });
      const headers = new Headers();
      for (const cookie of signedOut.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
      return redirect("/", { headers });
    }
    default:
      return data<ActionResult>(
        { action: intent, ok: false, error: "Unknown settings action." },
        { status: 400 },
      );
  }
}

/** Recova's ten industries, in its order (AccountProfileSection, blob 13a68d29). */
const INDUSTRIES = [
  "SaaS",
  "E-commerce",
  "Marketing & Agencies",
  "Healthcare",
  "Education",
  "Professional Services",
  "Finance",
  "Real Estate",
  "Media & Publishing",
  "Other",
];

const CUSTOMER_TYPES = ["B2B", "B2C"] as const;

/** The select's options. A stored industry outside Recova's list (the
 *  merchant's agent tool takes free text through the same writer) is kept as
 *  an option of its own, so saving the page does not silently erase it. */
function industryOptions(stored: string | null) {
  const options = [
    { value: "", label: "Select an industry" },
    ...INDUSTRIES.map((i) => ({ value: i, label: i })),
  ];
  if (stored && !INDUSTRIES.includes(stored)) options.push({ value: stored, label: stored });
  return options;
}

/** Recova's page.tsx: `String(cents / 100)`, so 500000 shows as 5000. */
function mrrDollars(cents: number | null): string {
  return cents === null ? "" : String(cents / 100);
}

/** One field's label, control, help under it and error, from Capsomer's field
 *  parts, in Recova's arrangement (help under the control), as /settings/email
 *  draws its fields. `control` receives the id and description to carry. */
function RecovaField({
  label,
  help,
  error,
  control,
}: {
  label: string;
  help?: string;
  error?: string;
  control: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: true }) => ReactNode;
}) {
  const base = useId();
  const id = `${base}-control`;
  const helpId = `${base}-help`;
  const errorId = `${base}-error`;
  const describedBy = [error ? errorId : null, help ? helpId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="cap-field" data-invalid={error ? "true" : undefined}>
      <label className="cap-field-label" htmlFor={id}>
        {label}
      </label>
      {control({
        id,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
      })}
      {help ? (
        <p className="cap-field-help" id={helpId}>
          {help}
        </p>
      ) : null}
      <p className="cap-field-error" id={errorId} role={error ? "alert" : undefined} hidden={!error}>
        {error ?? null}
      </p>
    </div>
  );
}

/** AccountProfileForm: the name card, the profile card and one SaveBar. */
function ProfileForm({
  account,
  result,
}: {
  account: {
    name: string | null;
    merchantIndustry: string | null;
    primaryCustomerType: string | null;
    merchantMrrSelfReported: number | null;
  };
  result?: ActionResult;
}) {
  const navigation = useNavigation();
  const saving = navigation.state === "submitting" && navigation.formData?.get("_action") === "profile";
  const fieldError = (field: ProfileField) => (result?.field === field ? result.error : undefined);
  const barFailed = result && !result.ok && !result.field;

  return (
    <DemoGuardedForm method="post">
      <input type="hidden" name="_action" value="profile" />

      {/* AccountNameSection */}
      <section className="cap-panel">
        <div className="cap-panel-body">
          <RecovaField
            label="Account name"
            help="Your business or product name"
            error={fieldError("name")}
            control={(p) => (
              <input
                {...p}
                type="text"
                name="name"
                className="cap-input"
                defaultValue={account.name ?? ""}
                placeholder="e.g. Acme Inc"
              />
            )}
          />
        </div>
      </section>

      {/* AccountProfileSection, 16px under the name card as Recova's mb-4. */}
      <div className="mt-4">
        <section className="cap-panel">
          <div className="cap-panel-body">
            <div className="mb-5">
              <RecovaField
                label="Industry"
                control={(p) => (
                  <Select
                    {...p}
                    name="merchantIndustry"
                    defaultValue={account.merchantIndustry ?? ""}
                    options={industryOptions(account.merchantIndustry)}
                  />
                )}
              />
            </div>

            <div className="mb-5">
              <fieldset className="cap-field">
                <legend className="cap-field-label">Customer Type</legend>
                {/* Recova's two radios side by side, 16px apart. */}
                <div className="flex gap-4">
                  {CUSTOMER_TYPES.map((option) => (
                    <label key={option} className="cap-check">
                      <input
                        type="radio"
                        name="primaryCustomerType"
                        value={option}
                        defaultChecked={account.primaryCustomerType === option}
                      />
                      {option}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>

            <RecovaField
              label="Monthly Recurring Revenue"
              help="Used to personalize recovery emails."
              error={fieldError("merchantMrrSelfReported")}
              control={(p) => (
                <InputGroup>
                  <InputGroupAddon align="inline-start">
                    <span className="cap-input-group-text">$</span>
                  </InputGroupAddon>
                  <input
                    {...p}
                    type="number"
                    name="merchantMrrSelfReported"
                    className="cap-input"
                    defaultValue={mrrDollars(account.merchantMrrSelfReported)}
                    placeholder="0"
                    min="0"
                    step="any"
                  />
                </InputGroup>
              )}
            />
          </div>
        </section>
      </div>

      {/* Recova's SaveBar: right-aligned, the result beside the button. */}
      <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
        <p role="status" className="text-label">
          {result?.ok === true ? <Status tone="ok">Saved</Status> : null}
          {barFailed ? <Status tone="crit">Failed to save. Please try again.</Status> : null}
        </p>
        <Button type="submit" variant="primary" pending={saving}>
          Save changes
        </Button>
      </div>
    </DemoGuardedForm>
  );
}

const THEME_FAILED = "Failed to save theme. Please try again.";
const THEME_LABEL: Record<Theme, string> = { dark: "Dark", light: "Light" };

/**
 * AppearanceSection with Recova's ThemeToggle (blob 8f32b6c7): the two themes,
 * dark first, as Capsomer's segmented control. A choice applies at once, saves
 * to the account through /api/theme (Recova's /api/account/theme), and on a
 * failed save goes back and says Recova's line.
 *
 * Once the save lands, Capsomer's applyTheme remembers the choice in this
 * browser and tells the header's theme button, so the two never disagree.
 * The header's listener (useThemeMemory) then saves the same value once more;
 * the write is idempotent, and leaving it in place keeps the header unchanged.
 */
function Appearance({ initial }: { initial: Theme }) {
  const [theme, setTheme] = useState<Theme>(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function select(next: Theme) {
    if (next === theme || pending) return;
    setError(null);
    const prev = theme;
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    setPending(true);
    let saved = false;
    try {
      const res = await fetch("/api/theme", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: next }),
      });
      saved = res.ok;
    } catch {
      saved = false;
    }
    setPending(false);
    if (!saved) {
      setTheme(prev);
      document.documentElement.setAttribute("data-theme", prev);
      setError(THEME_FAILED);
      return;
    }
    applyTheme(next, { key: THEME_PREF_KEY });
  }

  return (
    <section className="cap-panel">
      <div className="cap-panel-body">
        <p className="mb-4 text-label text-text-tertiary">
          Choose how Foxhound looks. Saved to your account and synced across devices.
        </p>
        <Segmented
          // Recova's group is named "Theme" (aria-label) with no visible
          // label. The name is visually hidden inside the legend, not with
          // Capsomer's hideLegend: that sets .cap-sr-only, which lives in
          // capsomer/base.css, and the merchant app does not load base.css
          // (app/site-header.css), as /settings/audit records.
          legend={<span className="sr-only">Theme</span>}
          options={THEMES.map((t) => ({ value: t, label: THEME_LABEL[t] }))}
          value={theme}
          onChange={(next) => void select(next)}
        />
        {error ? (
          <p role="alert" className="mt-2 text-label">
            <Status tone="crit">{error}</Status>
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** AccountSection's top row: the signed-in address, and Sign out beside it. */
function SignedIn({ userEmail }: { userEmail: string }) {
  return (
    <div className="flex flex-col items-start gap-3 md:flex-row md:items-center md:justify-between">
      <div className="text-label text-text">{userEmail}</div>
      <Form method="post" action="/logout">
        <Button type="submit">Sign out</Button>
      </Form>
    </div>
  );
}

const CANCEL_CONSEQUENCE =
  "This stops all recovery processing and disconnects every Stripe account here. Fees on recoveries Foxhound has already attributed remain owed and are still invoiced.";

type Confirming = "cancel-account" | "delete-account" | null;

/**
 * AccountSection's Danger zone (blob a154ac8f), below a rule in the account
 * card: the label, the controls at the right, and on a press Recova's
 * "Are you sure?" callout with the confirm and "Keep my account" under it;
 * while it runs, the confirm says so and Keep is withdrawn.
 *
 * TWO CONTROLS. "Cancel account" (S37, 333) stops processing and keeps the
 * account and its billing records; "Delete account" (S40) is Recova's, and
 * deletes the person while keeping the fee evidence. Both take Recova's
 * two-step confirmation. Focus moves to "Keep my account" when a confirmation
 * opens and back to the control that opened it when it closes.
 */
function DangerZone({
  cancelledAt,
  ownedAccountNames,
  result,
}: {
  cancelledAt: Date | null;
  ownedAccountNames: Array<string | null>;
  result?: ActionResult;
}) {
  const navigation = useNavigation();
  const running = navigation.state !== "idle" ? String(navigation.formData?.get("_action") ?? "") : "";
  const [confirming, setConfirming] = useState<Confirming>(null);
  const opener = useRef<Confirming>(null);
  const moved = useRef(false);
  const ids = useId();
  const keepId = `${ids}-keep`;
  const openerId = (which: Exclude<Confirming, null>) => `${ids}-${which}`;

  useEffect(() => {
    if (!moved.current) return;
    const target = confirming ? `${ids}-keep` : opener.current ? `${ids}-${opener.current}` : null;
    if (target) document.getElementById(target)?.focus();
  }, [confirming, ids]);

  const open = (which: Confirming) => {
    moved.current = true;
    if (which) opener.current = which;
    setConfirming(which);
  };

  const keep = (
    <Button id={keepId} onClick={() => open(null)}>
      Keep my account
    </Button>
  );
  const deleteFailed = result?.action === "delete-account" && !result.ok ? result.error : undefined;
  const cancelWarning = result?.action === "cancel-account" ? result.warning : undefined;

  return (
    <div className="mt-5 border-t border-border pt-5">
      <h2 className="mb-3 text-label font-normal text-text-subtle">Danger zone</h2>

      <div className="flex flex-col gap-3">
        {cancelledAt ? (
          <p className="text-label text-text-tertiary">
            This account is cancelled. Recovery processing is stopped. Fees already earned on recoveries
            Foxhound attributed remain owed.
          </p>
        ) : null}
        {cancelWarning ? <Alert tone="warn">{cancelWarning}</Alert> : null}
        {deleteFailed ? <Alert tone="crit">{deleteFailed}</Alert> : null}

        {confirming === "cancel-account" ? (
          <DemoGuardedForm method="post" className="flex flex-col gap-3">
            <input type="hidden" name="_action" value="cancel-account" />
            <Alert tone="crit" title="Are you sure?">
              {CANCEL_CONSEQUENCE}
            </Alert>
            <div className="flex flex-wrap gap-2.5">
              <Button type="submit" variant="danger" pending={running === "cancel-account"}>
                {running === "cancel-account" ? "Cancelling..." : "Yes, cancel my account"}
              </Button>
              {running === "cancel-account" ? null : keep}
            </div>
          </DemoGuardedForm>
        ) : confirming === "delete-account" ? (
          <DemoGuardedForm method="post" className="flex flex-col gap-3">
            <input type="hidden" name="_action" value="delete-account" />
            <Alert tone="crit" title="Are you sure?">
              {deletionConsequence(ownedAccountNames)}
            </Alert>
            <div className="flex flex-wrap gap-2.5">
              <Button type="submit" variant="danger" pending={running === "delete-account"}>
                {running === "delete-account" ? "Deleting..." : "Yes, delete my account"}
              </Button>
              {running === "delete-account" ? null : keep}
            </div>
          </DemoGuardedForm>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2.5">
            {cancelledAt ? null : (
              <Button id={openerId("cancel-account")} variant="danger" onClick={() => open("cancel-account")}>
                Cancel account
              </Button>
            )}
            <Button id={openerId("delete-account")} variant="danger" onClick={() => open("delete-account")}>
              Delete account
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function AccountSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { account, cancelledAt, userEmail, ownedAccountNames, theme } = loaderData;
  const result = actionData as ActionResult | undefined;

  return (
    <>
      <SettingsBackLink />
      {/* Legacy's PageHeader leaves 32px under the head (mb-8); the wrapper
          keeps that space without styling Capsomer's head. */}
      <div className="mb-8">
        <PageHead title="My account" lead="Profile, appearance, and account controls." />
      </div>

      {/* Recova's mb-10 under the form. */}
      <div className="mb-10">
        <ProfileForm account={account} result={result?.action === "profile" ? result : undefined} />
      </div>

      <Appearance initial={theme ?? DEFAULT_THEME} />

      {/* Recova's mt-6 over the account card, after the appearance card's mb-4. */}
      <div className="mt-10">
        <section className="cap-panel">
          <div className="cap-panel-body">
            <SignedIn userEmail={userEmail} />
            <DangerZone cancelledAt={cancelledAt} ownedAccountNames={ownedAccountNames} result={result} />
          </div>
        </section>
      </div>
    </>
  );
}
