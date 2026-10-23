import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { cloudflareContext } from "~/lib/cloudflare-context";
import {
  DISPUTE_FEE_CAP_CENTS,
  INTELLIGENCE_PRICE_CENTS,
  MODEL_MARKETING_EMAIL_SAMPLE,
  MODEL_RECOVERY_EMAIL,
  RECOVERY_FEE_BPS,
  RECOVERY_MATURITY_DAYS,
} from "~/lib/constants";
import { RECOVERY_SCHEDULES, isRetryStep } from "~/lib/recovery/schedule";
import { STRIPE_RECOVERY_RATE_PERCENT } from "~/lib/marketing/statistics";
import { EmailGeneratorView } from "~/components/email-samples";
import routes from "~/routes";
import Home, { loader, meta } from "~/routes/home";
import { action as generateEmailSample } from "~/routes/marketing/generate-email-sample";

// J59 (job_0a1ab5766050), row M3: the home page's frozen copy, the closing
// links, and the page built from Capsomer's parts. Recova's spec, read whole at
// HEAD through Capsid repo "legacy": app/(marketing)/page.tsx (blob c10db7d5),
// components/hero/RecoveryDemo.tsx (453261b6), components/marketing/
// EmailGenerator.tsx (c4592a56), components/marketing/RecoveryCalculator.tsx
// (1a4374f5), components/FaqAccordion.tsx (b5f1e487), components/FadeUp.tsx
// (cdcfc8cb).
//
// These read the RENDERED page. Every product fact is worked out here a second
// way, from the engine constants, never read back from the copy under test.

type HomeProps = { loaderData: { siteUrl: string; blogPosts: Post[] } };
interface Post {
  slug: string;
  title: string;
  tags: string[];
  readingTimeMinutes: number;
  featured: boolean;
}

const POSTS: Post[] = [
  { slug: "a-featured", title: "The featured one", tags: ["failed-payments"], readingTimeMinutes: 6, featured: true },
  { slug: "b-latest", title: "Latest", tags: ["dunning"], readingTimeMinutes: 4, featured: false },
  { slug: "c-second", title: "Second", tags: [], readingTimeMinutes: 3, featured: false },
];

function render(blogPosts: Post[] = POSTS): string {
  const Page = Home as unknown as (props: HomeProps) => React.ReactElement;
  const router = createMemoryRouter(
    [{ path: "*", element: createElement(Page, { loaderData: { siteUrl: "https://foxhoundapp.com", blogPosts, latestPosts: blogPosts } as HomeProps["loaderData"] }) }],
    { initialEntries: ["/"] },
  );
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

/** Text with tags stripped and the entities this page uses decoded. */
function text(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&middot;/g, "·")
    .replace(/\s+/g, " ")
    .trim();
}

/** The section that holds a heading, from its opening tag to the next section. */
function sectionWith(html: string, heading: string): string {
  const at = html.indexOf(heading);
  expect(at, `the page has "${heading}"`).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<section", at);
  const end = html.indexOf("</section>", at);
  return html.slice(start, end);
}

interface RouteEntry {
  path?: string;
  index?: boolean;
  children?: RouteEntry[];
}
function routePaths(entries: RouteEntry[], parent = "", out = new Set<string>()): Set<string> {
  for (const e of entries) {
    let path = parent;
    if (e.path) {
      path = `${parent}/${e.path.replace(/^\/+|\/+$/g, "")}`;
      out.add(path);
    } else if (e.index) {
      out.add(parent === "" ? "/" : parent);
    }
    if (e.children) routePaths(e.children, path, out);
  }
  return out;
}

const readSource = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const pct = `${RECOVERY_FEE_BPS / 100}%`;
const unrecovered = 100 - STRIPE_RECOVERY_RATE_PERCENT;
const sequenceDays = Math.round(
  Math.max(...Object.values(RECOVERY_SCHEDULES).flatMap((s) => s.map((x) => x.offsetHours))) / 24,
);

