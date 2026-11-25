import { ButtonLink } from "capsomer/react/link";
import { useState } from "react";
import { Form, useNavigation, useSearchParams } from "react-router";
import { applyTheme } from "capsomer/behavior/theme-switch";
import { SaveBar } from "capsomer/react/save-bar";
import { Alert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Field, InputGroup, InputGroupAddon, TextField } from "capsomer/react/field";
import { Segmented } from "capsomer/react/segmented";
import { Select } from "capsomer/react/select";
import { Status } from "capsomer/react/status";
import "capsomer/banner.css";
import "capsomer/segmented.css";
import "capsomer/select.css";
import { InlineConfirm } from "capsomer/react/inline-confirm";
import "capsomer/inline-confirm.css";
import { DemoForm, useDemoConfirmForm } from "~/lib/demo/use-demo-guard";
import { THEME_PREF_KEY } from "~/components/site-header";
import { deletionConsequence } from "~/lib/auth/deletion-copy";
import { REAUTH_PARAM } from "~/lib/auth/next-path";
import { DEMO_READ_ONLY_MESSAGE } from "~/lib/demo/constants";
import { chooseTheme } from "~/lib/settings/theme-choice";
import { THEMES, type Theme } from "~/lib/theme";

export type ProfileField = "name" | "merchantMrrSelfReported";

export interface ActionResult {
  action: string;
  ok: boolean;
  /** A refusal's words, shown beside `field` when there is one. */
  error?: string;
  field?: ProfileField;
  warning?: string;
  /** change-email: the current address the first link went to. */
  sentTo?: string;
}

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

/** The select's options. A stored industry outside the list (the merchant's agent tool takes free text through the same writer) is kept as an option of its own, so saving the page does not silently erase it. */
function industryOptions(stored: string | null) {
  const options = [
    { value: "", label: "Select an industry" },
    ...INDUSTRIES.map((i) => ({ value: i, label: i })),
  ];
  if (stored && !INDUSTRIES.includes(stored)) options.push({ value: stored, label: stored });
  return options;
}

function mrrDollars(cents: number | null): string {
  return cents === null ? "" : String(cents / 100);
}

