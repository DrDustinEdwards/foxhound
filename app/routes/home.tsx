import { jsonLdText } from "@drdustinedwards/site-helpers/xml";
import "capsomer/panel.css";
import "capsomer/button.css";
import "capsomer/disclosure.css";
// Capsomer's tokens and the amber family (capbase layer), which every part on
// this page reads. The site header loads the same file; importing it here
// keeps the page whole under any layout.
import "~/site-header.css";
import { ArrowRight } from "lucide-react";
import { Link } from "react-router";
import { EmailSamples } from "~/components/email-samples";
import { FadeUp } from "~/components/fade-up";
import { CARD, CTA_BUTTON } from "~/components/marketing-card";
import { RecoveryQueueDemo } from "~/components/recovery-queue-demo";
import { RecoveryCalculator } from "~/components/recovery-calculator";
import { getDb } from "~/db";
import { getFeaturedPost, listPublishedPosts } from "~/lib/blog/queries.server";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { blogStripCards } from "~/lib/marketing/blog-strip";
import {
  citation,
  COMPARISON_ROWS,
  COMPAT_TAGS,
  FAQS,
  HERO_LEAD,
  HOME_META_DESCRIPTION,
  HOME_TITLE,
  HOME_WEBPAGE_NAME,
  MATURITY_DAYS,
  PRODUCT_CARDS,
  RECOVERY_FEE,
  SECURITY_CHIPS,
  STATEMENT_BODY,
  STATS,
  STRIPE_GAP,
  TRUST_ITEMS,
} from "~/lib/marketing/home-copy";
import { PRODUCT_ORDER, PRODUCTS } from "~/lib/marketing/products";
import { STAT_AS_OF, STAT_SOURCES } from "~/lib/marketing/statistics";
import {
  faqPageJsonLd,
  organizationJsonLd,
  siteUrl,
  softwareApplicationJsonLd,
  speakableWebPageJsonLd,
  websiteJsonLd,
} from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";
import type { Route } from "./+types/home";
import {
  PRODUCT_ICONS,
  Arrow,
  SourceArrow,
  HOW_IT_WORKS,
  BILLING_ANSWER,
} from "../components/home-parts";

// The marketing home page (J59, row M3). Recova's spec, read whole at HEAD:
// app/(marketing)/page.tsx (blob c10db7d5), components/hero/RecoveryDemo.tsx
// (453261b6), components/marketing/EmailGenerator.tsx (c4592a56),
// components/marketing/RecoveryCalculator.tsx (1a4374f5),
// components/FaqAccordion.tsx (b5f1e487) and components/FadeUp.tsx (cdcfc8cb).
//
// Recova's sections, in Recova's order, at Recova's widths and padding (1100px
// sections, 760px FAQ and closing block, 600px calculator and generator,
// px-5 sm:px-8, py-24 on the stats, calculator and closing block).
//
// Look is Capsomer's (RULES.md 1.1, Q12) with Recova's sizes (Dustin,
// 2026-10-25: "there is still so much wrong with foxhound... as compared to
// recova"): cards are Capsomer panels, linked ones lifting 4px with an amber
// edge under the pointer (the foxhound site layer), calls to action Capsomer
// buttons, the FAQ Capsomer's card disclosure, the decline picker its cards
// layout. Text takes Recova's size for each role from the marketing scale in
// app.css, and cards Recova's 24px padding (CARD).
//
// Copy, and every number in it read from the engine, is in
// lib/marketing/home-copy.ts.

const H2 = "m-0 mb-3 text-section font-semibold tracking-[-0.02em] text-text sm:text-section-lg";

export function meta({ loaderData }: Route.MetaArgs) {
  return marketingMeta({
    title: HOME_TITLE,
    description: HOME_META_DESCRIPTION,
    path: "/",
    siteUrl: loaderData?.siteUrl ?? "",
  });
}

