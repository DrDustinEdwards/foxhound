import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

// J36 (job_36eb888192d0), row S31, under Dustin's Q10 and Q11 rulings of
// 2026-10-14: /settings/brand-voice is Recova's page
// (app/(app)/settings/brand-voice/page.tsx at blob 81435702,
// BrandVoiceForm.tsx at blob 8dd126bf and components/BrandVoiceSection.tsx at
// blob 9f4de70c, with SaveBar.tsx at blob f1d6eb23 and SettingsBackLink.tsx at
// blob 64d4a153) built from Capsomer 0.9.0's components, amber throughout.
// Recova stays the spec for every control, label and help line and their
// order; the page keeps the settings layout's 800px column.
//
// The engine plants (resolution order, the four columns, tenant scoping) stay
// in brand-voice-categories.test.ts.
//
// Every assertion here was seen failing against the page before the rebuild.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const route = await import("~/routes/app/settings/brand-voice");


const Page = route.default as unknown as (props: {
  loaderData: Record<string, unknown>;
  actionData?: Record<string, unknown>;
}) => ReactElement;

type Stored = Partial<Record<"soft" | "expired" | "network" | "fraud", string | null>>;

function render(opts: { stored?: Stored; actionData?: Record<string, unknown> } = {}): string {
  const loaderData = {
    connectionId: "conn_1",
    stored: { soft: null, expired: null, network: null, fraud: null, ...opts.stored },
    samples: [],
  };
  const Stub = createRoutesStub([
    {
      path: "/settings/brand-voice",
      Component: () => createElement(Page, { loaderData, actionData: opts.actionData }),
    },
  ]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/settings/brand-voice"] }));
}


function attr(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
}

function selects(html: string): string[] {
  return [...html.matchAll(/<select[^>]*>[\s\S]*?<\/select>/g)].map((m) => m[0]);
}


describe("J36 brand voice: each category's picker", () => {

  it("shows a stored preset as chosen and posts it in the category's hidden field", () => {
    const html = render({ stored: { network: "direct and no-nonsense" } });
    const network = selects(html)[2];
    expect(network).toMatch(/<option value="direct and no-nonsense" selected="">/);
    expect(html).toMatch(/<input type="hidden" name="voice_network" value="direct and no-nonsense"\/>/);
    expect(html).toMatch(/<input type="hidden" name="voice_soft" value=""\/>/);
  });

  it("opens Recova's custom box, a Capsomer input, for a stored voice that is no preset", () => {
    const html = render({ stored: { fraud: "calm and careful" } });
    // The custom boxes only: the sample-email boxes below are textareas too.
    const areas = [...html.matchAll(/<textarea[^>]*>[\s\S]*?<\/textarea>/g)]
      .map((m) => m[0])
      .filter((t) => t.includes("Custom brand voice"));
    expect(areas).toHaveLength(1);
    const area = areas[0];
    expect(area).toContain('class="cap-input"');
    expect(attr(area, "aria-label")).toBe("Custom brand voice for Fraud / hard declines");
    expect(attr(area, "placeholder")).toBe(
      "e.g. warm and empathetic, like a helpful friend. Never pushy, always understanding.",
    );
    expect(area).toContain(">calm and careful</textarea>");
    expect(selects(html)[3]).toMatch(/<option value="custom" selected="">/);
    expect(html).toMatch(/<input type="hidden" name="voice_fraud" value="calm and careful"\/>/);
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

describe("J36 brand voice: a failed save", () => {
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
    form.set("connectionId", "conn_1");
    form.set("voice_soft", "concise and minimal");
    const res = (await route.action({
      context: ctx(),
      request: new Request("https://x/settings/brand-voice", { method: "POST", body: form }),
      params: {},
    } as never)) as unknown as { data: { ok: boolean; error?: string }; init?: { status?: number } };
    expect(res.data.ok).toBe(false);
    expect(res.data.error).toBeUndefined();
    expect(res.init?.status).toBe(500);
    // The error object itself, so its stack reaches the log, not only its message.
    expect(logged).toHaveBeenCalledWith("brand voice write failed:", thrown);
  });
});
