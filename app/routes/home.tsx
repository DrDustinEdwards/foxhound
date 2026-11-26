import { marketingMeta } from "~/lib/seo/meta";
import { Icon, iconArrowRight } from "capsomer/react/icons";
import { publicPageHeaders } from "@dustinedwards/site-runtime/edge-cache";
import "capsomer/panel.css";
import "capsomer/status.css";
import "capsomer/button.css";
import "capsomer/disclosure.css";
import "capsomer/source-line.css";
// Capsomer's tokens and the amber family (capbase layer), which every part on this page reads. The site header loads the same file; importing it here keeps the page whole under any layout.
import "~/site-header.css";
import { jsonLd } from "@drdustinedwards/site-helpers/schema";
import { Link, ButtonLink } from "capsomer/react/link";
import { SourceLine } from "capsomer/react/source-line";
import { CtaBand } from "capsomer/react/cta-band";
import { Hero } from "capsomer/react/hero";
import "capsomer/cta-band.css";
import "capsomer/hero.css";
import { EmailSamples } from "~/components/email-samples";
import { CARD, ConnectStripeAction } from "~/components/marketing-card";
import { RecoveryQueueDemo } from "~/components/recovery-queue-demo";
import { RecoveryCalculator } from "~/components/recovery-calculator";
import { getDb } from "~/db";
import { getFeaturedPost, listLivePosts } from "~/lib/blog/queries.server";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { blogStripCards } from "~/lib/marketing/blog-strip";
import {
  citation,
  BILLING_FAQ_QUESTION,
  FAQS,
  HERO_LEAD,
  HOME_META_DESCRIPTION,
  HOME_TITLE,
  MATURITY_DAYS,
  PRODUCT_CARDS,
  RECOVERY_FEE,
  SECURITY_CHIPS,
  STATEMENT_BODY,
  STRIPE_GAP,
  TRUST_ITEMS,
} from "~/lib/marketing/home-copy";
import { PRODUCT_ORDER, PRODUCTS } from "~/lib/marketing/products";
import { STAT_AS_OF, STAT_SOURCES } from "~/lib/marketing/statistics";
import {
  organizationJsonLd,
  siteUrl,
  softwareApplicationJsonLd,
  speakableWebPageJsonLd,
  websiteJsonLd,
} from "~/lib/seo/jsonld";
import type { Route } from "./+types/home";
import {
  PRODUCT_ICONS,
  Arrow,
  HOW_IT_WORKS,
  BILLING_ANSWER,
  H2,
  HomeBlogStrip,
  HomeComparison,
  HomeStats,
} from "../components/home-parts";
import "~/home.css";

// The marketing home page, in order: the hero, the stats, the email generator, the calculator, the FAQ and the closing block (1100px sections, 760px FAQ and closing block, 600px calculator and generator, px-5 sm:px-8, py-24 on the stats, calculator and closing block). Cards are Capsomer panels, linked ones lifting 4px with an amber edge under the pointer (the foxhound site layer), calls to action Capsomer buttons, the FAQ Capsomer's card disclosure, the decline picker its cards layout. Text takes its size for each role from the marketing scale in app.css, and cards a 24px padding (CARD). Copy, and every number in it read from the engine, is in lib/marketing/home-copy.ts.

export function meta({ loaderData }: Route.MetaArgs) {
  // JSON-LD: Organization, SoftwareApplication, the Speakable WebPage and the WebSite. Every URL comes from the loader's siteUrl.
  const url = loaderData?.siteUrl ?? "";
  return [
    ...marketingMeta({
      title: HOME_TITLE,
      fullTitle: true,
      description: HOME_META_DESCRIPTION,
      path: "/",
      siteUrl: url,
    }),
    ...(loaderData
      ? [
          jsonLd(organizationJsonLd(url)),
          jsonLd(softwareApplicationJsonLd(url)),
          jsonLd(
            speakableWebPageJsonLd(url, {
              path: "/",
              selectors: [".speakable-hero", ".speakable-how-it-works", ".speakable-faq"],
            }),
          ),
          jsonLd(websiteJsonLd(url)),
        ]
      : []),
  ];
}

