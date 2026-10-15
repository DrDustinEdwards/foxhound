import { readFileSync } from "node:fs";
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
// built from Capsomer 0.9.0's components, teal throughout. Recova stays the
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

const SOURCE = readFileSync(new URL("../app/routes/app/settings/features.tsx", import.meta.url), "utf8");
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

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

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function switches(html: string): string[] {
  return [...html.matchAll(/<input[^>]*role="switch"[^>]*>/g)].map((m) => m[0]);
}

function attr(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
}

function byId(html: string, id: string): string {
  const open = html.match(new RegExp(`<(\\w+)[^>]*\\sid="${id}"[^>]*>`));
  if (!open) return "";
  const start = (open.index ?? 0) + open[0].length;
  const close = html.indexOf(`</${open[1]}>`, start);
  return text(html.slice(start, close));
}

describe("J38 features: the page head", () => {
  it("is Capsomer's PageHead with Recova's title and line", () => {
    const html = render();
    expect(html).toMatch(/<header class="cap-page-head">[\s\S]*<h1 class="cap-page-head-title">Features<\/h1>/);
    expect(html).toMatch(/<p class="cap-page-head-lead">Turn optional recovery features on or off\.<\/p>/);
  });

  it("opens with Recova's phone-only back link to the settings hub", () => {
    const html = render();
    const link = html.match(/<a[^>]*href="\/settings"[^>]*>[\s\S]*?<\/a>/)?.[0] ?? "";
    expect(link).toContain("md:hidden");
    expect(text(link)).toBe("Settings");
    expect(html.indexOf('href="/settings"')).toBeLessThan(html.indexOf("cap-page-head-title"));
  });

  it("sits in the settings layout's 800px column with no width or padding of its own", () => {
    const html = render();
    expect(html).not.toContain("max-w-2xl");
    expect(html).not.toMatch(/class="mx-auto/);
  });
});

describe("J38 features: the card and its two toggles", () => {
  it("is one Capsomer panel holding Recova's two rows, win-back first", () => {
    const html = render();
    expect(html).toMatch(/<section class="cap-panel">/);
    const t = text(html);
    const win = t.indexOf("Win-back sequences");
    const exp = t.indexOf("Expiring card alerts");
    expect(win).toBeGreaterThan(-1);
    expect(exp).toBeGreaterThan(win);
    expect(t).toContain("Send re-engagement emails to customers who cancel their subscription");
    expect(t).toContain("Email customers before their card expires to prevent future failures");
  });

  it("draws each toggle as Capsomer's switch, a real checkbox posting its own field", () => {
    const html = render();
    const sw = switches(html);
    expect(sw).toHaveLength(2);
    for (const s of sw) expect(s).toContain('type="checkbox"');
    expect(sw.map((s) => attr(s, "name"))).toEqual([
      "winbackNotificationsEnabled",
      "expiringCardNotificationsEnabled",
    ]);
    expect((html.match(/<label class="cap-switch"/g) ?? []).length).toBe(2);
  });

  it("names each switch by its visible label and describes it by its help line", () => {
    const html = render();
    const [win, exp] = switches(html);
    expect(byId(html, attr(win, "aria-labelledby") ?? "none")).toBe("Win-back sequences");
    expect(byId(html, attr(win, "aria-describedby") ?? "none")).toBe(
      "Send re-engagement emails to customers who cancel their subscription",
    );
    expect(byId(html, attr(exp, "aria-labelledby") ?? "none")).toBe("Expiring card alerts");
    expect(byId(html, attr(exp, "aria-describedby") ?? "none")).toBe(
      "Email customers before their card expires to prevent future failures",
    );
  });

  it("shows each stored value: on is checked, off is not", () => {
    const [win, exp] = switches(render({ winback: true, expiring: false }));
    expect(win).toMatch(/\schecked=""/);
    expect(exp).not.toMatch(/\schecked=""/);
    const [win2, exp2] = switches(render({ winback: false, expiring: true }));
    expect(win2).not.toMatch(/\schecked=""/);
    expect(exp2).toMatch(/\schecked=""/);
  });
});

describe("J38 features: Recova's save bar", () => {
  it("has Save changes as the primary submit, after the card, inside the form", () => {
    const html = render();
    const submit = html.match(/<button[^>]*type="submit"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";
    expect(text(submit)).toBe("Save changes");
    expect(submit).toContain('class="cap-btn"');
    expect(submit).toContain('data-variant="primary"');
    expect(html.indexOf(submit)).toBeGreaterThan(html.indexOf("Expiring card alerts"));
    const form = html.match(/<form[\s\S]*<\/form>/)?.[0] ?? "";
    expect(form).toContain(submit);
    expect(form).toContain('name="winbackNotificationsEnabled"');
  });

  it("says nothing before a save", () => {
    const t = text(render());
    expect(t).not.toContain("Saved");
    expect(t).not.toContain("Failed to save");
  });

  it("says Saved beside the button, as a Capsomer status, after a save", () => {
    const html = render({ actionData: { ok: true } });
    expect(html).toMatch(/<span class="cap-status" data-tone="ok">[\s\S]*?Saved<\/span>/);
    expect(html).toMatch(/role="status"/);
    expect(html).not.toContain("cap-alert");
  });

  it("says Recova's failure line when the save fails", () => {
    const html = render({ actionData: { ok: false } });
    expect(html).toMatch(/<span class="cap-status" data-tone="crit">[\s\S]*?Failed to save\. Please try again\.<\/span>/);
    expect(text(html)).not.toContain("Saved");
  });
});

describe("J38 features: the look comes from Capsomer and the tokens", () => {
  it("has no amber and no hand-sized text", () => {
    expect(CODE).not.toMatch(/amber/i);
    expect(CODE).not.toMatch(/text-\[/);
  });

  it("styles no Capsomer component with Foxhound classes of its own", () => {
    for (const m of CODE.matchAll(/className="(cap-[^"]*)"/g)) {
      for (const cls of m[1].split(/\s+/)) expect(cls).toMatch(/^cap-/);
    }
  });

  it("uses no Foxhound auth-ui part where Capsomer has one", () => {
    expect(CODE).not.toContain("~/components/auth-ui");
  });

  it("loads each Capsomer stylesheet it uses", () => {
    for (const css of ["page-head", "panel", "switch", "button", "status"]) {
      expect(SOURCE).toContain(`import "capsomer/${css}.css";`);
    }
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
