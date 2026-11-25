// Pieces of the home page (routes/home.tsx split): product icons, arrows, the
// how-it-works steps and the billing answer.

import {
  Icon,
  iconArrowRight,
  iconRefresh,
  iconScanSearch,
  iconShield,
  iconTrendingUp,
} from "capsomer/react/icons";
import { Link } from "capsomer/react/link";
import { SourceLine } from "capsomer/react/source-line";
import { CARD } from "~/components/marketing-card";
import { STAT_AS_OF } from "~/lib/marketing/statistics";
import {
  BILLING_FAQ_PARTS,
  citation,
  COMPARISON_ROWS,
  STATS,
  MATURITY_DAYS,
  RECOVERY_FEE,
  SEQUENCE_DAYS,
} from "~/lib/marketing/home-copy";

export const PRODUCT_ICONS = {
  audit: iconScanSearch,
  recovery: iconRefresh,
  disputes: iconShield,
  intelligence: iconTrendingUp,
} as const;

export function Arrow() {
  return <Icon d={iconArrowRight} className="fh-icon-13 fh-icon-fine fh-mk-arrow" />;
}

export const HOW_IT_WORKS: { title: string; body: React.ReactNode }[] = [
  {
    title: "Connect Stripe",
    // The connection is read and write, so the copy says "OAuth", not "Read-only OAuth".
    body: (
      <>
        <a href="https://stripe.com/docs/connect/oauth-standard-accounts" rel="external">
          OAuth
        </a>
        . 60 seconds. Foxhound never touches your billing configuration or existing Stripe setup.
      </>
    ),
  },
  {
    title: "Foxhound runs sequences",
    // The engine's silent retry is named where it runs. No "timed to card network retry windows": the engine times its steps by category, not by network window.
    body: (
      <>
        When a payment fails, Foxhound classifies the decline and starts a{" "}
        <Link to="/product/recovery">{SEQUENCE_DAYS}-day AI-written email sequence</Link>, with a
        silent retry ahead of the first email wherever the decline can be retried.
      </>
    ),
  },
  {
    title: `Pay ${RECOVERY_FEE} of matured recoveries`,
    body: (
      <>
        Monthly invoice for{" "}
        <Link to="/pricing">{RECOVERY_FEE} of the prior month&apos;s recoveries</Link> that have
        matured for {MATURITY_DAYS}+ days. Nothing owed on failed recoveries or Stripe&apos;s own
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
        <Link key={part.to} to={part.to}>
          {part.label}
        </Link>
      ),
    )}
  </>
);

export const H2 = "fh-home-h2 fh-section fh-semibold fh-text";

export function HomeStats() {
  return (
    <section className="fh-home-band-2">
      <div className="fh-mk-wrap">
        <div className="cap-reveal">
          <div className="fh-home-block-4 fh-center">
            <h2 className={H2}>The revenue you&apos;re losing isn&apos;t showing up as churn.</h2>
            <p className="fh-subhead fh-soft">
              Stripe&apos;s own data on failed payments and what happens next.
            </p>
          </div>
        </div>
        <div className="fh-home-grid-2">
          {STATS.map((item) => (
            <div key={item.stat} className="fh-home-grid-3 cap-reveal">
              <div className={CARD}>
                <div className="cap-panel-body">
                  <div className="fh-home-col">
                    <div className="fh-home-block-5 fh-mono fh-hero fh-semibold fh-tight fh-accent">
                      {item.stat}
                    </div>
                    <p className="fh-home-text-2 fh-copy fh-soft">{item.body}</p>
                    {/* RULES.md 2.3: the exact page and the day it was read. */}
                    <SourceLine href={item.href} name={citation(item.href)} read={STAT_AS_OF} />
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function HomeComparison() {
  return (
    <section className="fh-mk-band">
      <div className="fh-mk-wrap">
        <div className="cap-reveal">
          <div className="fh-home-block-4 fh-center">
            <h2 className={H2}>Stripe plus Foxhound</h2>
          </div>
        </div>
        <div className="fh-home-block-6">
          {COMPARISON_ROWS.map((row) => (
            <div key={row.stripeTitle} className="fh-home-grid-4 cap-reveal">
              <div className={CARD}>
                <div className="cap-panel-body">
                  <div>
                    <div className="fh-home-block-7 fh-caption fh-quiet">Stripe does this</div>
                    <div className="fh-home-block-8 fh-body fh-medium fh-text">
                      {row.stripeTitle}
                    </div>
                    <p className="fh-home-text-3 fh-copy fh-soft">{row.stripeBody}</p>
                  </div>
                </div>
              </div>
              <Link to={row.foxhoundHref} className={`${CARD} fh-hover-group`}>
                <div className="cap-panel-body">
                  <div>
                    <div className="fh-home-block-7 fh-caption fh-medium fh-accent">
                      Foxhound adds this
                    </div>
                    <div className="fh-home-block-8 fh-body fh-semibold fh-text">
                      {row.foxhoundTitle}
                    </div>
                    <p className="fh-home-text-3 fh-copy fh-soft">{row.foxhoundBody}</p>
                    <div className="fh-home-block-9 fh-mono fh-caption fh-accent">
                      Learn more <Arrow />
                    </div>
                  </div>
                </div>
              </Link>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function HomeBlogStrip({
  blogPosts,
}: {
  blogPosts: { slug: string; title: string; tags: string[]; readingTimeMinutes: number }[];
}) {
  return blogPosts.length > 0 ? (
    <section className="fh-home-band-6">
      <div className="fh-mk-wrap">
        <div className="cap-reveal">
          <div className="fh-home-row-3">
            <h2 className="fh-copy fh-regular fh-soft">From the blog</h2>
            <Link to="/blog" className="fh-mk-quiet-link fh-hover-group fh-caption fh-quiet">
              All articles <Arrow />
            </Link>
          </div>
        </div>
        <div className="fh-home-grid-6">
          {blogPosts.map((post) => (
            <div key={post.slug} className="fh-home-grid-3 cap-reveal">
              {/* Recova's blog card: the page ground on the surface band, p-5, 10px corners. */}
              <Link to={`/blog/${post.slug}`} className="fh-home-link-3 cap-panel">
                <div className="cap-panel-body">
                  <div className="cap-stack fh-home-block-14" data-gap="4">
                    {post.tags[0] ? (
                      <div className="fh-mono fh-tiny fh-quiet">
                        {post.tags[0].replace(/-/g, " ")}
                      </div>
                    ) : null}
                    <h3 className="fh-home-title-3 fh-item-title fh-medium fh-text">
                      {post.title}
                    </h3>
                    <span className="fh-home-label-2 fh-mono fh-tiny fh-quiet">
                      {post.readingTimeMinutes} min read
                    </span>
                  </div>
                </div>
              </Link>
            </div>
          ))}
        </div>
      </div>
    </section>
  ) : null;
}
