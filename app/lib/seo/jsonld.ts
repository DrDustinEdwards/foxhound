// Single source of truth for the site's public origin and the JSON-LD
// builders used across marketing pages (TASK-foxhound-phase6.md SITE_URL
// discipline). Every absolute URL (JSON-LD @id, canonical links) must derive
// from siteUrl(env), never a hardcoded domain. env.BETTER_AUTH_URL currently
// resolves to the Workers preview origin; the public domain
// foxhoundapp.com attaches at Phase 9 cutover and nothing here needs to
// change when it does.
//
// siteUrl(env) is the only function here that touches Env (it's called once,
// in a route loader). Every builder below takes the resolved `url: string`
// so page components never need to thread Env through JSX.

export function siteUrl(env: Env): string {
  return env.BETTER_AUTH_URL || "https://foxhound.dustin-edwards.workers.dev";
}

// Single source of truth for the support contact address, used in JSON-LD
// (organizationJsonLd below) and in page copy (about.tsx, privacy.tsx,
// terms.tsx). Do not hardcode this string anywhere else.
//
// Placeholder pending the operating-entity decision, same as
// GOVERNING_LAW_JURISDICTION below: TASK-foxhound-phase6.md names both as a
// pair parked on that one decision, and no operating-entity decision is
// recorded in recova/decisions.md yet. Marked as an explicit placeholder
// rather than a real-looking address so a real support inbox is never
// silently promised (in JSON-LD contactPoint, mailto links, or an RSS/llms
// "Contact:" line) before one actually exists.
// TODO(dustin): confirm operating entity and real support address before launch.
export const SUPPORT_EMAIL = "[SUPPORT_EMAIL_TBD]";

// The governing-law state was carried over from legacy as "Texas" without
// ever being verified against the actual current operating entity. Marked as
// an explicit placeholder rather than a real state name so it cannot read as
// a legal assertion if it slipped onto a live page before this is resolved.
// TODO(dustin): confirm operating entity and governing-law state before launch.
export const GOVERNING_LAW_JURISDICTION = "[GOVERNING_LAW_JURISDICTION_TBD]";

// Retained from legacy at cutover per TASK-foxhound-phase6.md; do not invent
// new handles here.
const SOCIAL_SAME_AS = [
  "https://x.com/recovamrr",
  "https://bsky.app/profile/recovamrr.bsky.social",
  "https://www.reddit.com/user/recovamrr/",
];

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
    sameAs: SOCIAL_SAME_AS,
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
    potentialAction: {
      "@type": "SearchAction",
      target: { "@type": "EntryPoint", urlTemplate: `${url}/blog?q={search_term_string}` },
      "query-input": "required name=search_term_string",
    },
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
