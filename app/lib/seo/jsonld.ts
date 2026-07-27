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

export function siteUrl(env: Env): string {
  return env.BETTER_AUTH_URL || "https://foxhoundapp.com";
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
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      description: "Free audit. Recovery at 20% of Foxhound-attributed recoveries.",
    },
  };
}

export interface JsonLdFaq {
  question: string;
  answer: string;
}

export function faqPageJsonLd(faqs: JsonLdFaq[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((faq) => ({
      "@type": "Question",
      name: faq.question,
      acceptedAnswer: { "@type": "Answer", text: faq.answer },
    })),
  };
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
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${url}/#website`,
    url,
    name: "Foxhound",
    description:
      "Recover failed Stripe payments without billing merchants for what Stripe would have gotten anyway.",
    publisher: { "@id": `${url}/#organization` },
  };
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
  return {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: opts.headline,
    description: opts.description,
    url: `${url}${opts.path}`,
    image: opts.imageUrl,
    ...(opts.datePublished ? { datePublished: opts.datePublished } : {}),
    dateModified: opts.dateModified,
    author,
    publisher: { "@id": `${url}/#organization` },
  };
}

// Used more heavily once /blog post pages ship in Pass 2; the builder is
// wired now so those pages can call it without an SEO-module change.
export function breadcrumbListJsonLd(url: string, items: { name: string; path: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: `${url}${item.path}`,
    })),
  };
}
