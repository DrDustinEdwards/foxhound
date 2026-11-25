import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import Home, { loader } from "~/routes/home";
import { action as generateEmailSample } from "~/routes/marketing/generate-email-sample";

type HomeProps = { loaderData: { siteUrl: string; blogPosts: Post[] } };
interface Post {
  slug: string;
  title: string;
  tags: string[];
  readingTimeMinutes: number;
  featured: boolean;
}

const POSTS: Post[] = [
  {
    slug: "a-featured",
    title: "The featured one",
    tags: ["failed-payments"],
    readingTimeMinutes: 6,
    featured: true,
  },
  { slug: "b-latest", title: "Latest", tags: ["dunning"], readingTimeMinutes: 4, featured: false },
  { slug: "c-second", title: "Second", tags: [], readingTimeMinutes: 3, featured: false },
];

function render(blogPosts: Post[] = POSTS): string {
  const Page = Home as unknown as (props: HomeProps) => React.ReactElement;
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: createElement(Page, {
          loaderData: {
            siteUrl: "https://foxhoundapp.com",
            blogPosts,
            latestPosts: blogPosts,
          } as HomeProps["loaderData"],
        }),
      },
    ],
    { initialEntries: ["/"] },
  );
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

describe("the home loader", () => {
  it("a database error drops the blog strip, never the page", async () => {
    const failing = {
      prepare() {
        throw new Error("D1 unavailable");
      },
      batch() {
        throw new Error("D1 unavailable");
      },
    };
    const data = await loader({
      context: actionContext({ DB: failing } as unknown as Env),
      request: new Request("https://foxhoundapp.com/"),
      params: {},
    } as unknown as Parameters<typeof loader>[0]);
    expect(data.blogPosts).toEqual([]);
    expect(render([])).not.toContain("From the blog");
  });
});

describe("blogStripCards", async () => {
  const { blogStripCards } = await import("~/lib/marketing/blog-strip");
  const p = (slug: string) => ({ slug });

  it("puts the featured post first and drops it from the latest", () => {
    expect(blogStripCards(p("f"), [p("a"), p("f"), p("b"), p("c")]).map((x) => x.slug)).toEqual([
      "f",
      "a",
      "b",
    ]);
  });

  it("takes the three most recent when nothing is featured", () => {
    expect(blogStripCards(null, [p("a"), p("b"), p("c"), p("d")]).map((x) => x.slug)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});

function actionContext(env: Env) {
  return {
    get(key: unknown) {
      if (key === cloudflareContext) return { env, ctx: {} as ExecutionContext };
      throw new Error("unexpected context key");
    },
  };
}

describe("the email sample generation route", () => {
  const generate = (env: Env, body: BodyInit, headers?: HeadersInit) =>
    generateEmailSample({
      request: new Request("https://foxhoundapp.com/marketing/generate-email-sample", {
        method: "POST",
        body,
        headers,
      }),
      context: actionContext(env),
      params: {},
    } as unknown as Parameters<typeof generateEmailSample>[0]) as Promise<{
      data: unknown;
      init?: { status?: number };
    }>;
  const soft = () => {
    const form = new FormData();
    form.set("category", "soft");
    return form;
  };

  it("reports a failed generation instead of passing a canned email off as generated", async () => {
    const limiter = {
      idFromName: (name: string) => name,
      get: () => ({ hit: async () => ({ ok: true, retryAfterSeconds: 0 }) }),
    };
    const result = await generate({ RATE_LIMITER: limiter } as unknown as Env, soft());
    expect(result.data).toEqual({ error: true });
    expect(result.init?.status).toBe(503);
  });

  it("refuses when the limiter is down, so no model call goes out unmetered", async () => {
    const called = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network"));
    await expect(generate({ ANTHROPIC_API_KEY: "k" } as unknown as Env, soft())).rejects.toThrow();
    expect(called).not.toHaveBeenCalled();
    called.mockRestore();
  });

  it("over the rate limit, answers { error: true } with 429", async () => {
    const limiter = {
      idFromName: (name: string) => name,
      get: () => ({ hit: async () => ({ ok: false, retryAfterSeconds: 60 }) }),
    };
    const result = await generate({ RATE_LIMITER: limiter } as unknown as Env, soft());
    expect(result.data).toEqual({ error: true });
    expect(result.init?.status).toBe(429);
  });

  it("a body that is not a form is refused with a 400, not an unhandled 500", async () => {
    await expect(
      generate({} as Env, "not a multipart body", {
        "content-type": "multipart/form-data; boundary=broken",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
