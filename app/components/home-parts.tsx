// Pieces of the home page (routes/home.tsx split): product icons, arrows, the
// how-it-works steps and the billing answer.

import { ArrowRight, ArrowUpRight, RefreshCw, ScanSearch, Shield, TrendingUp } from "lucide-react";
import { Link } from "react-router";
import {
  BILLING_FAQ_PARTS,
  MATURITY_DAYS,
  RECOVERY_FEE,
  SEQUENCE_DAYS,
} from "~/lib/marketing/home-copy";

export const PRODUCT_ICONS = {
  audit: ScanSearch,
  recovery: RefreshCw,
  disputes: Shield,
  intelligence: TrendingUp,
} as const;

/** Recova's inline link inside a sentence, in the family's accent. */
const INLINE_LINK = "text-accent-text underline underline-offset-2 transition-opacity duration-150 hover:opacity-80";

export function Arrow() {
  return (
    <ArrowRight
      className="inline-block transition-transform duration-150 group-hover:translate-x-0.5"
      size={13}
      strokeWidth={1.5}
      aria-hidden
    />
  );
}

export function SourceArrow() {
  return (
    <ArrowUpRight
      className="inline-block transition-transform duration-150 group-hover:-translate-y-px group-hover:translate-x-px"
      size={12}
      strokeWidth={1.5}
      aria-hidden
    />
  );
}

export const HOW_IT_WORKS: { title: string; body: React.ReactNode }[] = [
  {
    title: "Connect Stripe",
    // Recova: "Read-only OAuth." The connection is read and write (ruling 20d),
    // so "Read-only" goes and Recova's OAuth link stays.
    body: (
      <>
        <a
          href="https://stripe.com/docs/connect/oauth-standard-accounts"
          target="_blank"
          rel="noopener noreferrer"
          className={INLINE_LINK}
        >
          OAuth
        </a>
        . 60 seconds. Foxhound never touches your billing configuration or existing Stripe setup.
      </>
    ),
  },
  {
    title: "Foxhound runs sequences",
    // Recova's sentence, with the engine's silent retry named where it runs
    // (ratified 2026-08-01). Recova's "timed to card network retry windows" is
    // left out: the engine times its steps by category, not by network window.
    body: (
      <>
        When a payment fails, Foxhound classifies the decline and starts a{" "}
        <Link to="/product/recovery" className={INLINE_LINK}>
          {SEQUENCE_DAYS}-day AI-written email sequence
        </Link>
        , with a silent retry ahead of the first email wherever the decline can be retried.
      </>
    ),
  },
  {
    title: `Pay ${RECOVERY_FEE} of matured recoveries`,
    body: (
      <>
        Monthly invoice for{" "}
        <Link to="/pricing" className={INLINE_LINK}>
          {RECOVERY_FEE} of the prior month&apos;s recoveries
        </Link>{" "}
        that have matured for {MATURITY_DAYS}+ days. Nothing owed on failed recoveries or Stripe&apos;s own
        baseline recoveries. No minimums, no setup fees.
      </>
    ),
  },
];

export const BILLING_ANSWER = (
  <>
    {BILLING_FAQ_PARTS.map((part) =>
      typeof part === "string" ? (
        part
      ) : (
        <Link key={part.to} to={part.to} className={INLINE_LINK}>
          {part.label}
        </Link>
      ),
    )}
  </>
);