// The blog strip: the featured post first, then the two most recent that are not it, or the three most recent when nothing is featured. Trimmed-column queries, never the full-body select.
export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  // The blog strip is the page's only database read. A D1 error drops the
  // strip (it renders nothing when empty), never the whole home page.
  let blogPosts: Awaited<ReturnType<typeof listLivePosts>> = [];
  try {
    const db = getDb(env);
    const [featured, latest] = await Promise.all([getFeaturedPost(db), listLivePosts(db, 5)]);
    blogPosts = blogStripCards(featured, latest);
  } catch (err) {
    console.error("home blog strip read failed", err);
  }
  return { siteUrl: siteUrl(env), blogPosts };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { blogPosts } = loaderData;

  return (
    // Capsomer's amber family with Foxhound's neutrals.
    <div className="fh-cap" data-cap-site="foxhound" data-family="amber">
      {/* 1. Hero */}
      <div className="fh-home-band speakable-hero">
        <div className="fh-mk-wrap">
          <Hero
            className="fh-home-hero"
            title={
              <>
                You pay when
                <br />
                you recover.
                <br />
                <span className="fh-brand">Not before.</span>
              </>
            }
            lead={
              <>
                {HERO_LEAD} <span className="fh-mono fh-text">{RECOVERY_FEE}</span> of what Foxhound
                recovers. Anything Stripe would have recovered on its own is free. Nothing until you
                have held the money for <span className="fh-mono fh-text">{MATURITY_DAYS}</span>{" "}
                days.
              </>
            }
            actions={
              <div className="fh-density" data-density="comfortable">
                <ButtonLink to="/audit" className="fh-semibold" variant="primary" size="lg">
                  Run your free audit
                </ButtonLink>
                <ButtonLink
                  to="/demos/recovery"
                  rel="nofollow"
                  className="fh-home-link fh-hover-group"
                  size="lg"
                >
                  See it live
                  <Icon
                    d={iconArrowRight}
                    className="fh-icon-13 fh-icon-fine fh-home-block-2"
                    data-icon="end"
                  />
                </ButtonLink>
              </div>
            }
            aside={<RecoveryQueueDemo />}
          />

          {/* Trust row: full width, below both columns. */}
          <div className="fh-home-block-3">
            <ul className="fh-home-list">
              <li className="fh-home-item">
                {/* leading-6 keeps the link a 24px target. */}
                <a href="https://stripe.com/connect" className="fh-home-link-2 fh-mono fh-caption">
                  Built on Stripe Connect
                </a>
                <span aria-hidden="true" className="fh-home-label">
                  &middot;
                </span>
              </li>
              {TRUST_ITEMS.map((label, i, arr) => (
                <li key={label} className="fh-home-item">
                  <span className="fh-mono fh-caption fh-quiet">{label}</span>
                  {i < arr.length - 1 ? (
                    <span aria-hidden="true" className="fh-home-label">
                      &middot;
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/* Stats: the problem */}
      <HomeStats />

      {/* Stripe plus Foxhound */}
      <HomeComparison />

      {/* Full-bleed statement */}
      <section className="fh-home-band-3">
        <div className="fh-mk-wrap">
          <div className="cap-reveal">
            <h2 className="fh-home-title-2 fh-center fh-statement fh-semibold fh-text">
              {STRIPE_GAP} of failed payments
              <br />
              <span className="fh-brand">never come back.</span>
            </h2>
            <p className="fh-home-wrap fh-center fh-subhead fh-soft">{STATEMENT_BODY}</p>
            <div className="fh-home-row-2">
              <SourceLine
                href={STAT_SOURCES.stripeBilling}
                name={citation(STAT_SOURCES.stripeBilling)}
                read={STAT_AS_OF}
              />
            </div>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="fh-mk-band-short speakable-how-it-works">
        <div className="fh-mk-wrap">
          <div className="cap-reveal">
            <div className="fh-home-block-4 fh-center">
              <h2 className={H2}>How it works</h2>
            </div>
          </div>
          <div className="cap-panel">
            <div className="cap-panel-body" data-flush>
              <div className="fh-home-grid-5">
                {HOW_IT_WORKS.map((s, i) => (
                  <div
                    key={s.title}
                    className={`fh-home-block-10 cap-reveal ${i < 2 ? "fh-home-step-ruled" : ""}`}
                  >
                    <div className="fh-home-block-8 fh-body fh-medium fh-text">{s.title}</div>
                    <p className="fh-home-text-3 fh-copy fh-soft">{s.body}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Calculator */}
      <section className="fh-home-band-2">
        <div className="fh-mk-wrap">
          <div className="cap-reveal">
            <div className="fh-home-block-11 fh-center">
              <h2 className={H2}>How much are you leaving on the table?</h2>
              <p className="fh-mk-lede fh-subhead fh-soft">
                Foxhound takes <span className="fh-mono">{RECOVERY_FEE}</span> of what it recovers.
                Nothing if it recovers nothing.
              </p>
            </div>
          </div>
          <div className="fh-home-wrap-2">
            <RecoveryCalculator />
          </div>
        </div>
      </section>

      <section id="products" className="fh-home-band-4">
        <div className="fh-mk-wrap">
          <div className="cap-reveal">
            <div className="fh-home-block-4 fh-center">
              <h2 className={H2}>Start with recovery.</h2>
            </div>
          </div>
          <div className="fh-mk-cards-4">
            {PRODUCT_ORDER.map((key) => {
              const icon = PRODUCT_ICONS[key];
              const card = PRODUCT_CARDS[key];
              return (
                <div key={key} className="fh-home-grid-3 cap-reveal">
                  <Link to={PRODUCTS[key].href} className={CARD}>
                    <div className="cap-panel-body">
                      <div>
                        <div className="fh-mk-tile-icon">
                          <Icon d={icon} className="fh-icon-18 fh-icon-180 fh-brand" />
                        </div>
                        <div className="fh-home-block-12 fh-body fh-medium fh-text">
                          {PRODUCTS[key].name}
                        </div>
                        <p className="fh-home-text-5 fh-small fh-soft">{card.description}</p>
                        <div className="fh-mono fh-small fh-brand">{card.price}</div>
                      </div>
                    </div>
                  </Link>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Email generator */}
      <section className="fh-mk-band">
        <div className="fh-mk-wrap">
          <div className="cap-reveal">
            <div className="fh-home-block-11 fh-center">
              {/* Recova: "The actual email Recova would send" and "Same AI, same
                  prompts, same output as the product." The sample runs its own
                  prompt on its own model (MODEL_MARKETING_EMAIL_SAMPLE) for a
                  fictional customer, so neither claim holds here. */}
              <h2 className={H2}>What a Foxhound recovery email looks like</h2>
            </div>
          </div>
          <div className="fh-home-wrap-2">
            <EmailSamples />
          </div>
        </div>
      </section>

      <section className="fh-mk-band-short speakable-faq">
        <div className="fh-mk-wrap-text">
          <div className="cap-reveal">
            <div className="fh-home-block-4 fh-center">
              <h2 className={H2}>Common questions</h2>
            </div>
          </div>
          <ul className="cap-stack" data-gap="4">
            {FAQS.map((faq) => (
              <li key={faq.question}>
                <div className="cap-reveal">
                  <details
                    className="fh-home-block-13 cap-disclosure"
                    data-variant="card"
                    name="home-faq"
                  >
                    <summary>{faq.question}</summary>
                    <div className="cap-disclosure-body">
                      <p className="fh-home-text-6 fh-copy fh-soft">
                        {faq.question === BILLING_FAQ_QUESTION ? BILLING_ANSWER : faq.answer}
                      </p>
                    </div>
                  </details>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Security trust bar */}
      <section className="fh-home-band-5">
        <div className="fh-mk-wrap">
          <div className="cap-reveal">
            <ul className="fh-home-list-2">
              {SECURITY_CHIPS.map((label) => (
                <li
                  key={label}
                  className="cap-pill fh-mono fh-regular"
                  data-variant="outline"
                  data-tone="muted"
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 12 12"
                    fill="none"
                    aria-hidden="true"
                    className="fh-green"
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
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* From the blog: featured first, then the two latest (legacy section 10
          of 12, between the trust bar and the closing block). Recova hand-rolls
          this card here rather than using its BlogPostCard (M3b): a tag, the
          title and the reading time, no excerpt. Each is a Capsomer panel. */}
      <HomeBlogStrip blogPosts={blogPosts} />

      <CtaBand
        quiet
        className="fh-closing-band fh-closing-home"
        title="See what your Stripe account is leaking"
        actions={
          <>
            <ConnectStripeAction />
            <Link
              to="/demos/recovery"
              rel="nofollow"
              className="fh-mk-quiet-link fh-hover-group fh-copy fh-soft"
            >
              View Recovery demo <Arrow />
            </Link>
            <Link
              to="/demos/disputes"
              rel="nofollow"
              className="fh-mk-quiet-link fh-hover-group fh-copy fh-soft"
            >
              View Disputes demo <Arrow />
            </Link>
          </>
        }
      >
        Connect Stripe for a free diagnostic. Results in <span className="fh-mono">30</span>{" "}
        seconds. No setup, no card.
      </CtaBand>
    </div>
  );
}

export const headers = () => publicPageHeaders();
