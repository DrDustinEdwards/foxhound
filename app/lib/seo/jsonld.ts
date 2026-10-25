import { article, breadcrumbs, faqPage, website } from "@drdustinedwards/site-helpers/schema";

// Single source of truth for the site's public origin and the JSON-LD
// builders used across marketing pages (TASK-foxhound-phase6.md SITE_URL
// discipline). Every absolute URL (JSON-LD @id, canonical links) must derive
// from siteUrl(env), never a hardcoded domain. env.BETTER_AUTH_URL now
// resolves to https://foxhoundapp.com (Phase 9 cutover); the fallback below
// only matters if that var is ever unset.
//
// siteUrl(env) is the only function here that touches Env (it's called once,
// in a route loader). Every builder below takes the resolved `url: string`
// so page components never need to thread Env through JSX.

/** The production origin, for code that has no Env to ask (and siteUrl's
 *  fallback). Anything that can read Env uses siteUrl(env). */
export const SITE_ORIGIN = "https://foxhoundapp.com";

export function siteUrl(env: Env): string {
  return env.BETTER_AUTH_URL || SITE_ORIGIN;
}

// Single source of truth for the support contact address, used in JSON-LD
// (organizationJsonLd below) and in page copy (about.tsx, privacy.tsx,
// terms.tsx). Do not hardcode this string anywhere else.
//
// Settled by the operating-entity ruling (recova/decisions.md, 2026-07-21):
// a domain choice, entity-independent, so it does not change at LLC formation.
export const SUPPORT_EMAIL = "support@foxhoundapp.com";

// Settled by the operating-entity ruling (recova/decisions.md, 2026-07-21).
// Foxhound operates as Dustin Edwards personally (sole proprietor) until
// Foxing LLC forms (targeted ~September 2026), so Texas is the real
// governing-law state today, not a carried-over guess.
export const GOVERNING_LAW_JURISDICTION = "Texas";

export function organizationJsonLd(url: string) {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${url}/#organization`,
    name: "Foxhound",
    url,
    logo: `${url}/favicon.svg`,
    description:
      "Pay-on-lift recovery, review-and-sign disputes, and free MRR intelligence for Stripe merchants.",
    contactPoint: {
      "@type": "ContactPoint",
      email: SUPPORT_EMAIL,
      contactType: "customer support",
    },
    knowsAbout: [
      "Failed payment recovery",
      "Stripe dunning",
      "Subscription revenue recovery",
      "Chargeback disputes",
      "Payment decline codes",
      "Involuntary churn",
      "SaaS revenue operations",
    ],
  };
}

export function softwareApplicationJsonLd(url: string) {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "@id": `${url}/#software`,
    name: "Foxhound",
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    url,
    description:
      "Recover failed Stripe subscription payments with silent retries and AI-drafted email sequences. 20% of Foxhound-attributed recoveries only, nothing Stripe would have recovered anyway.",
    publisher: { "@id": `${url}/#organization` },
    // NO `offers` BLOCK, DELIBERATELY (376 item 22, verified true at 2569400).
    //
    // It used to read `price: "0"` with the description "Free audit. Recovery at
    // 20% of Foxhound-attributed recoveries." The description was accurate and
    // the PRICE WAS NOT: zero is the audit's price, and a crawler reading this
    // object reads one price for the whole application. Recovery is a percentage
    // of money it creates and Intelligence is a monthly fee, so "0" told search
    // engines the product is free when two thirds of it is not.
    //
    // REMOVED RATHER THAN TURNED INTO A RANGE, and the reason is that the range
    // has no top. An AggregateOffer needs a lowPrice and a highPrice, and 20% of
    // an unknown recovered amount has no highPrice that is not invented. A
    // fabricated ceiling in a machine-readable field is the same class of defect
    // as the "0", one digit further from being noticed. Foxhound has no single
    // price, so it publishes none; /pricing states all three in prose, which is
    // where a number belongs when it needs a sentence to be true.
    //
    // The day a fixed-price plan exists with a checkout behind it, an Offer here
    // becomes both truthful and worth having.
  };
}

export interface JsonLdFaq {
  question: string;
  answer: string;
}

export function faqPageJsonLd(faqs: JsonLdFaq[]) {
  return faqPage(faqs);
}

export function speakableWebPageJsonLd(
  url: string,
  opts: { name: string; path: string; selectors: string[] },
) {
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: opts.name,
    url: `${url}${opts.path}`,
    speakable: {
      "@type": "SpeakableSpecification",
      cssSelector: opts.selectors,
    },
  };
}

