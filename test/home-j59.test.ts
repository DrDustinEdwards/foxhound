import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { cloudflareContext } from "~/lib/cloudflare-context";
import { RECOVERY_SCHEDULES, isRetryStep } from "~/lib/recovery/schedule";
import Home, { loader } from "~/routes/home";
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
});

describe("the blog strip puts the featured post first (M3 divergence 34)", () => {

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


function actionContext(env: Env) {
  return {
    get(key: unknown) {
      if (key === cloudflareContext) return { env, ctx: {} as ExecutionContext, nonce: "n" };
      throw new Error("unexpected context key");
    },
  };
}

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
