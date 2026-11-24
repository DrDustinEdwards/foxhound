import {
  article,
  itemList,
  organization,
  person,
  softwareApplication,
  thing,
  website,
} from "@drdustinedwards/site-helpers/schema";

import { RECOVERY_FEE_PERCENT } from "~/lib/billing/page";

// Single source of truth for the site's public origin and the JSON-LD builders used across
// marketing pages (TASK-foxhound-phase6.md SITE_URL discipline). Every absolute URL (JSON-LD @id,
// canonical links) must derive from siteUrl(env), never a hardcoded domain. env.BETTER_AUTH_URL now
// resolves to https://foxhoundapp.com; the fallback below only matters if that var is ever unset.
// siteUrl(env) is the only function here that touches Env (it's called once, in a route loader).

/** The production origin, for code that has no Env to ask (and siteUrl's
 *  fallback). Anything that can read Env uses siteUrl(env). */
export const SITE_ORIGIN = "https://foxhoundapp.com";

export function siteUrl(env: Env): string {
  return env.BETTER_AUTH_URL || SITE_ORIGIN;
}

// Single source of truth for the support contact address, used in JSON-LD (organizationJsonLd
// below) and in page copy (about.tsx, privacy.tsx, terms.tsx).
export const SUPPORT_EMAIL = "support@foxhoundapp.com";

// Foxhound operates as Dustin Edwards personally (sole proprietor) until Foxing LLC forms (no date is
// set), so Texas is the real governing-law state today, not a carried-over guess.
export const GOVERNING_LAW_JURISDICTION = "Texas";

export function organizationJsonLd(url: string) {
  return organization({
    id: `${url}/#organization`,
    name: "Foxhound",
    url,
    logo: `${url}/favicon.svg`,
    description:
      "Pay-on-lift recovery, review-and-sign disputes, and free MRR intelligence for Stripe merchants.",
    email: SUPPORT_EMAIL,
    knowsAbout: [
      "Failed payment recovery",
      "Stripe dunning",
      "Subscription revenue recovery",
      "Chargeback disputes",
      "Payment decline codes",
      "Involuntary churn",
      "SaaS revenue operations",
    ],
  });
}

export function softwareApplicationJsonLd(url: string) {
  return softwareApplication({
    id: `${url}/#software`,
    name: "Foxhound",
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    url,
    description: `Recover failed Stripe subscription payments with silent retries and AI-drafted email sequences. ${RECOVERY_FEE_PERCENT}% of Foxhound-attributed recoveries only, nothing Stripe would have recovered anyway.`,
    publisher: { "@id": `${url}/#organization` },
    // NO `offers` BLOCK, DELIBERATELY. Recovery is a percentage of money it creates and
    // Recovery and disputes are billed as a percentage of what they win, so "0" told search engines
    // there is no fee at all. Intelligence is free (INTELLIGENCE_FREE_SENTENCE), and says so in the
    // description above.
  });
}

/** The speakable parts of a page, on Prelum's WebPage node (marketingMeta) by its `@id`, so the page is one node. */
export function speakableWebPageJsonLd(url: string, opts: { path: string; selectors: string[] }) {
  return thing("WebPage", {
    "@id": `${url}${opts.path}#webpage`,
    url: `${url}${opts.path}`,
    speakable: {
      "@type": "SpeakableSpecification",
      cssSelector: opts.selectors,
    },
  });
}

// NO sitelinks-searchbox SearchAction here, deliberately. A SearchAction is a machine-readable
// promise that the URL template resolves to a working search, so this was a structured-data claim
// for a feature that was never built.
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
  // Prelum drops an empty sameAs: an empty list claims links the page does not have.
  return person({
    id: `${url}/about#person`,
    name: opts.name,
    jobTitle: opts.jobTitle,
    description: opts.description,
    worksFor: { "@id": `${url}/#organization` },
    sameAs: opts.sameAs,
  });
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
export function blogPostJsonLd(
  url: string,
  opts: {
    headline: string;
    description: string;
    path: string;
    imageUrl: string;
    /** The picture's Article crops, absolute, written in place of imageUrl where there are any. */
    images?: Array<{ url: string; width: number; height: number }>;
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
    image: opts.images?.length ? opts.images : opts.imageUrl,
    published: opts.datePublished,
    modified: opts.dateModified,
    author,
    publisher: { "@id": `${url}/#organization` },
  });
}

/**
 * A documentation guide, as schema.org's own type for technical documentation. NO AUTHOR AND NO
 * dateModified.
 */
export function techArticleJsonLd(
  url: string,
  opts: { headline: string; description: string; path: string; datePublished: string },
) {
  return thing("TechArticle", {
    headline: opts.headline,
    description: opts.description,
    url: `${url}${opts.path}`,
    datePublished: opts.datePublished,
    inLanguage: "en",
    isPartOf: { "@type": "WebSite", "@id": `${url}/#website` },
    publisher: { "@id": `${url}/#organization` },
  });
}

/** The docs index as an ItemList of its guides, in the order the page renders them, each with its description, so a
 *  crawler reading the hub gets the set rather than five unrelated pages it has to discover by link-following. */
export function docsItemListJsonLd(
  url: string,
  guides: { title: string; description: string; slug: string }[],
) {
  return itemList(
    url,
    "Foxhound documentation",
    guides.map((guide) => ({
      name: guide.title,
      description: guide.description,
      path: `/docs/${guide.slug}`,
    })),
  );
}