describe("the closing links are Recova's two demo links (M3 divergence 39)", () => {
  const html = render();
  const closing = sectionWith(html, "See what your Stripe account is leaking");

  it("links the Recovery demo and the Disputes demo, and nothing else under the line", () => {
    const links = [...closing.matchAll(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => [
      m[1],
      text(m[2]),
    ]);
    expect(links).toEqual([
      ["/audit", "Connect Stripe, it is free"],
      ["/demos/recovery", "View Recovery demo"],
      ["/demos/disputes", "View Disputes demo"],
    ]);
  });
});

describe("the frozen copy is Recova's wherever Recova told the truth (M3 copy drift)", () => {
  const html = render();
  const page = text(html);

  it("keeps Recova's headline: You pay when you recover. Not before.", () => {
    const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? "";
    expect(text(h1)).toBe("You pay when you recover. Not before.");
  });

  it("opens the hero line with Recova's five sentences, then the price with its two sanctioned facts", () => {
    expect(page).toContain(
      "Most churn is not people quitting. It is cards that fail. Foxhound gets that revenue back. Stripe takes the payment. Foxhound wins back the ones that fail.",
    );
    expect(page).toContain(`${pct} of what Foxhound recovers`);
    expect(page).toContain("Anything Stripe would have recovered on its own is free");
    expect(page).toContain(`held the money for ${RECOVERY_MATURITY_DAYS} days`);
  });

  it("sends See it live to the Recovery demo, as Recova's /recovery/demo did", () => {
    expect(html).toMatch(/<a [^>]*href="\/demos\/recovery"[^>]*>See it live/);
  });

  it("says Stripe's tools, as Recova does, with the rate read from the engine's statistics", () => {
    expect(page).toContain(
      `${STRIPE_RECOVERY_RATE_PERCENT}% of failed payments are recovered by Stripe's tools on average. The other ${unrecovered}% doesn't come back without additional sequences.`,
    );
    expect(page).not.toContain("Stripe's own tools");
  });

  it("restores both of Recova's Stripe does this bodies word for word", () => {
    expect(page).toContain(
      "Fixed retry schedule. No customer communication. No logic for why the payment failed. Soft decline, expired card, and fraud all treated the same.",
    );
    expect(page).toContain(
      "Stripe emails you when a dispute opens and shows you a deadline. Evidence submission, response writing, and Stripe submission are all manual.",
    );
  });

  it("titles the recovery row Recova's way, with the sequence length read from the schedule", () => {
    expect(page).toContain(`Intelligent ${sequenceDays}-day sequences`);
  });

  it("keeps the statement's body to what Stripe does not do, without silent retries (Stripe retries too)", () => {
    expect(page).toContain(
      `The other ${unrecovered}% needs something Stripe doesn't do: personalized email sequences, decline classification, and ${sequenceDays} days of follow-through.`,
    );
    expect(page).not.toContain("silent retries first,");
  });

  it("restores How it works' three inline links and Recova's step two title", () => {
    const how = sectionWith(html, "How it works");
    const hrefs = [...how.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(["https://stripe.com/docs/connect/oauth-standard-accounts", "/product/recovery", "/pricing"]);
    expect(text(how)).toContain("Foxhound runs sequences");
    expect(text(how)).toContain("No minimums, no setup fees.");
  });

  it("says estimated recovery in the calculator's line, as Recova does", () => {
    expect(page).toContain("Adjust your MRR and see the estimated recovery.");
  });

  it("asks Recova's billing question and links the four product names, as Recova does", () => {
    expect(page).toContain("How does billing work exactly?");
    const faq = sectionWith(html, "Common questions");
    const links = [...faq.matchAll(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => [m[1], text(m[2])]);
    expect(links).toEqual([
      ["/product/recovery", "Recovery"],
      ["/product/disputes", "Disputes"],
      ["/product/intelligence", "Intelligence"],
      ["/product/audit", "Audit"],
    ]);
    expect(text(faq)).toContain("You owe nothing for sequences that do not recover.");
  });

  it("labels the decline types as Recova does: the decline in bold, the cause beneath, no raw Stripe code", () => {
    const generator = sectionWith(html, "Decline type");
    const t = text(generator);
    for (const [label, cause] of [
      ["Soft decline", "Insufficient funds"],
      ["Network error", "Processing failure"],
      ["Expired card", "Card needs updating"],
      ["Fraud flag", "Bank flagged the charge"],
    ]) {
      expect(t).toContain(`${label} ${cause}`);
    }
    expect(t).not.toContain("do_not_honor");
  });

  it("gives the generate button Recova's trailing arrow", () => {
    expect(html).toMatch(/Generate recovery email[\s\S]{0,40}<svg/);
  });

  it("takes Recova's title, in Foxhound's name", () => {
    const tags = meta({ loaderData: { siteUrl: "https://foxhoundapp.com", blogPosts: [] } } as never) as {
      title?: string;
    }[];
    expect(tags.find((t) => t.title)?.title).toBe("Foxhound: Recover failed Stripe payments");
  });

  it("puts Recova's product prices under each card, with every figure read from the engine", () => {
    const products = sectionWith(html, "Start with recovery.");
    const t = text(products);
    expect(t).toContain("Full Stripe diagnostic. See what is leaking before you commit.");
    expect(t).toContain(`${pct} of Foxhound-attributed recoveries`);
    expect(t).toContain(`${RECOVERY_FEE_BPS / 100}% of won disputes, capped at $${DISPUTE_FEE_CAP_CENTS / 100}`);
    expect(t).toContain(`$${INTELLIGENCE_PRICE_CENTS / 100}/mo`);
  });

  it("says the calculator's audit is a read-only Stripe connection, as Recova does and as the audit is", () => {
    expect(page).toContain("Free audit · No account required · Read-only Stripe access");
    expect(page).not.toContain("No Stripe connection needed");
  });
});

describe("the sanctioned truthfulness divergences stay (parity/M3-DIVERGENCES.md)", () => {
  const html = render();
  const page = text(html);

  it("keeps the read and write scope, the review-and-sign disputes and the trust chip", () => {
    expect(page).toContain("read and write scope");
    expect(page).toContain("You review and sign every submission");
    expect(page).toContain("Never touches your billing configuration");
    expect(page).not.toMatch(/read-only stripe scope|Read-only OAuth|Auto-submitted/i);
  });

  it("keeps Multi-account out of the compatibility line", () => {
    expect(page).not.toContain("Multi-account");
  });

  it("keeps the baseline-free and maturity facts in the trust row", () => {
    expect(page).toContain("Baseline recoveries are free");
    expect(page).toContain(`No fee until ${RECOVERY_MATURITY_DAYS}-day maturity`);
  });

  it("names Recova nowhere", () => {
    expect(page).not.toMatch(/recova/i);
  });
});

describe("the copy says only what Foxhound's engine does (RULES.md 2.1)", () => {
  const html = render();
  const page = text(html);

  it("never says a silent retry comes before every email: only categories whose schedule starts with a retry get one", () => {
    const retryFirst = Object.values(RECOVERY_SCHEDULES).filter((s) => isRetryStep(s[0].stepType)).length;
    expect(retryFirst, "some categories lead with an email").toBeLessThan(Object.keys(RECOVERY_SCHEDULES).length);
    expect(page).not.toMatch(/before any customer ever sees an email/i);
    expect(page).toContain("wherever the decline can be retried");
  });

  it("never claims different sequences per category when the engine shares one between two", () => {
    const distinct = new Set(Object.values(RECOVERY_SCHEDULES).map((s) => JSON.stringify(s))).size;
    expect(distinct).toBeLessThan(Object.keys(RECOVERY_SCHEDULES).length);
    expect(page).not.toMatch(/each handled with a different sequence|four different sequences|four decline categories/i);
  });

  it("does not say the sample generator is the product's AI unless the two models are the same", () => {
    if ((MODEL_MARKETING_EMAIL_SAMPLE as string) !== (MODEL_RECOVERY_EMAIL as string)) {
      expect(page).not.toMatch(/same AI/i);
    }
  });

  it("never claims Intelligence changes Recovery timing (APPROVED-DIFFERENCES, the Intelligence entry)", () => {
    expect(page).not.toMatch(/recovery timing/i);
  });

  it("says basic MRR analytics are free for every Recovery merchant", () => {
    expect(page).toContain("free for every Recovery merchant");
  });
});

describe("the layout is Recova's (M3 divergences 43, 46, 47, 48, 49)", () => {
  const html = render();

  it("uses Recova's px-5 side padding on every section", () => {
    const sections = [...html.matchAll(/<section [^>]*class="([^"]*)"/g)].map((m) => m[1]);
    expect(sections.length).toBeGreaterThan(10);
    for (const c of sections) {
      expect(c, c).toMatch(/\bpx-5\b/);
      expect(c, c).not.toMatch(/\bpx-4\b/);
    }
  });

  it("uses Recova's py-24 on the stats, the calculator and the closing block", () => {
    for (const heading of [
      "The revenue you",
      "How much are you leaving on the table?",
      "See what your Stripe account is leaking",
    ]) {
      expect(sectionWith(html, heading)).toMatch(/^<section [^>]*class="[^"]*\bpy-24\b/);
    }
  });

  it("keeps the products anchor at Recova's 60px scroll margin and the statement's overflow-hidden", () => {
    expect(html).toMatch(/<section id="products" class="[^"]*scroll-mt-\[60px\]/);
    expect(sectionWith(html, "never come back.")).toMatch(/^<section [^>]*class="[^"]*\boverflow-hidden\b/);
  });

  it("centres the hero's demo as Recova does and gives product descriptions Recova's 60px floor", () => {
    expect(html).toMatch(/class="animate-fade-in delay-320 flex items-center justify-center"/);
    expect(sectionWith(html, "Start with recovery.")).toContain("min-h-[60px]");
  });
});