// NO sitelinks-searchbox SearchAction here, deliberately. It used to declare
// `/blog?q={search_term_string}`, and no such search exists: /blog, /blog/archive,
// /blog/tag and /blog/post read no `q` parameter at all (archive reads `tag`, and
// that is the only search param in the whole blog tree). A SearchAction is a
// machine-readable promise that the URL template resolves to a working search, so
// this was a structured-data claim for a feature that was never built. If a real
// blog search ships, restore it pointing at that route and not before.
export function websiteJsonLd(url: string) {
  return website({
    origin: url,
    name: "Foxhound",
    description:
      "Recover failed Stripe payments without billing merchants for what Stripe would have gotten anyway.",
    publisher: { "@id": `${url}/#organization` },
  });
}

// Built now per TASK-foxhound-phase6.md; used more heavily once /blog ships
// in Pass 2 (author bylines) and on /about in this pass.
export function personJsonLd(
  url: string,
  opts: { name: string; jobTitle: string; description: string; sameAs?: string[] },
) {
  return {
    "@context": "https://schema.org",
    "@type": "Person",
    "@id": `${url}/about#person`,
    name: opts.name,
    jobTitle: opts.jobTitle,
    description: opts.description,
    worksFor: { "@id": `${url}/#organization` },
    sameAs: opts.sameAs ?? [],
  };
}

// Built for /blog/:slug (Pass 2). @type is BlogPosting (the Article family
// member Google's Rich Results docs recommend for blog content specifically).
// author resolves to the existing Person entity (personJsonLd on /about) by
// @id when the stored author name is Dustin Edwards, so the two structured
// bylines corroborate each other instead of describing two different
// authors. A stored author of "Foxhound" (the brand byline used on posts
// with no named human author) resolves to the Organization node by @id
// instead of an inline Person: Foxhound is a company, not a person, and
// schema.org's `author` property accepts an Organization. Any other author
// string falls back to an inline Person node.
export function articleJsonLd(
  url: string,
  opts: {
    headline: string;
    description: string;
    path: string;
    imageUrl: string;
    datePublished: string | null;
    dateModified: string;
    authorName: string;
  },
) {
  const normalizedAuthor = opts.authorName.trim().toLowerCase();
  const author =
    normalizedAuthor === "dustin edwards"
      ? { "@id": `${url}/about#person` }
      : normalizedAuthor === "foxhound"
        ? { "@id": `${url}/#organization` }
        : { "@type": "Person", name: opts.authorName };
  return article({
    type: "BlogPosting",
    url: `${url}${opts.path}`,
    headline: opts.headline,
    description: opts.description,
    image: opts.imageUrl,
    published: opts.datePublished,
    modified: opts.dateModified,
    author,
    publisher: { "@id": `${url}/#organization` },
  });
}

// Used more heavily once /blog post pages ship in Pass 2; the builder is
// wired now so those pages can call it without an SEO-module change.
export function breadcrumbListJsonLd(url: string, items: { name: string; path: string }[]) {
  return breadcrumbs(url, items);
}

/**
 * A documentation guide, as schema.org's own type for technical documentation.
 *
 * TechArticle RATHER THAN BlogPosting OR WebPage, and the choice is the site's
 * existing vocabulary applied rather than a new one invented. The blog already
 * emits BlogPosting through `articleJsonLd`; marketing pages emit WebPage plus
 * SpeakableSpecification. Neither fits a user guide: BlogPosting claims a dated
 * editorial post with an author, and a bare WebPage says nothing about the page
 * being documentation. TechArticle is a subtype of Article built for exactly
 * this, so a crawler gets the stronger signal without Foxhound minting a type it
 * uses nowhere else.
 *
 * THE PUBLISHER IS THE SAME @id THE REST OF THE SITE USES, so the guides join
 * the existing Organization node rather than describing a second publisher.
 *
 * NO AUTHOR AND NO dateModified. The guides are house documentation with no
 * named byline, and the content module tracks no per-guide revision; inventing
 * either would be a fabricated claim in a file whose whole purpose is to be
 * quoted by machines.
 */
export function techArticleJsonLd(
  url: string,
  opts: { headline: string; description: string; path: string; datePublished: string },
) {
  return {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: opts.headline,
    description: opts.description,
    url: `${url}${opts.path}`,
    datePublished: opts.datePublished,
    inLanguage: "en",
    isPartOf: { "@type": "WebSite", "@id": `${url}/#website` },
    publisher: { "@id": `${url}/#organization` },
  };
}

/** The docs index as an ItemList of its guides, in the order the page renders
 *  them, so a crawler reading the hub gets the set rather than five unrelated
 *  pages it has to discover by link-following. */
export function docsItemListJsonLd(
  url: string,
  guides: { title: string; description: string; slug: string }[],
) {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Foxhound documentation",
    itemListElement: guides.map((guide, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: guide.title,
      description: guide.description,
      url: `${url}/docs/${guide.slug}`,
    })),
  };
}
