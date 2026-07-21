import { Form, Link } from "react-router";

import { Wordmark } from "./wordmark";

// Shared building blocks for the auth screens (login, signup, forgot/reset
// password). Two-panel redesign (task Part 3: brand/value left panel, form
// right, "matches the old system's polish"), still inside the marketing
// layout's shared header/footer (DESIGN.md: "no visual seam at login").
// Styling uses DESIGN.md token utilities only; no inline styles, including
// for the brand panel's gradient (the [background-image:var(...)]
// arbitrary-property syntax reads the token without an inline style attribute).

const VALUE_POINTS = [
  "Pay only on the payments Foxhound actually recovers.",
  "Every dispute is reviewed and signed by you before it submits.",
  "Free MRR analytics from day one, no card required.",
];

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <main className="mx-auto my-8 grid w-full max-w-5xl grid-cols-1 overflow-hidden rounded-lg border border-border md:my-16 md:grid-cols-2">
      <div className="hidden flex-col justify-between gap-10 bg-chrome p-10 md:flex [background-image:var(--gradient-brand-violet)] [background-blend-mode:overlay]">
        <Wordmark tone="chrome" />
        <div className="flex flex-col gap-4">
          <p className="text-title font-medium text-chrome-text">
            Outcome-based recovery for Stripe merchants.
          </p>
          <ul className="flex flex-col gap-3">
            {VALUE_POINTS.map((point) => (
              <li key={point} className="text-label text-chrome-text-secondary">
                {point}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="flex flex-col gap-6 bg-surface p-8 sm:p-10">
        <div className="flex flex-col gap-1">
          <h1 className="text-title font-medium text-text">{title}</h1>
          {subtitle ? (
            <p className="text-label text-text-tertiary">{subtitle}</p>
          ) : null}
        </div>
        {children}
        {footer ? (
          <p className="text-label text-text-tertiary">{footer}</p>
        ) : null}
      </div>
    </main>
  );
}

export function Field({
  label,
  name,
  type = "text",
  autoComplete,
  required = true,
  defaultValue,
  disabled,
}: {
  label: string;
  name: string;
  type?: string;
  autoComplete?: string;
  required?: boolean;
  defaultValue?: string;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
        {label}
      </span>
      <input
        className="rounded-md border border-border bg-surface px-3 py-2 text-body text-text placeholder:text-text-subtle focus-visible:border-amber disabled:text-text-tertiary disabled:opacity-70"
        name={name}
        type={type}
        autoComplete={autoComplete}
        required={required}
        defaultValue={defaultValue}
        disabled={disabled}
      />
    </label>
  );
}

export function Submit({
  children,
  disabled,
}: {
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="submit"
      disabled={disabled}
      className="rounded-md bg-amber px-4 py-2 text-body font-medium text-on-amber disabled:opacity-60"
    >
      {children}
    </button>
  );
}

export function Alert({
  tone,
  children,
}: {
  tone: "error" | "success";
  children: React.ReactNode;
}) {
  const cls =
    tone === "error"
      ? "border-red bg-red-bg text-error-text"
      : "border-green bg-green-bg text-success-text";
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={`rounded-md border px-3 py-2 text-label ${cls}`}
    >
      {children}
    </p>
  );
}

// "Continue with Google" -> posts to the /auth/google start route. Rendered only
// when the server reports the provider is configured (googleEnabled loader flag),
// so the Google path is invisible rather than broken when no client is set.
export function GoogleButton({ label }: { label: string }) {
  return (
    <>
      <div className="flex items-center gap-3 text-micro text-text-subtle">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>
      <Form method="post" action="/auth/google">
        <button
          type="submit"
          className="w-full rounded-md border border-border bg-surface px-4 py-2 text-body text-text hover:border-border-i"
        >
          {label}
        </button>
      </Form>
    </>
  );
}

export function AuthLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link to={to} className="text-amber-text underline-offset-2 hover:underline">
      {children}
    </Link>
  );
}