describe("the blog strip puts the featured post first (M3 divergence 34)", () => {
  it("renders the cards in the order the loader chose", () => {
    const html = render();
    const blog = sectionWith(html, "From the blog");
    const slugs = [...blog.matchAll(/href="\/blog\/([^"]+)"/g)].map((m) => m[1]);
    expect(slugs).toEqual(["a-featured", "b-latest", "c-second"]);
  });

  it("the loader asks for the featured post and the five latest, as Recova does", () => {
    const src = readSource("app/routes/home.tsx");
    expect(src).toContain("getFeaturedPost(db)");
    expect(src).toContain("listPublishedPosts(db, 5)");
  });

  it("a database error drops the strip, never the page (review round 1)", async () => {
    const failing = {
      prepare() {
        throw new Error("D1 unavailable");
      },
      batch() {
        throw new Error("D1 unavailable");
      },
    };
    const ctx = {
      get(key: unknown) {
        if (key === cloudflareContext) return { env: { DB: failing } as unknown as Env, ctx: {} as ExecutionContext, nonce: "n" };
        throw new Error("unexpected context key");
      },
    };
    const data = await loader({
      context: ctx,
      request: new Request("https://foxhoundapp.com/"),
      params: {},
    } as unknown as Parameters<typeof loader>[0]);
    expect(data.blogPosts).toEqual([]);
    expect(render([])).not.toContain("From the blog");
  });
});

