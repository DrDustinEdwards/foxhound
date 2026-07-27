import { ArrowRight, ArrowUpRight, RefreshCw, ScanSearch, Shield, TrendingUp } from "lucide-react";
import { Link } from "react-router";

import { BlogPostCard } from "~/components/blog/blog-post-card";
import { EmailSamples } from "~/components/email-samples";
import { FadeUp } from "~/components/fade-up";
import { FaqAccordion } from "~/components/faq-accordion";
import { LedgerMock } from "~/components/ledger-mock";
import { RecoveryCalculator } from "~/components/recovery-calculator";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { listPublishedPosts } from "~/lib/blog/queries.server";
import { PRODUCTS } from "~/lib/marketing/products";
import { faqPageJsonLd, organizationJsonLd, siteUrl, softwareApplicationJsonLd, speakableWebPageJsonLd, websiteJsonLd } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/home";

// Marketing home page (Phase 6 Pass 1). Ported from legacy
// app/(marketing)/page.tsx: structure kept (hero, stats, Stripe+Foxhound
// comparison, full-bleed statement, how it works, calculator, products
// grid, email samples, FAQ, trust bar, from the blog, closing CTA, JSON-LD),
// copy rewritten per the 10 corrections in TASK-foxhound-phase6.md. The
// "from the blog" strip (TASK-foxhound-parity-cluster-b.md fix 1) restores
// legacy's exact position, between the trust bar and the closing CTA
// (confirmed live on recova-eta.vercel.app: section index 10 of 12, right
// after the trust-badge row, right before the final CTA).

export function meta({ loaderData }: Route.MetaArgs) {
  return marketingMeta({
    title: "Foxhound: recover failed Stripe payments, pay only when it works",
    description:
      "Silent retries first, then AI-drafted recovery sequences. 20% of what Foxhound recovers. Anything Stripe would have gotten anyway is free. Nothing billed until you've held the money 30 days.",
    path: "/",
    siteUrl: loaderData?.siteUrl ?? "",
  });
}

// Env access only (no session read), same pattern as the auth loaders, so
// the JSON-LD block below can derive every absolute URL from siteUrl(env)
// per the SITE_URL discipline instead of a hardcoded domain.
export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const latestPosts = await listPublishedPosts(db, 3);
  return { siteUrl: siteUrl(env), latestPosts };
}

interface ComparisonRow {
  stripeTitle: string;
  stripeBody: string;
  foxhoundTitle: string;
  foxhoundBody: string;
  foxhoundHref: string;
}

const COMPARISON_ROWS: ComparisonRow[] = [
  {
    stripeTitle: "Automatic Smart Retries",
    stripeBody:
      "Fixed retry schedule. No customer communication. No logic for why the payment failed, soft decline, expired card, and fraud all treated the same.",
    foxhoundTitle: "Silent retries, then intelligent sequences",
    foxhoundBody:
      "A quiet retry runs before any customer ever sees an email, so we never dun someone for a payment we could have recovered without bothering them. Declines are classified soft, network, expired, or fraud, each handled differently across 30 days.",
    foxhoundHref: "/products/recovery",
  },
  {
    stripeTitle: "Dispute notifications",
    stripeBody:
      "Stripe emails you when a dispute opens and shows a deadline. Evidence, response writing, and submission are all manual.",
    foxhoundTitle: "Evidence drafted, you review and sign",
    foxhoundBody:
      "Evidence is drafted from your recovery history, Stripe signals, and transaction data. You review it and sign every submission yourself, there is no auto-submit toggle. 20% only when you win, capped at $500.",
    foxhoundHref: "/products/disputes",
  },
];

