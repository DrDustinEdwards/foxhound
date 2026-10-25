import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

// J38 (job_4ed2f8dafcf4), row S34, under Dustin's Q10 and Q11 rulings of
// 2026-10-14: /settings/features is Recova's page
// (app/(app)/settings/features/page.tsx at blob d130d2c8, FeaturesForm.tsx at
// blob 4aed5869 and components/FeaturesSection.tsx at blob e7559f6b, with
// SaveBar.tsx at blob f1d6eb23 and SettingsBackLink.tsx at blob 64d4a153)
// built from Capsomer 0.9.0's components, amber throughout. Recova stays the
// spec for every control, label and help line and their order; the page keeps
// the settings layout's 800px column.
//
// The engine plants (NULL is ON at both ends, each toggle gates only its own
// cron, the write is pinned to its account) stay in features-settings.test.ts.
//
// Every assertion here was seen failing against the page before the rebuild.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const route = await import("~/routes/app/settings/features");


const Page = route.default as unknown as (props: {
  loaderData: Record<string, unknown>;
  actionData?: Record<string, unknown>;
}) => ReactElement;

function render(
  opts: { winback?: boolean; expiring?: boolean; actionData?: Record<string, unknown> } = {},
): string {
  const loaderData = {
    winbackNotificationsEnabled: opts.winback ?? true,
    expiringCardNotificationsEnabled: opts.expiring ?? true,
  };
  const Stub = createRoutesStub([
    {
      path: "/settings/features",
      Component: () => createElement(Page, { loaderData, actionData: opts.actionData }),
    },
  ]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/settings/features"] }));
}


function switches(html: string): string[] {
  return [...html.matchAll(/<input[^>]*role="switch"[^>]*>/g)].map((m) => m[0]);
}



describe("J38 features: the card and its two toggles", () => {

  it("shows each stored value: on is checked, off is not", () => {
    const [win, exp] = switches(render({ winback: true, expiring: false }));
    expect(win).toMatch(/\schecked=""/);
    expect(exp).not.toMatch(/\schecked=""/);
    const [win2, exp2] = switches(render({ winback: false, expiring: true }));
    expect(win2).not.toMatch(/\schecked=""/);
    expect(exp2).toMatch(/\schecked=""/);
  });
});

// ---------------------------------------------------------------------------
// The action: a failed write says so instead of throwing an error page.
// ---------------------------------------------------------------------------

function ctx() {
  return {
    get(key: unknown) {
      if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
      if (key === authContext) return { email: "owner@example.com", membership: { accountId: "acct_1" } };
      throw new Error("unexpected context key");
    },
  } as never;
}

describe("J38 features: a failed save", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns Recova's failure state rather than throwing, and logs the thrown error whole", async () => {
    const thrown = new Error("D1 unavailable");
    harness.db = new Proxy(
      {},
      {
        get() {
          throw thrown;
        },
      },
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const form = new FormData();
    form.set("winbackNotificationsEnabled", "on");
    const res = (await route.action({
      context: ctx(),
      request: new Request("https://x/settings/features", { method: "POST", body: form }),
      params: {},
    } as never)) as unknown as { data: { ok: boolean }; init?: { status?: number } };
    expect(res.data.ok).toBe(false);
    expect(res.init?.status).toBe(500);
    // The error object itself, so its stack reaches the log, not only its message.
    expect(logged).toHaveBeenCalledWith("feature settings write failed:", thrown);
  });
});
