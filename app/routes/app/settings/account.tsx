import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { data, Form, redirect, useNavigation, useRevalidator } from "react-router";
import { eq } from "drizzle-orm";
import { applyTheme } from "capsomer/behavior/theme-switch";
import { Alert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { InputGroup, InputGroupAddon } from "capsomer/react/field";
import { PageHead } from "capsomer/react/page-head";
import { Panel } from "capsomer/react/panel";
import { Segmented } from "capsomer/react/segmented";
import { Select } from "capsomer/react/select";
import {
  DeleteAccount,
  DeviceSettings,
  EmailSettings,
  PasskeySettings,
  ProviderSettings,
  SecurityHistory,
} from "capsomer/react/sign-in-settings";
import { Status } from "capsomer/react/status";
import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/field.css";
import "capsomer/page-head.css";
import "capsomer/panel.css";
import "capsomer/segmented.css";
import "capsomer/select.css";
import "capsomer/sign-in-settings.css";
import "capsomer/status.css";
// Capsomer's tokens and the amber family, which the components above read. The
// shell loads the same file through its header; importing it here keeps the
// page whole under any layout, as /settings/features does.
import "~/site-header.css";

import {
  accountSessions,
  passkeyLastUsed,
  passkeyRows,
  securityHistory,
  sessionIsFresh,
  signInMethods,
} from "@dustinedwards/site-runtime/sign-in";
import { ACCOUNT_INTENTS, accountFormAction } from "@dustinedwards/site-runtime/sign-in-form";

import { DemoGuardedForm } from "~/components/demo-guarded-form";
import { SettingsBackLink } from "~/components/settings-back-link";
import { THEME_PREF_KEY } from "~/components/site-header";
import { account as authAccount, getDb, passkey } from "~/db";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { applyIntelligenceContext, MRR_ERROR } from "~/lib/settings/apply.server";
import { buildAccountProfileUpdate } from "~/lib/settings/persist.server";
import { getAccount } from "~/lib/settings/queries.server";
import { cancelMerchant } from "~/lib/admin/merchant-cancel.server";
import { IMPERSONATION_READ_ONLY_MESSAGE } from "~/lib/admin/impersonation.server";
import { authClient } from "~/lib/auth/client";
import { getAuth, getSession, listMemberships, setSessionActiveAccount } from "~/lib/auth";
import { deletionConsequence, ownedAccountNames } from "~/lib/auth/deletion-copy";
import { MEMBER_ROLE } from "~/lib/auth/roles";
import { signInAgainHref } from "~/lib/auth/sign-in-paths";
import { DEMO_READ_ONLY_MESSAGE } from "~/lib/demo/constants";
import { chooseTheme } from "~/lib/settings/theme-choice";
import { DEFAULT_THEME, isTheme, THEMES, type Theme } from "~/lib/theme";

import type { Route } from "./+types/account";
import { NOINDEX } from "~/lib/seo/meta";
import { readForm } from "@dustinedwards/site-runtime/body";
import { BODY_MAX_BYTES } from "~/lib/http/body";

// S27, /settings/account, legacy's hub entry 12, "My account".
//
// LEGACY IS THE SPEC, read whole at HEAD:
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
// the account card, the signed-in address with Sign out, and the Danger zone.
//
// THE ENGINE IS FOXHOUND'S for the profile. The three context fields feed the
// recovery email prompt ("Merchant context: ..." in
// recovery/email-generation.ts, the S27 reader of parity/SETTINGS-READERS.md),
// so Recova's "Used to personalize recovery emails." is true here. They are
// written through applyIntelligenceContext, the one writer the merchant's agent
// tool shares, and the name through buildAccountProfileUpdate.
//
// THE ACCOUNT PARTS ARE THE NETWORK'S: Capsomer's account settings
// (capsomer/react/sign-in-settings) on site-runtime's accountFormAction, the
// same on every site, in its order (email, passkeys, Google and Apple, devices,
// history, delete). Foxhound's own beside them: the profile, Appearance, Sign
// out (a button that posts, "yes", 2026-09-19) and "Cancel account", which
// keeps billing records where Recova's delete erased them (APPROVED-DIFFERENCES,
// "yes", 2026-09-19), owner only, placed before Delete. Deletion keeps the
// record of recovered payments the fees are billed on (Q14, row S40, "yes",
// 2026-10-14): delete-account.server.ts, run as Better Auth's beforeDelete.

export function meta() {
  return [{ title: "My account - Foxhound" }, NOINDEX];
}

/** This page, where Google and Apple return and "Sign in again" comes back to. */
const ACCOUNT_PATH = "/settings/account";

/** How many of a person's latest security events the page lists. */
const SECURITY_HISTORY_SHOWN = 10;

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const account = await getAccount(getDb(env), auth.membership.accountId);
  if (!account) throw new Response("Not Found", { status: 404 });
  // The demo and an admin's read-only view: the request's session is not this
  // person's, so nothing is read from it and every change says why not.
  const readOnly = auth.isDemo
    ? DEMO_READ_ONLY_MESSAGE
    : auth.viewingAs
      ? IMPERSONATION_READ_ONLY_MESSAGE
      : null;
  const own = readOnly === null;
  const session = own ? await getSession(env, request) : null;
  return {
    ...(await signInRows(env, auth.userId, auth.isDemo)),
    // Where this person is signed in: Better Auth's own list wants a sign-in
    // from the last 10 minutes, and null asks for one.
    devices: own ? await accountSessions(await getAuth(env), request) : [],
    history: own ? await securityHistory(env.DB, auth.userId, SECURITY_HISTORY_SHOWN) : [],
    fresh: session ? sessionIsFresh(session.session) : false,
    // The address the passkey providers are told (the Signal API), only on
    // this person's own page: an admin's view names someone else's passkeys.
    signalAs: own ? { name: auth.email } : null,
    readOnly,
    signInAgainHref: signInAgainHref(ACCOUNT_PATH),
    account,
    cancelledAt: account.cancelledAt,
    userEmail: auth.email,
    // Every account this person owns, which a deletion clears, so its words
    // can say which (S40 review fix F2). From the session's memberships, so
    // this loader reads no other account's rows.
    deletionConsequence: deletionConsequence(ownedAccountNames(auth.memberships)),
    // The theme this account stores, which is the one the root drew the page
    // in: accounts.theme is NOT NULL, so for a signed-in merchant
    // resolveThemePreference always takes it (lib/theme.ts).
    theme: isTheme(account.theme) ? account.theme : DEFAULT_THEME,
    // Only the owner may cancel the account; the action enforces it, this
    // only decides whether to draw the control (team.tsx does the same).
    isOwner: auth.membership.role === MEMBER_ROLE.OWNER,
    // The demo saves nothing, the theme included (lib/settings/theme-choice.ts).
    isDemo: auth.isDemo,
  };
}