const FAQS: { question: string; answer: string; node?: React.ReactNode }[] = [
  {
    question: "Does Foxhound touch my Stripe billing configuration?",
    answer:
      "No. The connection carries read and write scope, because retrying a failed invoice is a write, but Foxhound writes in only three places: retrying an invoice that has already failed, setting a customer default payment method after that customer updates their card, and submitting dispute evidence you approved. It never changes your prices, products, subscription plans, or any other Stripe setting, and never reaches your payouts.",
  },
  {
    question: "What counts as a recovery Foxhound can bill for?",
    answer:
      "Only recoveries where a Foxhound action provably preceded payment: a scheduled retry succeeded, a dunning email was clicked or otherwise engaged (not just opened), or a card was updated through a Foxhound page. Anything Stripe recovers on its own is recorded and shown to you as free, never billed.",
  },
  {
    question: "How does billing timing work?",
    answer:
      "Each monthly run bills the prior month's matured recoveries, meaning recoveries you've held for 30 or more days, at 20%. Disputes are 20% of wins only, capped at $500 per dispute. Intelligence's predictive layer is $199 per month flat. Audit is always free.",
    node: (
      <>
        Each monthly run bills the prior month&apos;s matured recoveries, meaning recoveries you&apos;ve
        held for 30 or more days, at{" "}
        <Link
          to="/products/recovery"
          className="text-text-secondary underline underline-offset-2 hover:text-amber-text"
        >
          20%
        </Link>
        .{" "}
        <Link
          to="/products/disputes"
          className="text-text-secondary underline underline-offset-2 hover:text-amber-text"
        >
          Disputes
        </Link>{" "}
        are 20% of wins only, capped at $500 per dispute.{" "}
        <Link
          to="/products/intelligence"
          className="text-text-secondary underline underline-offset-2 hover:text-amber-text"
        >
          Intelligence
        </Link>
        &apos;s predictive layer is $199 per month flat.{" "}
        <Link
          to="/products/audit"
          className="text-text-secondary underline underline-offset-2 hover:text-amber-text"
        >
          Audit
        </Link>{" "}
        is always free.
      </>
    ),
  },
  {
    question: "Can I see what the emails look like before they send?",
    answer:
      "Yes. Every generated email is visible in your dashboard before and after it sends, with open and click tracking. You can customize your brand voice, or write your own subject lines.",
  },
  {
    question: "Can I cancel or pause anytime?",
    answer:
      "Yes. Disconnect Stripe from your settings page and every active sequence stops immediately. No contracts, no minimum commitments. You're billed only for recoveries that already happened and have matured.",
  },
];

// One Stripe account per Foxhound account: there is no account switcher and no
// membership UI (app/lib/auth/account.ts, layouts/app-shell.tsx). "Multi-account"
// sat in this list as a compatibility claim for something that does not exist.
const COMPAT_TAGS = ["Stripe Billing", "Stripe Checkout", "Custom invoices", "Stripe Subscriptions"];

const PRODUCT_ICONS = {
  audit: ScanSearch,
  recovery: RefreshCw,
  disputes: Shield,
  intelligence: TrendingUp,
} as const;

