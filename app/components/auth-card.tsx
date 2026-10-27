import { mountTurnstile } from "@dustinedwards/site-runtime/turnstile";
import { Alert, Banner } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Form, Link } from "react-router";

import { authClient } from "~/lib/auth/client";

import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/field.css";
import "capsomer/panel.css";
import "~/site-header.css";

// The parts the sign-in pages share (J52, rows A2 and A3). Recova is the spec
// for the frame: each of its pages (app/(auth)/login and signup page.tsx) is
// one 400px card, centered in a full-height column, holding a centered heading,
// a line under it, the form and a line of links. The parts are Capsomer's
// (Q12), amber, at Recova's sizes: p-12, the 1.5rem heading, 13px labels,
// 42px fields and a 47px button at 0.9375rem.
//
// The ways in are the family's one sign-in (site-runtime ./sign-in; Dustin's
// approval in APPROVED-DIFFERENCES, "Sign-in and invites", 2026-10-24): a
// passkey first, Google and Apple, and an emailed link with Turnstile on it
// once its keys are set. No passwords, so Recova's password field, "Forgot
// password?" and its reset pages are gone.

/**
 * Recova's frame: `min-h-screen flex items-center justify-center` around a
 * `w-full max-w-[400px]` card. The card is Capsomer's panel through its HTML
 * contract, body only, because the React Panel always draws an h2 header band
 * and these pages' one heading is their h1 (the gap J62 named). The wrapper
 * puts the parts in Capsomer's amber family with Foxhound's neutrals (.fh-cap,
 * the pairing /connect and the site header use), so the button and its focus
 * ring are amber. The inner div carries Recova's 48px inset on top of the
 * panel's own, less the panel's: the padding is Recova's (RULES.md 5.1).
 */
export function AuthCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg">
      <div
        className="fh-cap w-full max-w-[400px] [--border-focus:var(--ring)] [--control:2.625rem] [&_.cap-btn]:[--cap-btn-fs:var(--text-subhead)] [&_.cap-btn]:[--cap-btn-h:2.9375rem] [&_.cap-btn]:font-semibold" data-cap-site="foxhound"
        data-family="amber"
        data-auth-card=""
      >
        {/* Recova's card: p-12, its fields 42px tall (py-2.5 at 14px). */}
        <section className="cap-panel [--gap:0px] [--pad-card:0px]">
          <div className="cap-panel-body">
            <div className="p-12">{children}</div>
          </div>
        </section>
      </div>
    </div>
  );
}

/** Recova's centered h1 and the line under it. */
export function AuthHeading({ title, subtitle }: { title: string; subtitle?: ReactNode }) {
  return (
    <>
      <h1 className={`${subtitle ? "mb-2" : "mb-6"} text-center text-subsection font-semibold text-text`}>{title}</h1>
      {subtitle ? (
        <p className="mb-8 text-center text-copy leading-relaxed text-text-subtle">{subtitle}</p>
      ) : null}
    </>
  );
}

/**
 * A labeled input, Capsomer's field through its HTML contract. The React
 * Field prints a "Required" marker beside a required control's label, which
 * Recova's pages do not have, so the contract is used directly, as /connect
 * does. `aside` sits at the label row's end.
 */
function AuthField({
  id,
  label,
  hint,
  aside,
  name,
  type,
  autoComplete,
  placeholder,
  errorId,
}: {
  id: string;
  label: string;
  hint?: string;
  aside?: ReactNode;
  name: string;
  type: "email";
  autoComplete: string;
  placeholder?: string;
  /** The id of the alert showing the form's error, when there is one: the
   *  input is then marked invalid and described by it (review round 1). */
  errorId?: string;
}) {
  const labelEl = (
    <label className="cap-field-label font-normal text-text-tertiary" htmlFor={id}>
      <span className="text-label">
        {label}
        {hint ? <span className="text-text-subtle"> {hint}</span> : null}
      </span>
    </label>
  );
  return (
    <div className="cap-field">
      {aside ? (
        <div className="flex items-center justify-between gap-3">
          {labelEl}
          {aside}
        </div>
      ) : (
        labelEl
      )}
      <input
        id={id}
        className="cap-input"
        name={name}
        type={type}
        autoComplete={autoComplete}
        placeholder={placeholder}
        required
        aria-invalid={errorId ? true : undefined}
        aria-describedby={errorId}
      />
    </div>
  );
}

/** A small text link, amber, underlined so it is not told apart by color
 *  alone, and 24px tall as a target. */
export function AuthLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="inline-flex min-h-6 items-center text-brand-text underline underline-offset-2 hover:opacity-80"
    >
      {children}
    </Link>
  );
}

/** Recova's closing line under the card's form. */
export function AuthFootnote({ children }: { children: ReactNode }) {
  return <p className="mt-6 text-center text-label text-text-subtle">{children}</p>;
}

/** Which ways in a page offers: the loader's signInMethods(env, { social: true }). */
export type SignInMethods = { google: boolean; apple: boolean; turnstileSiteKey: string | null };

/**
 * "Sign in with a passkey", the main way in. The browser asks which saved
 * passkey to use; someone with none cancels and uses another way. It also
 * offers saved passkeys in the email field's suggestions (conditional
 * mediation, the field's autocomplete "webauthn"), so a returning merchant
 * taps one. A passkey sign-in sets the session cookie, so `next` is a full
 * load.
 */