/**
 * This person's passkeys, as site-runtime's passkeyRows gives them (name,
 * provider, added, and last used from auth_events), each with its credential
 * id for the Signal API; and which of Google and Apple are joined. Read from
 * Better Auth's tables by the session's user, as the app's other reads of
 * them are (delete-account.server.ts), rather than through accountPasskeys's
 * own session read, which an admin's read-only view does not have. The demo
 * lists none.
 */
async function signInRows(env: Env, userId: string, isDemo: boolean) {
  const methods = signInMethods(env, { social: true });
  const offered = (["google", "apple"] as const).filter((p) => methods[p]);
  if (isDemo) return { passkeys: [], providers: offered.map((id) => ({ id, accountId: null })) };
  const db = getDb(env);
  const [stored, lastUsed, joined] = await Promise.all([
    db
      .select({
        id: passkey.id,
        name: passkey.name,
        aaguid: passkey.aaguid,
        createdAt: passkey.createdAt,
        credentialId: passkey.credentialID,
      })
      .from(passkey)
      .where(eq(passkey.userId, userId)),
    passkeyLastUsed(env.DB, userId),
    db
      .select({ id: authAccount.id, providerId: authAccount.providerId })
      .from(authAccount)
      .where(eq(authAccount.userId, userId)),
  ]);
  const credentialOf = new Map(stored.map((p) => [p.id, p.credentialId]));
  // The joined account's own id, which Disconnect names.
  const byProvider = new Map(joined.map((a) => [a.providerId, a.id]));
  return {
    passkeys: passkeyRows(stored, lastUsed).map((p) => ({
      ...p,
      credentialId: credentialOf.get(p.id) ?? null,
    })),
    providers: offered.map((id) => ({ id, accountId: byProvider.get(id) ?? null })),
  };
}