export default function Home({ loaderData }: Route.ComponentProps) {
  const { siteUrl: url, latestPosts } = loaderData;

  return (
    <div>
      {/* 1. Hero */}
      <section className="speakable-hero border-b border-border-sub px-4 pb-16 pt-10 sm:px-8 sm:pb-20 sm:pt-14">
        <div className="mx-auto max-w-5xl">
          <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-2 lg:gap-16">
            <div className="flex flex-col">
              <h1 className="m-0 mb-5 text-4xl font-semibold leading-[1.05] tracking-tight text-text sm:text-5xl">
                You pay when
                <br />
                Foxhound recovers.
                <br />
                Not before.
              </h1>

              <p className="m-0 mb-8 text-body leading-relaxed text-text-secondary">
                Recovery is <span className="font-mono text-text">20%</span> of what Foxhound recovers.
                Anything Stripe would have recovered on its own is free, always. And nothing is billed
                until you have held the money for <span className="font-mono text-text">30</span> days.
              </p>

              <div className="flex flex-wrap items-center gap-4">
                <Link
                  to="/audit"
                  className="inline-flex items-center gap-1.5 rounded-md bg-amber px-5 py-2.5 text-label font-semibold text-on-amber hover:bg-amber-dark"
                >
                  Run your free audit
                </Link>
                <Link
                  to="/demos"
                  className="group inline-flex items-center gap-1.5 rounded-md border border-border-i px-5 py-2.5 text-label font-medium text-text-secondary hover:text-text"
                >
                  See it live
                  <ArrowRight
                    className="transition-transform duration-150 group-hover:translate-x-0.5"
                    size={13}
                    strokeWidth={1.5}
                    aria-hidden
                  />
                </Link>
              </div>
            </div>

            {/* min-h, not h: the mock sizes to its own content. A fixed height
                clipped it, because the detail lines wrap to two lines each at
                narrow widths and the card hides its own overflow. */}
            <div className="min-h-[360px] w-full">
              <LedgerMock />
            </div>
          </div>

          {/* Trust row */}
          <div className="mt-8 border-t border-border-sub pt-4">
            <ul className="m-0 flex list-none flex-wrap items-center justify-center gap-x-5 gap-y-2 p-0">
              <li className="flex items-center gap-3">
                <a
                  href="https://stripe.com/connect"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-micro text-purple no-underline hover:opacity-80"
                >
                  Built on Stripe Connect
                </a>
                <span aria-hidden="true" className="text-border-sub">&middot;</span>
              </li>
              {["Baseline recoveries are free", "No fee until 30-day maturity", "Disconnect anytime"].map(
                (label, i, arr) => (
                  <li key={label} className="flex items-center gap-3">
                    <span className="font-mono text-micro text-text-subtle">{label}</span>
                    {i < arr.length - 1 ? (
                      <span aria-hidden="true" className="text-border-sub">&middot;</span>
                    ) : null}
                  </li>
                ),
              )}
            </ul>
          </div>
        </div>
      </section>

      {/* Stats: the problem */}
      <section className="border-t border-border-sub bg-surface px-4 py-20 sm:px-8">
        <div className="mx-auto max-w-5xl">
          <FadeUp>
            <div className="mb-12 text-center">
              <h2 className="m-0 mb-3 text-2xl font-semibold tracking-tight text-text sm:text-3xl">
                The revenue you&apos;re losing isn&apos;t showing up as churn.
              </h2>
              <p className="m-0 text-body text-text-secondary">
                Stripe&apos;s own data on failed payments and what happens next.
              </p>
            </div>
          </FadeUp>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {[
              {
                stat: "56%",
                body: "of failed recurring payments are recovered by Stripe's own tools on average. The other 44% doesn't come back without additional sequences.",
                source: "stripe.com/billing",
                href: "https://stripe.com/billing",
              },
              {
                stat: "1 in 4",
                body: "subscription cancellations are purely due to payment failures. These customers never chose to leave, their payment just failed.",
                source: "stripe.com/blog",
                href: "https://stripe.com/blog/how-we-built-it-smart-retries",
              },
              {
                stat: "7 months",
                body: "is how long recovered subscriptions continue on average. One recovered payment is not one month of revenue, it is most of a year.",
                source: "stripe.com/blog",
                href: "https://stripe.com/blog/how-we-built-it-smart-retries",
              },
            ].map((item, i) => (
              <FadeUp key={item.stat} delay={i * 100}>
                <div className="flex h-full flex-col rounded-lg border border-border bg-surface p-6">
                  <div className="mb-4 font-mono text-4xl font-semibold leading-none text-text">
                    {item.stat}
                  </div>
                  <p className="m-0 mb-4 flex-1 text-label leading-relaxed text-text-secondary">
                    {item.body}
                  </p>
                  <a
                    href={item.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group font-mono text-micro text-text-subtle no-underline hover:text-text-tertiary"
                  >
                    Source: {item.source}{" "}
                    <ArrowUpRight
                      className="inline-block transition-transform duration-150 group-hover:translate-x-px group-hover:-translate-y-px"
                      size={12}
                      strokeWidth={1.5}
                      aria-hidden
                    />
                  </a>
                </div>
              </FadeUp>
            ))}
          </div>
        </div>
      </section>

      {/* Stripe plus Foxhound */}
      <section className="border-t border-border-sub px-4 py-20 sm:px-8">
        <div className="mx-auto max-w-5xl">
          <FadeUp>
            <div className="mb-12 text-center">
              <h2 className="m-0 mb-3 text-2xl font-semibold tracking-tight text-text sm:text-3xl">
                Stripe plus Foxhound
              </h2>
              <p className="m-0 text-body text-text-secondary">What Stripe does, and what Foxhound adds on top.</p>
            </div>
          </FadeUp>
          <div className="flex flex-col gap-4">
            {COMPARISON_ROWS.map((row, i) => (
              <FadeUp key={row.stripeTitle} delay={i * 100} className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="rounded-lg border border-border bg-surface p-6">
                  <div className="mb-3 text-micro text-text-tertiary">Stripe does this</div>
                  <div className="mb-2 text-body font-medium text-text">{row.stripeTitle}</div>
                  <p className="m-0 text-label leading-relaxed text-text-secondary">{row.stripeBody}</p>
                </div>
                <Link
                  to={row.foxhoundHref}
                  className="group block rounded-lg border border-border bg-surface p-6 hover:border-border-i"
                >
                  <div className="mb-3 font-mono text-micro text-text-tertiary">Foxhound adds this</div>
                  <div className="mb-2 text-body font-semibold text-text">{row.foxhoundTitle}</div>
                  <p className="m-0 text-label leading-relaxed text-text-secondary">{row.foxhoundBody}</p>
                  <div className="mt-4 font-mono text-micro text-amber-text">
                    Learn more{" "}
                    <ArrowRight
                      className="inline-block transition-transform duration-150 group-hover:translate-x-0.5"
                      size={13}
                      strokeWidth={1.5}
                      aria-hidden
                    />
                  </div>
                </Link>
              </FadeUp>
            ))}
          </div>
        </div>
      </section>

      {/* Full-bleed statement */}
      <section className="border-t border-border-sub px-4 py-20 sm:px-8 sm:py-28">
        <div className="mx-auto max-w-5xl">
          <FadeUp>
            <p className="mb-6 text-center font-mono text-micro uppercase tracking-widest text-text-subtle">
              The gap Stripe leaves open
            </p>
            <h2 className="m-0 text-center text-4xl font-semibold leading-none tracking-tight text-text sm:text-6xl lg:text-7xl">
              <span className="font-mono">44%</span> of failed payments
              <br />
              <span className="text-amber-text">never come back.</span>
            </h2>
            <p className="mx-auto mt-8 max-w-xl text-center text-body text-text-secondary sm:text-lg">
              Stripe&apos;s Smart Retries recover 56% on average. The other 44% needs something Stripe
              doesn&apos;t do: silent retries first, personalized email sequences, decline classification,
              and 30 days of follow-through.
            </p>
            <div className="mt-8 flex justify-center">
              <a
                href="https://stripe.com/billing"
                target="_blank"
                rel="noopener noreferrer"
                className="group font-mono text-micro text-text-subtle no-underline hover:text-text-tertiary"
              >
                Source: stripe.com/billing{" "}
                <ArrowUpRight
                  className="inline-block transition-transform duration-150 group-hover:translate-x-px group-hover:-translate-y-px"
                  size={12}
                  strokeWidth={1.5}
                  aria-hidden
                />
              </a>
            </div>
          </FadeUp>
        </div>
      </section>

      {/* How it works */}
      <section className="speakable-how-it-works border-t border-border-sub px-4 py-16 sm:px-8">
        <div className="mx-auto max-w-5xl">
          <FadeUp>
            <div className="mb-12 text-center">
              <h2 className="m-0 mb-3 text-2xl font-semibold tracking-tight text-text sm:text-3xl">
                How it works
              </h2>
              <p className="m-0 text-body text-text-secondary">Live in an afternoon. No code, no setup fees.</p>
            </div>
          </FadeUp>
          <div className="grid grid-cols-1 overflow-hidden rounded-lg border border-border bg-surface md:grid-cols-3">
            {[
              {
                title: "Connect Stripe",
                body: "60 seconds. Foxhound never touches your billing configuration or existing Stripe setup.",
              },
              {
                title: "Foxhound retries quietly, then sends",
                body: "When a payment fails, Foxhound classifies the decline and tries a silent retry first. Only if that doesn't work does a 30-day AI-drafted email sequence begin.",
              },
              {
                title: "Pay 20% of matured recoveries",
                body: "Monthly invoice for 20% of the prior month's recoveries that have matured for 30+ days. Nothing owed on failed recoveries or Stripe's own baseline recoveries.",
              },
            ].map((s, i) => (
              <FadeUp
                key={s.title}
                delay={i * 100}
                className={`p-7 ${i < 2 ? "border-b border-border md:border-b-0 md:border-r" : ""}`}
              >
                <div className="mb-2 text-body font-medium text-text">{s.title}</div>
                <p className="m-0 text-label leading-relaxed text-text-secondary">{s.body}</p>
              </FadeUp>
            ))}
          </div>
        </div>
      </section>

      {/* Calculator */}
      <section className="border-t border-border-sub bg-surface px-4 py-20 sm:px-8">
        <div className="mx-auto max-w-5xl">
          <FadeUp>
            <div className="mb-10 text-center">
              <h2 className="m-0 mb-3 text-2xl font-semibold tracking-tight text-text sm:text-3xl">
                How much are you leaving on the table?
              </h2>
              <p className="mx-auto m-0 max-w-md text-body text-text-secondary">
                Adjust your MRR and see the estimate. Foxhound takes{" "}
                <span className="font-mono">20%</span> of what it recovers. Nothing if it recovers nothing.
              </p>
            </div>
          </FadeUp>
          <div className="mx-auto max-w-xl">
            <RecoveryCalculator />
          </div>
        </div>
      </section>

      {/* Products */}
      <section id="products" className="scroll-mt-16 border-t border-border-sub px-4 py-20 sm:px-8">
        <div className="mx-auto max-w-5xl">
          <FadeUp>
            <div className="mb-12 text-center">
              <h2 className="m-0 mb-3 text-2xl font-semibold tracking-tight text-text sm:text-3xl">
                Start with recovery.
              </h2>
              <p className="m-0 text-body text-text-secondary">Add the rest when you need it.</p>
            </div>
          </FadeUp>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Object.values(PRODUCTS).map((p, i) => {
              const Icon = PRODUCT_ICONS[p.key];
              return (
                <FadeUp key={p.key} delay={i * 80}>
                  <Link
                    to={p.href}
                    className="block h-full rounded-lg border border-border bg-surface p-6 hover:border-border-i"
                  >
                    <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-surface2">
                      <Icon className="h-[18px] w-[18px] text-text-secondary" strokeWidth={1.8} aria-hidden />
                    </div>
                    <div className="mb-1.5 text-body font-medium text-text">{p.name}</div>
                    <p className="m-0 mb-4 text-label leading-relaxed text-text-secondary">{p.description}</p>
                    <div className="font-mono text-label text-amber-text">{p.price}</div>
                  </Link>
                </FadeUp>
              );
            })}
          </div>
        </div>
      </section>

      {/* Email samples */}
      <section className="border-t border-border-sub px-4 py-20 sm:px-8">
        <div className="mx-auto max-w-5xl">
          <FadeUp>
            <div className="mb-10 text-center">
              <h2 className="m-0 mb-3 text-2xl font-semibold tracking-tight text-text sm:text-3xl">
                What a Foxhound recovery email looks like
              </h2>
              <p className="mx-auto m-0 max-w-md text-body text-text-secondary">
                Pick a decline type and generate a real one. Every account customizes its own brand voice.
              </p>
            </div>
          </FadeUp>
          <div className="mx-auto max-w-xl">
            <EmailSamples />
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="speakable-faq border-t border-border-sub px-4 py-16 sm:px-8">
        <div className="mx-auto max-w-2xl">
          <FadeUp>
            <div className="mb-12 text-center">
              <h2 className="m-0 mb-3 text-2xl font-semibold tracking-tight text-text sm:text-3xl">
                Common questions
              </h2>
            </div>
          </FadeUp>
          <FaqAccordion faqs={FAQS.map((f) => ({ question: f.question, answer: f.node ?? f.answer }))} />
        </div>
      </section>

      {/* Security trust bar */}
      <section className="border-t border-border-sub px-4 py-10 sm:px-8">
        <div className="mx-auto max-w-5xl">
          <FadeUp>
            <div className="flex flex-wrap items-center justify-center gap-3">
              {[
                "Never touches your billing configuration",
                "No card data stored",
                "AES-256 encryption",
                "CAN-SPAM compliant",
                "US company, US jurisdiction",
              ].map((label) => (
                <div
                  key={label}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 font-mono text-micro text-text-tertiary"
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 12 12"
                    fill="none"
                    aria-hidden="true"
                    className="text-green"
                  >
                    <path
                      d="M2 6l2.5 2.5L10 3.5"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  {label}
                </div>
              ))}
            </div>
          </FadeUp>
        </div>
      </section>

      {/* From the blog (legacy home section 10 of 12: right after the trust
          bar, right before the closing CTA - confirmed live on
          recova-eta.vercel.app before building this). Trimmed-column query
          (listPublishedPosts, same as the perf remediation and the blog
          index's own sections), never the full-body select. */}
      {latestPosts.length > 0 ? (
        <section className="border-t border-border-sub bg-surface px-4 py-16 sm:px-8">
          <div className="mx-auto max-w-5xl">
            <FadeUp>
              <div className="mb-8 flex items-center justify-between">
                <p className="m-0 font-mono text-micro uppercase tracking-wide text-text-tertiary">
                  From the blog
                </p>
                <Link to="/blog" className="group text-label text-text-secondary hover:text-text">
                  All articles{" "}
                  <ArrowRight
                    className="inline-block transition-transform duration-150 group-hover:translate-x-0.5"
                    size={13}
                    strokeWidth={1.5}
                    aria-hidden
                  />
                </Link>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                {latestPosts.map((post) => (
                  <BlogPostCard key={post.slug} post={post} />
                ))}
              </div>
            </FadeUp>
          </div>
        </section>
      ) : null}

      {/* Closing CTA */}
      <section className="border-t border-border-sub px-4 py-20 sm:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="m-0 mb-4 text-2xl font-semibold tracking-tight text-text sm:text-3xl">
            See what your Stripe account is leaking
          </h2>
          <p className="mx-auto m-0 mb-7 max-w-lg text-body leading-relaxed text-text-secondary">
            Connect Stripe for a free diagnostic. Results in <span className="font-mono">30</span> seconds.
            No setup, no card.
          </p>
          <Link
            to="/audit"
            className="inline-flex items-center gap-2 rounded-md bg-amber px-6 py-3 text-body font-semibold text-on-amber hover:bg-amber-dark"
          >
            Connect Stripe, it&apos;s free
          </Link>
          <div className="mt-5 font-mono text-micro text-text-subtle">
            No account required &middot; Results in 30 seconds &middot; Disconnect anytime
          </div>
          <div className="mt-2 font-mono text-micro text-text-subtle">{COMPAT_TAGS.join(" · ")}</div>
          <div className="mt-8 flex flex-wrap justify-center gap-4 border-t border-border-sub pt-6">
            <Link to="/demos/recovery" className="group text-label text-text-secondary hover:text-text">
              View Recovery demo{" "}
              <ArrowRight
                className="inline-block transition-transform duration-150 group-hover:translate-x-0.5"
                size={13}
                strokeWidth={1.5}
                aria-hidden
              />
            </Link>
            <Link to="/demos/disputes" className="group text-label text-text-secondary hover:text-text">
              View Disputes demo{" "}
              <ArrowRight
                className="inline-block transition-transform duration-150 group-hover:translate-x-0.5"
                size={13}
                strokeWidth={1.5}
                aria-hidden
              />
            </Link>
            <Link to="/demos" className="group text-label text-text-secondary hover:text-text">
              View live demos{" "}
              <ArrowRight
                className="inline-block transition-transform duration-150 group-hover:translate-x-0.5"
                size={13}
                strokeWidth={1.5}
                aria-hidden
              />
            </Link>
            <Link to="/products" className="group text-label text-text-secondary hover:text-text">
              See all products{" "}
              <ArrowRight
                className="inline-block transition-transform duration-150 group-hover:translate-x-0.5"
                size={13}
                strokeWidth={1.5}
                aria-hidden
              />
            </Link>
          </div>
        </div>
      </section>

      {/* JSON-LD, derived entirely from app/lib/seo/jsonld.ts + the loader's siteUrl */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify([
            organizationJsonLd(url),
            softwareApplicationJsonLd(url),
            faqPageJsonLd(FAQS.map((f) => ({ question: f.question, answer: f.answer }))),
            speakableWebPageJsonLd(url, {
              name: "Foxhound: recover failed Stripe payments, pay only when it works",
              path: "/",
              selectors: [".speakable-hero", ".speakable-how-it-works", ".speakable-faq"],
            }),
            websiteJsonLd(url),
          ]),
        }}
      />
    </div>
  );
}