// Recova's blog strip: the featured post first, then the two most recent that
// are not it, or the three most recent when nothing is featured (M3 divergence
// 34). Trimmed-column queries, never the full-body select.
export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  // The blog strip is the page's only database read. A D1 error drops the
  // strip (it renders nothing when empty), never the whole home page.
  let blogPosts: Awaited<ReturnType<typeof listPublishedPosts>> = [];
  try {
    const db = getDb(env);
    const [featured, latest] = await Promise.all([getFeaturedPost(db), listPublishedPosts(db, 5)]);
    blogPosts = blogStripCards(featured, latest);
  } catch (err) {
    console.error("home blog strip read failed", err);
  }
  return { siteUrl: siteUrl(env), blogPosts };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { siteUrl: url, blogPosts } = loaderData;

  return (
    // Capsomer's amber family with Foxhound's neutrals. Foxhound's global focus
    // ring reads --border-focus (app.css); inside this page it reads the
    // family's --ring, so a keyboard user sees amber as in Capsomer's own parts.
    <div className="fh-cap [--border-focus:var(--ring)]" data-cap-site="foxhound" data-family="amber">
      {/* 1. Hero */}
      <section className="speakable-hero border-b border-border-sub px-5 pb-16 pt-8 sm:px-8 sm:pb-20 sm:pt-10">
        <div className="mx-auto max-w-[1100px]">
          <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-2 lg:gap-16">
            <div className="flex flex-col">
              <h1 className="animate-fade-up delay-80 m-0 mb-5 text-hero font-semibold leading-[1.02] tracking-[-0.03em] text-text sm:text-hero-lg sm:tracking-[-0.04em]">
                You pay when
                <br />
                you recover.
                <br />
                <span className="text-accent-text">Not before.</span>
              </h1>

              <p className="animate-fade-up delay-160 m-0 mb-8 text-body leading-[1.6] text-text-secondary">
                {HERO_LEAD} <span className="font-mono text-text">{RECOVERY_FEE}</span> of what Foxhound
                recovers. Anything Stripe would have recovered on its own is free. Nothing until you have held
                the money for <span className="font-mono text-text">{MATURITY_DAYS}</span> days.
              </p>

              <div className="animate-fade-up delay-240 flex flex-wrap items-center gap-4" data-density="comfortable">
                <Link to="/audit" className="cap-btn font-semibold" data-variant="primary" data-size="lg">
                  Run your free audit
                </Link>
                {/* Recova's outlined button: no fill at rest, amber sweeping in under the pointer. */}
                <Link to="/demos/recovery" className="cap-btn group [--cap-btn-bg:transparent]" data-size="lg">
                  See it live
                  <ArrowRight
                    data-icon="end"
                    className="transition-transform duration-150 group-hover:translate-x-0.5"
                    size={13}
                    strokeWidth={1.5}
                    aria-hidden
                  />
                </Link>
              </div>
            </div>

            <div className="animate-fade-in delay-320 flex items-center justify-center">
              <RecoveryQueueDemo />
            </div>
          </div>

          {/* Trust row: full width, below both columns. */}
          <div className="mt-5 border-t border-border-sub pt-4">
            <ul className="m-0 flex list-none flex-wrap items-center justify-center gap-x-5 gap-y-2 p-0">
              <li className="flex items-center gap-3">
                {/* leading-6 keeps the link a 24px target. */}
                <a
                  href="https://stripe.com/connect"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-caption leading-6 text-cobalt-text no-underline transition-opacity duration-150 hover:opacity-80"
                >
                  Built on Stripe Connect
                </a>
                <span aria-hidden="true" className="text-border-sub">
                  &middot;
                </span>
              </li>
              {TRUST_ITEMS.map((label, i, arr) => (
                <li key={label} className="flex items-center gap-3">
                  <span className="font-mono text-caption text-text-subtle">{label}</span>
                  {i < arr.length - 1 ? (
                    <span aria-hidden="true" className="text-border-sub">
                      &middot;
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* Stats: the problem */}
      <section className="border-t border-border-sub bg-surface px-5 py-24 sm:px-8">
        <div className="mx-auto max-w-[1100px]">
          <FadeUp>
            <div className="mb-12 text-center">
              <h2 className={H2}>
                The revenue you&apos;re losing isn&apos;t showing up as churn.
              </h2>
              <p className="m-0 text-subhead text-text-secondary">
                Stripe&apos;s own data on failed payments and what happens next.
              </p>
            </div>
          </FadeUp>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {STATS.map((item, i) => (
              <FadeUp key={item.stat} delay={i * 100} className="grid">
                <div className={CARD}>
                  <div className="cap-panel-body">
                    <div className="flex h-full flex-col">
                      <div className="mb-4 font-mono text-hero font-semibold leading-none text-accent-text">
                        {item.stat}
                      </div>
                      <p className="m-0 mb-4 flex-1 text-copy leading-[1.6] text-text-secondary">{item.body}</p>
                      {/* RULES.md 2.3: the exact page and the day it was read. */}
                      <a
                        href={item.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="group font-mono text-source leading-6 text-text-subtle no-underline transition-colors duration-150 hover:text-text-tertiary"
                      >
                        Source: {citation(item.href)}, read {STAT_AS_OF} <SourceArrow />
                      </a>
                    </div>
                  </div>
                </div>
              </FadeUp>
            ))}
          </div>
        </div>
      </section>

      {/* Stripe plus Foxhound */}
      <section className="border-t border-border-sub px-5 py-20 sm:px-8">
        <div className="mx-auto max-w-[1100px]">
          <FadeUp>
            <div className="mb-12 text-center">
              <h2 className={H2}>Stripe plus Foxhound</h2>
              <p className="m-0 text-subhead text-text-secondary">What Stripe does, and what Foxhound adds on top.</p>
            </div>
          </FadeUp>
          <div className="space-y-4">
            {COMPARISON_ROWS.map((row, i) => (
              <FadeUp key={row.stripeTitle} delay={i * 100} className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className={CARD}>
                  <div className="cap-panel-body">
                    <div>
                      <div className="mb-3 text-caption text-text-tertiary">Stripe does this</div>
                      <div className="mb-2 text-body font-medium text-text">{row.stripeTitle}</div>
                      <p className="m-0 text-copy leading-[1.55] text-text-secondary">{row.stripeBody}</p>
                    </div>
                  </div>
                </div>
                <Link to={row.foxhoundHref} className={`${CARD} group`}>
                  <div className="cap-panel-body">
                    <div>
                      <div className="mb-3 text-caption font-medium text-accent-text">Foxhound adds this</div>
                      <div className="mb-2 text-body font-semibold text-text">{row.foxhoundTitle}</div>
                      <p className="m-0 text-copy leading-[1.55] text-text-secondary">{row.foxhoundBody}</p>
                      <div className="mt-4 font-mono text-caption text-accent-text">
                        Learn more <Arrow />
                      </div>
                    </div>
                  </div>
                </Link>
              </FadeUp>
            ))}
          </div>
        </div>
      </section>

      {/* Full-bleed statement */}
      <section className="overflow-hidden border-t border-border-sub px-5 py-20 sm:px-8 sm:py-28">
        <div className="mx-auto max-w-[1100px]">
          <FadeUp>
            <p className="mb-6 text-center font-mono text-micro uppercase tracking-widest text-text-subtle">
              The gap Stripe leaves open
            </p>
            <h2 className="m-0 text-center text-statement font-semibold leading-[1.0] tracking-[-0.04em] text-text sm:text-statement-md lg:text-statement-lg">
              {STRIPE_GAP} of failed payments
              <br />
              <span className="text-accent-text">never come back.</span>
            </h2>
            <p className="mx-auto mt-8 max-w-[560px] text-center text-subhead leading-[1.6] text-text-secondary sm:text-product-sub">
              {STATEMENT_BODY}
            </p>
            <div className="mt-8 flex justify-center">
              <a
                href={STAT_SOURCES.stripeBilling}
                target="_blank"
                rel="noopener noreferrer"
                className="group font-mono text-source leading-6 text-text-subtle no-underline transition-colors duration-150 hover:text-text-tertiary"
              >
                Source: {citation(STAT_SOURCES.stripeBilling)}, read {STAT_AS_OF} <SourceArrow />
              </a>
            </div>
          </FadeUp>
        </div>
      </section>

      {/* How it works */}
      <section className="speakable-how-it-works border-t border-border-sub px-5 py-16 sm:px-8">
        <div className="mx-auto max-w-[1100px]">
          <FadeUp>
            <div className="mb-12 text-center">
              <h2 className={H2}>How it works</h2>
              <p className="m-0 text-subhead text-text-secondary">Live in an afternoon. No code, no setup fees.</p>
            </div>
          </FadeUp>
          {/* Recova's one bordered strip of three. Capsomer's panel, flush, holds it. */}
          <div className="cap-panel">
            <div className="cap-panel-body" data-flush>
              <div className="grid grid-cols-1 md:grid-cols-3">
                {HOW_IT_WORKS.map((s, i) => (
                  <FadeUp
                    key={s.title}
                    delay={i * 100}
                    className={`p-7 ${i < 2 ? "border-b border-border md:border-b-0 md:border-r" : ""}`}
                  >
                    <div className="mb-2 text-body font-medium text-text">{s.title}</div>
                    <p className="m-0 text-copy leading-[1.55] text-text-secondary">{s.body}</p>
                  </FadeUp>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Calculator */}
      <section className="border-t border-border-sub bg-surface px-5 py-24 sm:px-8">
        <div className="mx-auto max-w-[1100px]">
          <FadeUp>
            <div className="mb-10 text-center">
              <h2 className={H2}>
                How much are you leaving on the table?
              </h2>
              <p className="m-0 mx-auto max-w-[480px] text-subhead text-text-secondary">
                Adjust your MRR and see the estimated recovery. Foxhound takes{" "}
                <span className="font-mono">{RECOVERY_FEE}</span> of what it recovers. Nothing if it recovers
                nothing.
              </p>
            </div>
          </FadeUp>
          <div className="mx-auto max-w-[600px]">
            <RecoveryCalculator />
          </div>
        </div>
      </section>

      {/* Products. The id and Recova's 60px scroll margin sit on the section. */}
      <section id="products" className="scroll-mt-[60px] border-t border-border-sub px-5 py-20 sm:px-8">
        <div className="mx-auto max-w-[1100px]">
          <FadeUp>
            <div className="mb-12 text-center">
              <h2 className={H2}>Start with recovery.</h2>
              <p className="m-0 text-subhead text-text-secondary">Add the rest when you need it.</p>
            </div>
          </FadeUp>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {PRODUCT_ORDER.map((key, i) => {
              const Icon = PRODUCT_ICONS[key];
              const card = PRODUCT_CARDS[key];
              return (
                <FadeUp key={key} delay={i * 80} className="grid">
                  <Link to={PRODUCTS[key].href} className={CARD}>
                    <div className="cap-panel-body">
                      <div>
                        <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-surface2">
                          <Icon className="h-[18px] w-[18px] text-accent-text" strokeWidth={1.8} aria-hidden />
                        </div>
                        <div className="mb-1.5 text-body font-medium text-text">{PRODUCTS[key].name}</div>
                        <p className="m-0 mb-4 min-h-[60px] text-label leading-[1.55] text-text-secondary">
                          {card.description}
                        </p>
                        <div className="font-mono text-label text-accent-text">{card.price}</div>
                      </div>
                    </div>
                  </Link>
                </FadeUp>
              );
            })}
          </div>
        </div>
      </section>

      {/* Email generator */}
      <section className="border-t border-border-sub px-5 py-20 sm:px-8">
        <div className="mx-auto max-w-[1100px]">
          <FadeUp>
            <div className="mb-10 text-center">
              {/* Recova: "The actual email Recova would send" and "Same AI, same
                  prompts, same output as the product." The sample runs its own
                  prompt on its own model (MODEL_MARKETING_EMAIL_SAMPLE) for a
                  fictional customer, so neither claim holds here. */}
              <h2 className={H2}>
                What a Foxhound recovery email looks like
              </h2>
              <p className="m-0 mx-auto max-w-[480px] text-subhead text-text-secondary">
                Pick a decline type and generate a real recovery email. Every account customizes its own brand
                voice.
              </p>
            </div>
          </FadeUp>
          <div className="mx-auto max-w-[600px]">
            <EmailSamples />
          </div>
        </div>
      </section>

      {/* FAQ: Capsomer's disclosure, one open at a time as Recova's accordion
          is, each revealed in Recova's 60ms stagger (M3 divergence 15). */}
      <section className="speakable-faq border-t border-border-sub px-5 py-16 sm:px-8">
        <div className="mx-auto max-w-[760px]">
          <FadeUp>
            <div className="mb-12 text-center">
              <h2 className={H2}>Common questions</h2>
            </div>
          </FadeUp>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {FAQS.map((faq, i) => (
              <li key={faq.question}>
                <FadeUp delay={i * 60}>
                  <details className="cap-disclosure [--pad-card:1.5rem]" data-variant="card" name="home-faq">
                    <summary>{faq.question}</summary>
                    <div className="cap-disclosure-body">
                      <p className="m-0 text-copy leading-[1.6] text-text-secondary">
                        {i === 2 ? BILLING_ANSWER : faq.answer}
                      </p>
                    </div>
                  </details>
                </FadeUp>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Security trust bar */}
      <section className="border-t border-border-sub px-5 py-10 sm:px-8">
        <div className="mx-auto max-w-[1100px]">
          <FadeUp>
            <ul className="m-0 flex list-none flex-wrap items-center justify-center gap-3 p-0">
              {SECURITY_CHIPS.map((label) => (
                <li
                  key={label}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 font-mono text-micro text-text-tertiary"
                >
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="text-green">
                    <path
                      d="M2 6l2.5 2.5L10 3.5"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  {label}
                </li>
              ))}
            </ul>
          </FadeUp>
        </div>
      </section>

      {/* From the blog: featured first, then the two latest (legacy section 10
          of 12, between the trust bar and the closing block). Recova hand-rolls
          this card here rather than using its BlogPostCard (M3b): a tag, the
          title and the reading time, no excerpt. Each is a Capsomer panel. */}
      {blogPosts.length > 0 ? (
        <section className="border-t border-border-sub bg-surface px-5 py-16 sm:px-8">
          <div className="mx-auto max-w-[1100px]">
            <FadeUp>
              <div className="mb-8 flex items-center justify-between">
                <h2 className="m-0 text-copy font-normal text-text-secondary">From the blog</h2>
                <Link to="/blog" className="group text-caption leading-6 text-text-tertiary transition-colors hover:text-text">
                  All articles <Arrow />
                </Link>
              </div>
            </FadeUp>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {blogPosts.map((post, i) => (
                <FadeUp key={post.slug} delay={i * 80} className="grid">
                  {/* Recova's blog card: the page ground on the surface band, p-5, 10px corners. */}
                  <Link
                    to={`/blog/${post.slug}`}
                    className="cap-panel h-full rounded-[10px] [--gap:1.25rem] [--pad-card:1.25rem] [--surface:var(--bg)]"
                  >
                    <div className="cap-panel-body">
                      <div className="flex h-full flex-col gap-3">
                        {post.tags[0] ? (
                          <div className="font-mono text-micro text-text-tertiary">{post.tags[0].replace(/-/g, " ")}</div>
                        ) : null}
                        <h3 className="m-0 line-clamp-2 text-item-title font-medium leading-snug text-text">{post.title}</h3>
                        <span className="mt-auto font-mono text-micro text-text-tertiary">
                          {post.readingTimeMinutes} min read
                        </span>
                      </div>
                    </div>
                  </Link>
                </FadeUp>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {/* Closing CTA, with Recova's two demo links (M3 divergence 39). */}
      <section className="border-t border-border-sub px-5 py-24 sm:px-8">
        <div className="mx-auto max-w-[760px] text-center" data-density="comfortable">
          <h2 className="m-0 mb-4 text-section font-semibold tracking-[-0.02em] text-text sm:text-section-lg">
            See what your Stripe account is leaking
          </h2>
          <p className="m-0 mx-auto mb-7 max-w-[560px] text-subhead leading-[1.55] text-text-secondary">
            Connect Stripe for a free diagnostic. Results in <span className="font-mono">30</span> seconds. No
            setup, no card.
          </p>
          <Link to="/audit" className={CTA_BUTTON} data-variant="primary" data-size="lg">
            Connect Stripe, it is free
          </Link>
          <div className="mt-5 font-mono text-caption text-text-subtle">
            No account required &middot; Results in 30 seconds &middot; Disconnect anytime
          </div>
          <div className="mt-2 font-mono text-caption text-text-subtle">{COMPAT_TAGS.join(" · ")}</div>
          <div className="mt-8 flex flex-wrap justify-center gap-4 border-t border-border-sub pt-6">
            <Link to="/demos/recovery" className="group text-copy leading-6 text-text-secondary transition-colors hover:text-text">
              View Recovery demo <Arrow />
            </Link>
            <Link to="/demos/disputes" className="group text-copy leading-6 text-text-secondary transition-colors hover:text-text">
              View Disputes demo <Arrow />
            </Link>
          </div>
        </div>
      </section>

      {/* JSON-LD, as Recova emits it: Organization, SoftwareApplication, the
          FAQPage from the plain answers above, the Speakable WebPage and the
          WebSite. Every URL comes from the loader's siteUrl. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLdText([
            organizationJsonLd(url),
            softwareApplicationJsonLd(url),
            faqPageJsonLd(FAQS),
            speakableWebPageJsonLd(url, {
              name: HOME_WEBPAGE_NAME,
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
