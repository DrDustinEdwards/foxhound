import { readFileSync } from "node:fs";
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
// blob 64d4a153) built from Capsomer 0.9.0's components, teal throughout.
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

const SOURCE = readFileSync(new URL("../app/routes/app/settings/brand-voice.tsx", import.meta.url), "utf8");
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const Page = route.default as unknown as (props: {
  loaderData: Record<string, unknown>;
  actionData?: Record<string, unknown>;
}) => ReactElement;

type Stored = Partial<Record<"soft" | "expired" | "network" | "fraud", string | null>>;

function render(opts: { stored?: Stored; actionData?: Record<string, unknown> } = {}): string {
  const loaderData = {
    connectionId: "conn_1",
    stored: { soft: null, expired: null, network: null, fraud: null, ...opts.stored },
  };
  const Stub = createRoutesStub([
    {
      path: "/settings/brand-voice",
      Component: () => createElement(Page, { loaderData, actionData: opts.actionData }),
    },
  ]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/settings/brand-voice"] }));
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function attr(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
}

function selects(html: string): string[] {
  return [...html.matchAll(/<select[^>]*>[\s\S]*?<\/select>/g)].map((m) => m[0]);
}

const LABELS = ["Soft declines", "Expired card", "Network declines", "Fraud / hard declines"];
const HELP = [
  "Insufficient funds, temporary holds. Most common, highest recovery rate.",
  "Card expired. Customer needs to update their payment method.",
  "Bank or processor errors. Often resolves on retry without customer action.",
  "Card flagged or blocked. Sensitive situation, handle carefully.",
];
const INTRO =
  "Set a different tone for each failure category. The AI will use the matching voice when writing recovery emails.";

describe("J36 brand voice: the page head", () => {
  it("is Capsomer's PageHead with Recova's title and line", () => {
    const html = render();
    expect(html).toMatch(/<header class="cap-page-head">[\s\S]*<h1 class="cap-page-head-title">Brand voice<\/h1>/);
    expect(html).toMatch(
      /<p class="cap-page-head-lead">Set a different tone for each failure category\. The AI uses the matching voice when writing recovery emails\.<\/p>/,
    );
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

describe("J36 brand voice: the card", () => {
  it("is one Capsomer panel opening with Recova's line, then the four categories in order", () => {
    const html = render();
    expect((html.match(/<section class="cap-panel">/g) ?? []).length).toBe(1);
    const panel = text(html.match(/<section class="cap-panel">[\s\S]*?<\/section>/)?.[0] ?? "");
    expect(panel.startsWith(INTRO)).toBe(true);
    let at = panel.indexOf(INTRO);
    for (let i = 0; i < LABELS.length; i++) {
      const label = panel.indexOf(LABELS[i], at);
      expect(label).toBeGreaterThan(at);
      const help = panel.indexOf(HELP[i], label);
      expect(help).toBeGreaterThan(label);
      at = help;
    }
  });

  it("has no general brand voice field, which Recova's page never had", () => {
    const html = render();
    expect(html).not.toContain('name="brandVoice"');
    expect(html).not.toContain('id="brandVoice"');
    expect(text(html)).not.toContain("Every recovery email is written in this voice");
    expect(html).not.toContain("<textarea");
  });

  it("marks each category's coloured dot as decoration, with no amber", () => {
    const html = render();
    const dots = [...html.matchAll(/<span[^>]*rounded-full[^>]*><\/span>/g)].map((m) => m[0]);
    expect(dots).toHaveLength(4);
    for (const d of dots) expect(d).toContain('aria-hidden="true"');
    expect(html).not.toMatch(/amber/i);
  });
});

describe("J36 brand voice: each category's picker", () => {
  it("is Capsomer's select, named as in Recova and described by its help line", () => {
    const html = render();
    const all = selects(html);
    expect(all).toHaveLength(4);
    expect((html.match(/class="cap-select-wrap"/g) ?? []).length).toBe(4);
    all.forEach((s, i) => {
      expect(s).toContain('class="cap-select"');
      expect(attr(s, "aria-label")).toBe(`Brand voice preset for ${LABELS[i]}`);
      const described = attr(s, "aria-describedby") ?? "none";
      const help = html.match(new RegExp(`<[^>]*\\sid="${described}"[^>]*>([^<]*)<`))?.[1];
      expect(help).toBe(HELP[i]);
    });
  });

  it("lists Recova's options in Recova's order, with Recova's labels", () => {
    const first = selects(render())[0];
    const options = [...first.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);
    expect(options).toEqual([
      ["", "Same as main voice"],
      ["friendly and conversational", "Friendly and conversational"],
      ["reassuring and low-pressure", "Reassuring and low-pressure"],
      ["professional and formal", "Professional and formal"],
      ["direct and no-nonsense", "Direct and no-nonsense"],
      ["concise and minimal", "Concise and minimal"],
      ["personal and founder-led", "Personal and founder-led"],
      ["helpful and educational", "Helpful and educational"],
      ["custom", "Custom..."],
    ]);
  });

  it("shows a stored preset as chosen and posts it in the category's hidden field", () => {
    const html = render({ stored: { network: "direct and no-nonsense" } });
    const network = selects(html)[2];
    expect(network).toMatch(/<option value="direct and no-nonsense" selected="">/);
    expect(html).toMatch(/<input type="hidden" name="voice_network" value="direct and no-nonsense"\/>/);
    expect(html).toMatch(/<input type="hidden" name="voice_soft" value=""\/>/);
  });

  it("opens Recova's custom box, a Capsomer input, for a stored voice that is no preset", () => {
    const html = render({ stored: { fraud: "calm and careful" } });
    const areas = [...html.matchAll(/<textarea[^>]*>[\s\S]*?<\/textarea>/g)].map((m) => m[0]);
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

describe("J36 brand voice: Recova's save bar", () => {
  it("has Save changes as the primary submit, after the card, inside the form", () => {
    const html = render();
    const submit = html.match(/<button[^>]*type="submit"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";
    expect(text(submit)).toBe("Save changes");
    expect(submit).toContain('class="cap-btn"');
    expect(submit).toContain('data-variant="primary"');
    expect(html.indexOf(submit)).toBeGreaterThan(html.indexOf("Fraud / hard declines"));
    const form = html.match(/<form[\s\S]*<\/form>/)?.[0] ?? "";
    expect(form).toContain(submit);
    expect(form).toContain('name="voice_soft"');
    expect(form).toContain('name="connectionId"');
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

  it("says Recova's failure line when the write throws", () => {
    const html = render({ actionData: { ok: false } });
    expect(html).toMatch(/<span class="cap-status" data-tone="crit">[\s\S]*?Failed to save\. Please try again\.<\/span>/);
    expect(text(html)).not.toContain("Saved");
  });

  it("says the refusal's own sentence when the write is refused", () => {
    const html = render({ actionData: { ok: false, error: "Connect Stripe before setting a brand voice." } });
    expect(html).toMatch(
      /<span class="cap-status" data-tone="crit">[\s\S]*?Connect Stripe before setting a brand voice\.<\/span>/,
    );
    expect(text(html)).not.toContain("Please try again");
  });
});

describe("J36 brand voice: the look comes from Capsomer and the tokens", () => {
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
    for (const css of ["page-head", "panel", "field", "select", "button", "status"]) {
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