export function ProfileForm({
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
    navigation.state === "submitting" && navigation.formData?.get("_action") === "profile";
  const fieldError = (field: ProfileField) => (result?.field === field ? result.error : undefined);
  const barFailed = result && !result.ok && !result.field;

  return (
    <DemoForm method="post">
      <input type="hidden" name="_action" value="profile" />

      {/* AccountNameSection */}
      <section className="cap-panel">
        <div className="cap-panel-body">
          {/* Recova puts help under the control. */}
          <TextField
            announce
            label="Account name"
            error={fieldError("name")}
            name="name"
            defaultValue={account.name ?? ""}
            placeholder="e.g. Acme Inc"
          />
        </div>
      </section>

      {/* AccountProfileSection, 16px under the name card as Recova's mb-4. */}
      <div className="fh-account-confirm">
        <section className="cap-panel">
          <div className="cap-panel-body">
            <div className="fh-account-field">
              <Field announce label="Industry">
                {(p) => (
                  <Select
                    {...p}
                    name="merchantIndustry"
                    defaultValue={account.merchantIndustry ?? ""}
                    options={industryOptions(account.merchantIndustry)}
                  />
                )}
              </Field>
            </div>

            <div className="fh-account-field">
              <fieldset className="cap-field">
                <legend className="cap-field-label">Customer Type</legend>
                {/* Recova's two radios side by side, 16px apart. */}
                <div className="fh-account-pair">
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

            <Field
              announce
              label="Monthly Recurring Revenue"
              error={fieldError("merchantMrrSelfReported")}
            >
              {(p) => (
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
            </Field>
          </div>
        </section>
      </div>

      {/* Recova's SaveBar: right-aligned, the result beside the button. */}
      <SaveBar
        pending={saving}
        saved={result?.ok === true}
        error={barFailed ? "Failed to save. Please try again." : null}
      />
    </DemoForm>
  );
}

const THEME_FAILED = "Failed to save theme. Please try again.";
const THEME_LABEL: Record<Theme, string> = { dark: "Dark", light: "Light" };

/** The two themes, dark first, as Capsomer's segmented control. A choice applies at once, saves to the account through /api/theme, and on a failed save goes back and says so. Once the save lands, Capsomer's applyTheme remembers the choice in this browser and tells the header's theme button, so the two never disagree. */
export function Appearance({ initial, isDemo }: { initial: Theme; isDemo: boolean }) {
  const [theme, setTheme] = useState<Theme>(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);

  async function select(next: Theme) {
    if (next === theme || pending) return;
    setError(null);
    if (isDemo) {
      // The demo's read-only refusal, as ReadOnlyForm gives every other write: nothing changes and nothing is sent.
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
        <Segmented
          // The group is named "Theme" (aria-label) with no visible label. The name is visually hidden inside the legend, not with Capsomer's hideLegend: that sets .cap-sr-only, which lives in capsomer/base.css, and the merchant app does not load base.css (app/site-header.css).
          legend={<span className="cap-sr-only">Theme</span>}
          options={THEMES.map((t) => ({ value: t, label: THEME_LABEL[t] }))}
          value={theme}
          onChange={(next) => void select(next)}
        />
        {error ? (
          <p role="alert" className="fh-account-alert fh-small">
            <Status tone="crit">{error}</Status>
          </p>
        ) : null}
        {refused ? (
          <div className="fh-account-actions">
            <Alert tone="neutral">{DEMO_READ_ONLY_MESSAGE}</Alert>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function SignedIn({ userEmail }: { userEmail: string }) {
  return (
    <div className="fh-setting-row">
      <div className="fh-small fh-text">{userEmail}</div>
      <Form method="post" action="/logout">
        <Button type="submit">Sign out</Button>
      </Form>
    </div>
  );
}

/** Change the sign-in address. The form asks Better Auth for the change (the action's change-email), which mails the CURRENT address first; its link then mails the new one, and that link makes the change. It needs a sign-in from the last 10 minutes, as Delete account does. */
export function ChangeEmail({ result }: { result?: ActionResult }) {
  const navigation = useNavigation();
  const sending =
    navigation.state !== "idle" && navigation.formData?.get("_action") === "change-email";
  const [open, setOpen] = useState(false);
  const mine = result?.action === "change-email" ? result : undefined;
  const stale = mine?.error === "stale";
  const refused = mine && !mine.ok && !stale ? mine.error : undefined;
  const showForm = (open || Boolean(refused)) && !mine?.ok;

  return (
    <div className="fh-account-list">
      {mine?.ok ? (
        <Alert tone="ok">
          We sent a link to {mine.sentTo}. Open it to confirm the change; we then send one to the
          new address.
        </Alert>
      ) : null}
      {stale ? (
        <Alert
          tone="warn"
          action={
            <ButtonLink href={SIGN_IN_AGAIN_HREF} size="sm">
              Sign in again
            </ButtonLink>
          }
        >
          Changing your email needs a sign-in from the last 10 minutes. Sign in again, then change
          it.
        </Alert>
      ) : null}
      {showForm ? (
        <DemoForm method="post">
          <input type="hidden" name="_action" value="change-email" />
          <TextField
            label="New email address"
            name="newEmail"
            type="email"
            required
            showRequired={false}
            autoComplete="email"
            error={refused}
            announce
            action={
              <Button type="submit" variant="primary" pending={sending}>
                {sending ? "Sending..." : "Send confirmation"}
              </Button>
            }
          />
        </DemoForm>
      ) : mine?.ok ? null : (
        <div>
          <Button size="sm" onClick={() => setOpen(true)}>
            Change email
          </Button>
        </div>
      )}
    </div>
  );
}

const CANCEL_CONSEQUENCE =
  "This stops all recovery processing and disconnects every Stripe account here. Fees on recoveries Foxhound has already attributed remain owed and are still invoiced.";

const SIGN_IN_AGAIN_HREF = `/login?${REAUTH_PARAM}&next=${encodeURIComponent("/settings/account")}`;

/** The Danger zone, below a rule in the account card: the label, the controls at the right, and on a press the question with the confirm and "Keep my account" in its place; while it runs, the confirm says so and Keep is withdrawn. TWO CONTROLS: "Cancel account" stops processing and keeps the account and its billing records; "Delete account" deletes the person while keeping the fee evidence. Each is its own InlineConfirm, so focus moves to "Keep my account" when a confirmation opens and back to the control that opened it when it closes. Without script the first step is a link to ?confirm=<action>. */
export function DangerZone({
  cancelledAt,
  isOwner,
  ownedAccountNames,
  result,
}: {
  cancelledAt: Date | null;
  isOwner: boolean;
  ownedAccountNames: Array<string | null>;
  result?: ActionResult;
}) {
  const confirmForm = useDemoConfirmForm();
  const navigation = useNavigation();
  const running =
    navigation.state !== "idle" ? String(navigation.formData?.get("_action") ?? "") : "";
  const confirming = useSearchParams()[0].get("confirm");

  const deleteStale = result?.action === "delete-account" && result.error === "stale";
  const deleteFailed =
    result?.action === "delete-account" && !result.ok && !deleteStale ? result.error : undefined;
  const cancelWarning = result?.action === "cancel-account" ? result.warning : undefined;
  const cancelRefused =
    result?.action === "cancel-account" && !result.ok ? result.error : undefined;

  const step = (action: "cancel-account" | "delete-account") => ({
    form: confirmForm,
    size: "default" as const,
    cancelLabel: "Keep my account",
    openHref: `?confirm=${action}`,
    closeHref: "?",
    defaultOpen: confirming === action,
    pending: running === action,
  });

  return (
    <div className="fh-settings-group">
      <h2 className="fh-danger-title fh-small fh-regular fh-faint">Danger zone</h2>

      <div className="cap-stack" data-gap="4">
        {cancelledAt ? (
          <p className="fh-small fh-quiet">
            This account is canceled. Recovery processing is stopped. Fees already earned on
            recoveries Foxhound attributed remain owed.
          </p>
        ) : null}
        {cancelWarning ? <Alert tone="warn">{cancelWarning}</Alert> : null}
        {deleteFailed ? <Alert tone="crit">{deleteFailed}</Alert> : null}
        {deleteStale ? (
          <Alert
            tone="warn"
            action={
              <ButtonLink href={SIGN_IN_AGAIN_HREF} size="sm">
                Sign in again
              </ButtonLink>
            }
          >
            Deleting your account needs a sign-in from the last 10 minutes. Sign in again, then
            delete it.
          </Alert>
        ) : null}
        {cancelRefused ? <Alert tone="crit">{cancelRefused}</Alert> : null}

        <div className="fh-account-end">
          {/* The owner's control only: a member cannot cancel (the action
              refuses with a 403), so a member is not offered it. */}
          {cancelledAt || !isOwner ? null : (
            <InlineConfirm
              {...step("cancel-account")}
              label="Cancel account"
              question={
                <>
                  <strong>Are you sure?</strong> {CANCEL_CONSEQUENCE}
                </>
              }
              confirmLabel="Cancel my account"
              pendingLabel="Canceling..."
            >
              <input type="hidden" name="_action" value="cancel-account" />
            </InlineConfirm>
          )}
          <InlineConfirm
            {...step("delete-account")}
            label="Delete account"
            question={
              <>
                <strong>Are you sure?</strong> {deletionConsequence(ownedAccountNames)}
              </>
            }
            confirmLabel="Delete my account"
            pendingLabel="Deleting..."
          >
            <input type="hidden" name="_action" value="delete-account" />
          </InlineConfirm>
        </div>
      </div>
    </div>
  );
}
