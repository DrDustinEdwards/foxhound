import { Button } from "capsomer/react/button";
import type { ReactNode } from "react";
import { Form, Link } from "react-router";

import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/field.css";
import "capsomer/panel.css";
import "~/site-header.css";

// The parts the four sign-in pages share (J52, rows A2 to A5). Recova is the
// spec for what is on them and where: each of its four pages
// (app/(auth)/login, signup, forgot-password and reset-password page.tsx) is
// one 400px card, centred in a full-height column, holding a centred heading,
// a line under it, the form and a line of links. The parts are Capsomer's
// (Q12), teal (Q11), and the text keeps the five sizes (RULES.md 5.2).

/**
 * Recova's frame: `min-h-screen flex items-center justify-center` around a
 * `w-full max-w-[400px]` card. The card is Capsomer's panel through its HTML
 * contract, body only, because the React Panel always draws an h2 header band
 * and these pages' one heading is their h1 (the gap J62 named). The wrapper
 * puts the parts in Capsomer's teal family with Foxhound's neutrals (.fh-cap,
 * the pairing /connect and the site header use), so the button and its focus
 * ring are teal. The inner div carries Recova's 48px inset on top of the
 * panel's own, less the panel's: the padding is Recova's (RULES.md 5.1).
 */
export function AuthCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg">
      <div
        className="fh-cap w-full max-w-[400px] [--border-focus:var(--ring)]"
        data-family="teal"
        data-auth-card=""
      >
        <section className="cap-panel">
          <div className="cap-panel-body">
            <div className="px-8 py-9">{children}</div>
          </div>
        </section>
      </div>
    </div>
  );
}

/** Recova's centred h1 and the line under it. */
export function AuthHeading({ title, subtitle }: { title: string; subtitle?: ReactNode }) {
  return (
    <>
      <h1 className={`${subtitle ? "mb-2" : "mb-6"} text-center text-title font-semibold text-text`}>{title}</h1>
      {subtitle ? (
        <p className="mb-8 text-center text-label leading-relaxed text-text-subtle">{subtitle}</p>
      ) : null}
    </>
  );
}

/**
 * A labelled input, Capsomer's field through its HTML contract. The React
 * Field prints a "Required" marker beside a required control's label, which
 * Recova's pages do not have, so the contract is used directly, as /connect
 * does. `aside` sits at the label row's end (Recova's "Forgot password?").
 */
export function AuthField({
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
  type: "email" | "password";
  autoComplete: string;
  placeholder?: string;
  /** The id of the alert showing the form's error, when there is one: the
   *  input is then marked invalid and described by it (review round 1). */
  errorId?: string;
}) {
  const labelEl = (
    <label className="cap-field-label" htmlFor={id}>
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

/** The full-width primary button that submits the form (Recova's `w-full
 *  btn-primary`). A grid around it stretches it, as on /connect. */
export function AuthSubmit({ busy, label, busyLabel }: { busy: boolean; label: string; busyLabel: string }) {
  return (
    <div className="grid">
      <Button type="submit" variant="primary" size="lg" pending={busy}>
        {busy ? busyLabel : label}
      </Button>
    </div>
  );
}

/** A small text link, teal, underlined so it is not told apart by colour
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

/**
 * Recova's "Continue with Google" above the form, then its "or" rule. Posts
 * to Foxhound's own start route (/auth/google, Better Auth's signInSocial),
 * never a client-side provider call. Google's mark is a static file because
 * its four brand colours are Google's, not Foxhound tokens.
 *
 * `next` is the page to land on afterwards, when /login was given one (J79).
 */
export function GoogleContinue({ next }: { next?: string } = {}) {
  return (
    <>
      <Form method="post" action="/auth/google" className="mb-5 grid">
        {/* Where to land after Google (J79), validated again by the start
            route. Recova carried it in a pending_redirect cookie. */}
        {next ? <input type="hidden" name="next" value={next} /> : null}
        <Button type="submit" size="lg">
          <img src="/google-g.svg" alt="" width={16} height={16} />
          Continue with Google
        </Button>
      </Form>
      <div className="mb-5 flex items-center gap-3">
        <span className="h-px flex-1 bg-border" />
        <span className="font-mono text-micro text-text-subtle">or</span>
        <span className="h-px flex-1 bg-border" />
      </div>
    </>
  );
}