type ProfileField = "name" | "merchantMrrSelfReported";

/** The answer to Foxhound's own posts (the profile, Cancel account). */
interface ActionResult {
  intent: string;
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
  const form = await readForm(request, BODY_MAX_BYTES);

  const intent = String(form.get("intent") ?? "");

  // The email change, a device's sign-out and deletion, the same on every site
  // (site-runtime's accountFormAction): each needs a sign-in from the last 10
  // minutes. Deletion is Better Auth's own delete of the SIGNED-IN user, with
  // Foxhound's deletion in its hooks (auth.server.ts), then "/" as in Recova.
  if ((ACCOUNT_INTENTS as readonly string[]).includes(intent)) {
    const shared = await accountFormAction(await getAuth(env), request, form, {
      deletedLanding: "/",
    });
    if (shared && "location" in shared) {
      throw redirect(shared.location, { headers: shared.headers });
    }
    if (shared) return data(shared.state, { status: shared.status });
  }

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
          { intent, ok: false, error: "Account name is required.", field: "name" },
          { status: 400 },
        );
      }
      const posted = (key: string) => (form.has(key) ? String(form.get(key)) : undefined);
      try {
        // ONE BATCH, all or nothing: the name's update rides in the context's
        // batch. The context's MRR check refuses before anything is
        // committed, so a refused save writes nothing, the name included.
        const db = getDb(env);
        const result = await applyIntelligenceContext(
          db,
          accountId,
          {
            merchantIndustry: posted("merchantIndustry"),
            primaryCustomerType: posted("primaryCustomerType"),
            merchantMrrSelfReported: posted("merchantMrrSelfReported"),
          },
          undefined,
          [buildAccountProfileUpdate(db, accountId, { name })],
        );
        if (!result.ok) {
          return data<ActionResult>(
            result.error === MRR_ERROR
              ? { intent, ok: false, error: result.error, field: "merchantMrrSelfReported" }
              : { intent, ok: false, error: result.error },
            { status: 400 },
          );
        }
      } catch (err) {
        // Recova answers a failed update with its SaveBar line, not an error
        // page. The whole error is logged, stack included; it carries no form
        // values.
        console.error("account settings write failed:", err);
        return data<ActionResult>({ intent, ok: false }, { status: 500 });
      }
      return data<ActionResult>({ intent, ok: true });
    }
    case "cancel-account": {
      // OWNER ONLY, refused before any read or write. Canceling disconnects
      // every Stripe connection and stops all recovery on the account, and
      // Recova never let a member do that: it had no Cancel, and its delete
      // cascade cleared only the accounts the caller owned (api/auth/
      // delete-account/route.ts, blob 2136362a). Same shape as team.tsx's gate.
      if (auth.membership.role !== MEMBER_ROLE.OWNER) {
        return data<ActionResult>(
          { intent, ok: false, error: "Only the account owner can cancel the account." },
          { status: 403 },
        );
      }
      // Otherwise S37's cancel, reaching no agent tool (canceling an account
      // is on the HUMAN-FOREVER denylist).
      const db = getDb(env);
      const outcome = await cancelMerchant(env, accountId);
      // Move this session to another account the caller holds, if any. With none
      // left, the marker is cleared and the app shell lands them on the
      // signed-in empty state at /connect the way an accountless session does.
      const session = await getSession(env, request);
      if (session) {
        const remaining = (await listMemberships(db, auth.userId)).filter(
          (m) => m.accountId !== accountId,
        );
        if (remaining.length > 0) {
          await setSessionActiveAccount(db, session.session.id, remaining[0].accountId);
        }
      }
      return data<ActionResult>({
        intent,
        ok: true,
        warning:
          outcome.deauthorizeErrors.length > 0
            ? "Account canceled. Revoking access at Stripe did not complete for every connection, so check your Stripe dashboard."
            : undefined,
      });
    }
    default:
      return data<ActionResult>(
        { intent, ok: false, error: "Unknown settings action." },
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
  const describedBy =
    [error ? errorId : null, help ? helpId : null].filter(Boolean).join(" ") || undefined;
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
      <p
        className="cap-field-error"
        id={errorId}
        role={error ? "alert" : undefined}
        hidden={!error}
      >
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
  const saving =
    navigation.state === "submitting" && navigation.formData?.get("intent") === "profile";
  const fieldError = (field: ProfileField) => (result?.field === field ? result.error : undefined);
  const barFailed = result && !result.ok && !result.field;

  return (
    <DemoGuardedForm method="post">
      <input type="hidden" name="intent" value="profile" />

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
function Appearance({ initial, isDemo }: { initial: Theme; isDemo: boolean }) {
  const [theme, setTheme] = useState<Theme>(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);

  async function select(next: Theme) {
    if (next === theme || pending) return;
    setError(null);
    if (isDemo) {
      // The demo's read-only refusal, as DemoGuardedForm gives every other
      // write: nothing changes and nothing is sent.
      setRefused(true);
      return;
    }
    const prev = theme;
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    setPending(true);
    const outcome = await chooseTheme(next, { isDemo });
    setPending(false);
    if (outcome !== "saved") {
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
        {refused ? (
          <div className="mt-3">
            <Alert tone="neutral">{DEMO_READ_ONLY_MESSAGE}</Alert>
          </div>
        ) : null}
      </div>
    </section>
  );
}

const CANCEL_CONSEQUENCE =
  "This stops all recovery processing and disconnects every Stripe account here. Fees on recoveries Foxhound has already attributed remain owed and are still invoiced.";

/**
 * Foxhound's own account card (AccountSection, blob a154ac8f): the signed-in
 * address with Sign out beside it, and, for the owner, "Cancel account" (S37),
 * which stops processing and keeps the account and its billing records, with
 * Recova's "Are you sure?" callout and "Keep my account" under it. Focus moves
 * to "Keep my account" when the confirmation opens and back to the control
 * that opened it when it closes. Deleting the person is the network's part
 * below it.
 */
function AccountCard({
  userEmail,
  cancelledAt,
  isOwner,
  result,
}: {
  userEmail: string;
  cancelledAt: Date | null;
  isOwner: boolean;
  result?: ActionResult;
}) {
  const navigation = useNavigation();
  const canceling =
    navigation.state !== "idle" && navigation.formData?.get("intent") === "cancel-account";
  const [confirming, setConfirming] = useState(false);
  const moved = useRef(false);
  const ids = useId();
  const keepId = `${ids}-keep`;
  const openerId = `${ids}-cancel`;

  useEffect(() => {
    if (!moved.current) return;
    document.getElementById(confirming ? keepId : openerId)?.focus();
  }, [confirming, keepId, openerId]);

  const open = (next: boolean) => {
    moved.current = true;
    setConfirming(next);
  };
  const mine = result?.intent === "cancel-account" ? result : undefined;

  return (
    <Panel title="Account" description={`Signed in as ${userEmail}.`}>
      <div className="flex flex-col gap-4">
        <Form method="post" action="/logout">
          <Button type="submit">Sign out</Button>
        </Form>

        {cancelledAt ? (
          <p className="text-label text-text-tertiary">
            This account is canceled. Recovery processing is stopped. Fees already earned on
            recoveries Foxhound attributed remain owed.
          </p>
        ) : null}
        {mine?.warning ? <Alert tone="warn">{mine.warning}</Alert> : null}
        {mine && !mine.ok ? <Alert tone="crit">{mine.error}</Alert> : null}

        {/* The owner's control only: a member cannot cancel (the action
            refuses with a 403), so a member is not offered it. */}
        {cancelledAt || !isOwner ? null : confirming ? (
          <DemoGuardedForm method="post" className="flex flex-col gap-3">
            <input type="hidden" name="intent" value="cancel-account" />
            <Alert tone="crit" title="Are you sure?">
              {CANCEL_CONSEQUENCE}
            </Alert>
            <div className="flex flex-wrap gap-2.5">
              <Button type="submit" variant="danger" pending={canceling}>
                {canceling ? "Canceling..." : "Cancel my account"}
              </Button>
              {canceling ? null : (
                <Button id={keepId} onClick={() => open(false)}>
                  Keep my account
                </Button>
              )}
            </div>
          </DemoGuardedForm>
        ) : (
          <div>
            <Button id={openerId} variant="danger" onClick={() => open(true)}>
              Cancel account
            </Button>
          </div>
        )}
      </div>
    </Panel>
  );
}

/** Whether `actionData` is site-runtime's accountFormAction state. */
function isAccountState(value: unknown): value is {
  intent: string;
  ok: boolean;
  error: string | null;
  stale: boolean;
  sentTo: string | null;
} {
  return typeof value === "object" && value !== null && "stale" in value;
}

export default function AccountSettingsPage({ loaderData, actionData }: Route.ComponentProps) {
  const { account, cancelledAt, userEmail, theme, isOwner, isDemo, readOnly } = loaderData;
  const state = isAccountState(actionData) ? actionData : null;
  const result = isAccountState(actionData) ? undefined : (actionData as ActionResult | undefined);
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const posting = navigation.state !== "idle" ? navigation.formData : undefined;
  const pendingIntent = posting ? String(posting.get("intent") ?? "") : null;
  const shared = {
    readOnly,
    signInAgainHref: loaderData.signInAgainHref,
    revalidate: () => revalidator.revalidate(),
  };

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
        <ProfileForm account={account} result={result?.intent === "profile" ? result : undefined} />
      </div>

      <Appearance initial={theme ?? DEFAULT_THEME} isDemo={Boolean(isDemo)} />

      {/* The network's account parts, in its order, with Foxhound's own
          account card (Sign out, Cancel account) before Delete. */}
      <div className="cap-account mt-10">
        <EmailSettings
          email={userEmail}
          state={state}
          pending={pendingIntent === "change-email"}
          readOnly={readOnly}
          signInAgainHref={loaderData.signInAgainHref}
          Form={Form}
        />
        <PasskeySettings
          {...shared}
          client={authClient}
          passkeys={loaderData.passkeys}
          signalAs={loaderData.signalAs}
        />
        <ProviderSettings
          {...shared}
          client={authClient}
          providers={loaderData.providers}
          callbackURL={ACCOUNT_PATH}
        />
        <DeviceSettings
          {...shared}
          client={authClient}
          devices={loaderData.devices}
          state={state}
          pendingSession={
            pendingIntent === "sign-out-device" ? String(posting?.get("session") ?? "") : null
          }
          Form={Form}
        />
        <SecurityHistory history={loaderData.history} />
        <AccountCard
          userEmail={userEmail}
          cancelledAt={cancelledAt}
          isOwner={Boolean(isOwner)}
          result={result}
        />
        <DeleteAccount
          fresh={loaderData.fresh}
          consequence={loaderData.deletionConsequence}
          state={state}
          pending={pendingIntent === "delete-account"}
          readOnly={readOnly}
          signInAgainHref={loaderData.signInAgainHref}
          Form={Form}
        />
      </div>
    </>
  );
}