export function PasskeyContinue({ next }: { next: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signInWithPasskey(autoFill: boolean) {
    const res = await authClient.signIn.passkey({ autoFill });
    if (!res?.error) {
      window.location.assign(next);
      return;
    }
    // A canceled prompt is someone choosing another way, not a failure.
    if (!autoFill && !("code" in res.error && res.error.code === "AUTH_CANCELLED")) {
      setError("That passkey did not sign you in. Try again, or use another way below.");
    }
  }

  // Once per page: the browser holds one pending autofill request.
  useEffect(() => {
    if (typeof PublicKeyCredential === "undefined") return;
    void PublicKeyCredential.isConditionalMediationAvailable?.().then((ok) => {
      if (ok) void signInWithPasskey(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mb-3 grid gap-3">
      <Button
        type="button"
        variant="primary"
        size="lg"
        pending={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          await signInWithPasskey(false);
          setBusy(false);
        }}
      >
        Sign in with a passkey
      </Button>
      {error ? <Alert tone="crit">{error}</Alert> : null}
    </div>
  );
}

/** Apple's logo in the text color: Apple's guidelines allow a monochrome
 *  logo beside "Continue with Apple" on a plain button. */
function AppleMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 814 1000" width={14} height={16} fill="currentColor">
      <path d="M788 341c-6 4-108 62-108 190 0 148 130 200 134 202-1 3-21 72-69 142-43 62-88 124-156 124s-86-40-165-40c-77 0-104 41-166 41s-106-57-156-127C44 791 0 668 0 551 0 364 122 264 241 264c64 0 117 42 157 42 38 0 98-45 171-45 28 0 128 3 194 80zM564 166c30-36 51-85 51-135 0-7-1-14-2-19-48 2-106 32-140 73-27 31-53 80-53 131 0 8 1 15 2 18 3 1 9 1 14 1 43 0 98-29 128-69z" />
    </svg>
  );
}

/**
 * Recova's "Continue with Google", and Apple's beside it, each when Foxhound
 * has its settings, then the "or" rule. Each posts to Foxhound's own start
 * route (/auth/google, /auth/apple: Better Auth's signInSocial), never a
 * client-side provider call. Google's mark is a static file because its four
 * brand colors are Google's, not Foxhound tokens.
 *
 * `next` is the page to land on afterwards, when /login was given one (J79).
 */
export function SocialContinue({
  methods,
  next,
  afterPasskey = false,
}: {
  methods: SignInMethods;
  next?: string;
  /** The passkey button is above, so the rule is drawn even with no provider. */
  afterPasskey?: boolean;
}) {
  const providers = [
    methods.google ? { id: "google", label: "Continue with Google", mark: <img src="/google-g.svg" alt="" width={16} height={16} /> } : null,
    methods.apple ? { id: "apple", label: "Continue with Apple", mark: <AppleMark /> } : null,
  ].filter((p) => p !== null);
  return (
    <>
      {providers.map((p) => (
        <Form key={p.id} method="post" action={`/auth/${p.id}`} className="mb-3 grid">
          {/* Where to land afterwards (J79), validated again by the start
              route. Recova carried it in a pending_redirect cookie. */}
          {next ? <input type="hidden" name="next" value={next} /> : null}
          <Button type="submit" size="lg">
            {p.mark}
            {p.label}
          </Button>
        </Form>
      ))}
      {providers.length === 0 && !afterPasskey ? null : (
      <div className="mb-5 mt-5 flex items-center gap-3">
        <span className="h-px flex-1 bg-border" />
        <span className="font-mono text-caption text-text-subtle">or</span>
        <span className="h-px flex-1 bg-border" />
      </div>
      )}
    </>
  );
}

/**
 * "Email me a sign-in link": one link that signs in an existing merchant and
 * creates a new one, then offers a passkey. The page's action sends it
 * (app/lib/auth/sign-in-link.server.ts) and answers the same whether or not
 * the address has an account. With Turnstile on, its widget sits above the
 * button and leaves its token in the form; a token is good for one request,
 * so each answer from the action draws a fresh widget.
 */
export function SignInLinkForm({
  idPrefix,
  turnstileSiteKey,
  next,
  error,
  busy,
  attempt,
  primary = false,
}: {
  idPrefix: string;
  turnstileSiteKey: string | null;
  next?: string;
  error: string | null;
  busy: boolean;
  /** Changes with each answer from the action, so the widget is drawn again. */
  attempt: unknown;
  /** The page's only way in (sign-up), so it takes the primary button as
   *  Recova's lone submit did; beside the passkey it stays secondary. */
  primary?: boolean;
}) {
  const widget = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!turnstileSiteKey || !widget.current) return;
    return mountTurnstile(widget.current, turnstileSiteKey);
  }, [turnstileSiteKey, attempt]);
  const errorId = error ? `${idPrefix}-error` : undefined;

  return (
    <Form method="post">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <div className="mb-4">
        <AuthField
          id={`${idPrefix}-email`}
          errorId={errorId}
          label="Email"
          name="email"
          type="email"
          autoComplete="email webauthn"
        />
      </div>
      {turnstileSiteKey ? <div ref={widget} className="mb-4" /> : null}
      {error ? (
        <div id={errorId} className="mb-4">
          <Alert tone="crit">{error}</Alert>
        </div>
      ) : null}
      <div className="grid">
        <Button type="submit" variant={primary ? "primary" : undefined} size="lg" pending={busy}>
          {busy ? "Sending..." : "Email me a sign-in link"}
        </Button>
      </div>
    </Form>
  );
}

/** What the sign-in link action answered, shown in place of the form. */
export function SignInLinkSent({ email }: { email: string }) {
  return (
    <Banner tone="ok">
      We sent a sign-in link to {email}. It works once and expires in 5 minutes.
    </Banner>
  );
}