describe("the email generator shows Recova's error when generation fails (M3 divergence 28)", () => {
  it("the action reports a failure instead of passing a canned email off as generated", async () => {
    const fakeContext = {
      get(key: unknown) {
        if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
        throw new Error("unexpected context key");
      },
    };
    const form = new FormData();
    form.set("category", "soft");
    const result = (await generateEmailSample({
      request: new Request("https://foxhoundapp.com/marketing/generate-email-sample", { method: "POST", body: form }),
      context: fakeContext,
      params: {},
    } as unknown as Parameters<typeof generateEmailSample>[0])) as { data: unknown; init?: { status?: number } };
    expect(result.data).toEqual({ error: true });
    expect(result.init?.status).toBe(503);
  });

  it("the generator draws Recova's failure line for a failed call", () => {
    const html = renderGenerator({ busy: false, result: { error: true } });
    expect(text(html)).toContain("Generation failed. Try again.");
  });
});

describe("the page is built from Capsomer's parts, teal, on the five sizes (Q11, Q12)", () => {
  const html = render();

  it("sits in Capsomer's teal family with Foxhound's neutrals", () => {
    expect(html).toMatch(/^<div class="fh-cap[^"]*" data-cap-site="foxhound" data-family="teal"/);
  });

  it("draws the audit calls to action as Capsomer's primary button and See it live as its default", () => {
    for (const label of ["Run your free audit", "Get your actual numbers free", "Connect Stripe, it is free"]) {
      const a = new RegExp(`<a [^>]*>${label}</a>`).exec(html)?.[0] ?? "";
      expect(a, label).toMatch(/class="cap-btn"/);
      expect(a, label).toContain('data-variant="primary"');
    }
    expect(html).toMatch(/<a [^>]*class="cap-btn( group)?"[^>]*>See it live/);
    expect(html).toMatch(/<button [^>]*class="cap-btn" data-variant="primary"[^>]*>(<span class="cap-btn-label">)?Generate recovery email/);
  });

  it("draws every card as Capsomer's panel", () => {
    expect(html).not.toMatch(/card-elevated|rounded-\[12px\]|rounded-\[10px\]/);
    expect((html.match(/class="cap-panel[ "]/g) ?? []).length).toBeGreaterThanOrEqual(13);
  });

  it("draws the FAQ as Capsomer's disclosure, one open at a time", () => {
    const faq = sectionWith(html, "Common questions");
    const items = [...faq.matchAll(/<details class="cap-disclosure" name="home-faq">/g)];
    expect(items).toHaveLength(5);
  });

  it("draws the decline-type choice as Capsomer's segmented control", () => {
    expect(html).toMatch(/<fieldset class="cap-seg"/);
    expect((html.match(/type="radio" name="decline-type"/g) ?? []).length).toBe(4);
  });

  it("carries no amber anywhere", () => {
    expect(html).not.toMatch(/amber/i);
  });

  it("uses only the five standard text sizes, never an arbitrary text-[ value", () => {
    const FIVE = new Set(["text-display", "text-title", "text-body", "text-label", "text-micro"]);
    const COLOUR =
      /^text-(text|text-secondary|text-tertiary|text-subtle|accent-text|brand-text|cobalt-text|green|red|success-text|error-text|warning-text|center|left|right|border-sub|on-brand)$/;
    expect(html).not.toMatch(/text-\[/);
    const sizes: string[] = [];
    for (const m of html.matchAll(/class="([^"]*)"/g)) {
      for (const c of m[1].split(/\s+/)) {
        const base = c.replace(/^[a-z0-9-]+:/g, "");
        if (base.startsWith("text-") && !COLOUR.test(base)) sizes.push(base);
      }
    }
    expect(sizes.length, "the page carries size classes to check").toBeGreaterThan(20);
    for (const s of sizes) expect(FIVE.has(s), `${s} is one of the five`).toBe(true);
  });

  it("points every internal link at a route that exists", () => {
    const paths = routePaths(routes as RouteEntry[]);
    expect(paths.has("/audit"), "the matcher finds a known route").toBe(true);
    const hrefs = [...html.matchAll(/href="(\/[^"#?]*)/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(10);
    for (const h of hrefs) {
      const known =
        paths.has(h) ||
        [...paths].some((p) => p.includes(":") && new RegExp(`^${p.replace(/:[^/]+/g, "[^/]+")}$`).test(h));
      expect(known, `${h} is a route`).toBe(true);
    }
  });
});

describe("blogStripCards orders the strip as Recova does", async () => {
  const { blogStripCards } = await import("~/lib/marketing/blog-strip");
  const p = (slug: string) => ({ slug });

  it("puts the featured post first and drops it from the latest", () => {
    expect(blogStripCards(p("f"), [p("a"), p("f"), p("b"), p("c")]).map((x) => x.slug)).toEqual(["f", "a", "b"]);
  });

  it("takes the three most recent when nothing is featured", () => {
    expect(blogStripCards(null, [p("a"), p("b"), p("c"), p("d")]).map((x) => x.slug)).toEqual(["a", "b", "c"]);
  });
});

describe("the billing answer's links and its JSON-LD text say the same sentence", async () => {
  const { BILLING_FAQ_PARTS, FAQS } = await import("~/lib/marketing/home-copy");
  it("joins to the plain answer the FAQPage carries", () => {
    const joined = BILLING_FAQ_PARTS.map((part) => (typeof part === "string" ? part : part.label)).join("");
    expect(joined).toBe(FAQS[2].answer);
  });
});

/** The generator alone, in one state, inside a router (it renders links). */
function renderGenerator(state: { busy: boolean; result: { subject: string; body: string } | { error: true } | null }): string {
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: createElement(EmailGeneratorView, {
          category: "soft",
          busy: state.busy,
          result: state.result,
          onSelect: () => {},
          onGenerate: () => {},
        }),
      },
    ],
    { initialEntries: ["/"] },
  );
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

function actionContext(env: Env) {
  return {
    get(key: unknown) {
      if (key === cloudflareContext) return { env, ctx: {} as ExecutionContext, nonce: "n" };
      throw new Error("unexpected context key");
    },
  };
}

describe("the generator's loading state is Recova's (review round 1)", () => {
  it("while a call runs the button is disabled and reads Generating...", () => {
    const html = renderGenerator({ busy: true, result: null });
    const button = /<button [^>]*class="cap-btn"[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0] ?? "";
    expect(button, "the generate button is drawn").toContain('data-variant="primary"');
    expect(button).toMatch(/\sdisabled=""/);
    expect(text(button)).toBe("Generating...");
  });

  it("when idle the button is enabled and reads Generate recovery email", () => {
    const html = renderGenerator({ busy: false, result: null });
    const button = /<button [^>]*class="cap-btn"[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0] ?? "";
    expect(button).not.toMatch(/\sdisabled=""/);
    expect(text(button)).toBe("Generate recovery email");
  });

  it("a new call clears the last failure line, as Recova's setError(false) does", () => {
    const html = renderGenerator({ busy: true, result: { error: true } });
    expect(text(html)).not.toContain("Generation failed. Try again.");
  });
});

describe("the generation route's edges (review round 1)", () => {
  const post = (body: BodyInit) =>
    new Request("https://foxhoundapp.com/marketing/generate-email-sample", {
      method: "POST",
      body,
      headers: { "content-type": "multipart/form-data; boundary=broken" },
    });

  it("over the rate limit, the real action answers { error: true } with 429", async () => {
    const limiter = {
      idFromName: (name: string) => name,
      get: () => ({ check: async () => ({ allowed: false }) }),
    };
    const form = new FormData();
    form.set("category", "soft");
    const result = (await generateEmailSample({
      request: new Request("https://foxhoundapp.com/marketing/generate-email-sample", { method: "POST", body: form }),
      context: actionContext({ RATE_LIMITER: limiter } as unknown as Env),
      params: {},
    } as unknown as Parameters<typeof generateEmailSample>[0])) as { data: unknown; init?: { status?: number } };
    expect(result.data).toEqual({ error: true });
    expect(result.init?.status).toBe(429);
  });

  it("a body that is not a form answers 400, not an unhandled 500", async () => {
    const result = (await generateEmailSample({
      request: post("not a multipart body"),
      context: actionContext({} as Env),
      params: {},
    } as unknown as Parameters<typeof generateEmailSample>[0])) as { data: unknown; init?: { status?: number } };
    expect(result.data).toEqual({ error: true });
    expect(result.init?.status).toBe(400);
  });
});

describe("the category list reads as Recova's does, with and (review round 1)", () => {
  it("joins the engine's categories with and, not or", () => {
    const page = text(render());
    expect(page).not.toMatch(/Decline classification by [^.]*, or /);
    expect(page).toMatch(/Decline classification by [^.]*, and [^.]*, each handled/);
  });
});
