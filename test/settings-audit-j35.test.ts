import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { accounts } from "~/db/schema";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J35 (job_9ad6ef3e08f6), row S30, under Dustin's Q10 and Q11 rulings of
// 2026-10-14: /settings/audit is Recova's page (app/(app)/settings/audit/page.tsx
// at blob 18e6a384, AuditForm.tsx at 5bf81c10, settings/components/AuditSection.tsx
// at 58c5abce, components/Toggle.tsx at 0ebdd395, and settings/SaveBar.tsx at
// f1d6eb23) built from Capsomer 0.9.0's components, teal throughout. Recova stays
// the spec for every section, label and control and their order; the page keeps
// the settings layout's 800px column.
//
// The NULL-is-off reads, the server clamp and the no-DEFAULT guard stay in
// settings-audit-315.test.ts; the lookback's reader is proven in
// audit-lookback-reader-j35.test.ts.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const route = await import("~/routes/app/settings/audit");

const SOURCE = readFileSync(new URL("../app/routes/app/settings/audit.tsx", import.meta.url), "utf8");
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const Page = route.default as unknown as (props: {
  loaderData: { lookbackDays: number; autoRun: boolean };
  actionData?: Record<string, unknown>;
}) => ReactElement;

function render(
  opts: { lookbackDays?: number; autoRun?: boolean; actionData?: Record<string, unknown> } = {},
): string {
  const loaderData = { lookbackDays: opts.lookbackDays ?? 90, autoRun: opts.autoRun ?? false };
  const Stub = createRoutesStub([
    {
      path: "/settings/audit",
      Component: () => createElement(Page, { loaderData, actionData: opts.actionData }),
    },
  ]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/settings/audit"] }));
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** The lookback radios in document order, read whatever order React writes
 *  their attributes in. */
function lookbackRadios(html: string): Array<{ value: string; checked: boolean }> {
  return [...html.matchAll(/<input[^>]*type="radio"[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => tag.includes('name="audit_lookback_days"'))
    .map((tag) => ({ value: tag.match(/value="([^"]*)"/)?.[1] ?? "", checked: /\schecked/.test(tag) }));
}

describe("J35 audit settings: the page head", () => {
  it("is Capsomer's PageHead with Recova's title and subtitle", () => {
    const html = render();
    expect(html).toMatch(/<header class="cap-page-head">[\s\S]*<h1 class="cap-page-head-title">Audit<\/h1>/);
    expect(html).toContain(
      '<p class="cap-page-head-lead">Lookback period and monthly digest options.</p>',
    );
  });

  it("opens with Recova's phone-only back link to the settings hub, before the heading", () => {
    const html = render();
    const link = html.match(/<a[^>]*href="\/settings"[^>]*>[\s\S]*?<\/a>/)?.[0] ?? "";
    expect(link).toContain("md:hidden");
    expect(text(link)).toBe("Settings");
    expect(html.indexOf('href="/settings"')).toBeLessThan(html.indexOf("cap-page-head-title"));
  });

  it("sits in the settings layout's 800px column with no width or padding of its own", () => {
    const html = render();
    expect(html).not.toContain("max-w-[1000px]");
    expect(html).not.toMatch(/class="mx-auto/);
    expect(html).not.toContain("px-8 py-10");
  });
});

describe("J35 audit settings: the one card, on Capsomer's panel", () => {
  it("is a Capsomer panel, not a hand-built card", () => {
    const html = render();
    expect(html).toMatch(/<div class="cap-panel">\s*<div class="cap-panel-body">/);
    expect(CODE).not.toContain("rounded-[12px]");
  });

  it("puts Lookback period before Monthly audit digest, as Recova does", () => {
    const t = text(render());
    expect(t.indexOf("Lookback period")).toBeGreaterThan(-1);
    expect(t.indexOf("Lookback period")).toBeLessThan(t.indexOf("Monthly audit digest"));
  });
});

describe("J35 audit settings: the lookback period", () => {
  it("is Capsomer's segmented control posting audit_lookback_days, in Recova's four options", () => {
    const html = render();
    expect(html).toMatch(/<fieldset class="cap-seg"/);
    const radios = lookbackRadios(html).map((r) => r.value);
    expect(radios).toEqual(["30", "60", "90", "180"]);
    const labels = [...html.matchAll(/<label><input[^>]*\/?>\s*([^<]+)<\/label>/g)].map((m) => m[1].trim());
    expect(labels).toEqual(["30 days", "60 days", "90 days", "180 days"]);
  });

  it("checks the stored choice and no other", () => {
    const html = render({ lookbackDays: 180 });
    const checked = lookbackRadios(html).filter((r) => r.checked).map((r) => r.value);
    expect(checked).toEqual(["180"]);
  });

  it("shows Recova's label and helper in Recova's order, and the group is described by the helper", () => {
    const html = render();
    const t = text(html);
    const helper = "How far back we look when calculating your audit.";
    expect(t.indexOf("Lookback period")).toBeLessThan(t.indexOf(helper));
    expect(html.indexOf(helper)).toBeLessThan(html.indexOf('value="30"'));
    const helperId = html.match(new RegExp(`<p[^>]*id="([^"]+)"[^>]*>${helper}`))?.[1];
    expect(helperId).toBeTruthy();
    expect(html).toContain(`<fieldset class="cap-seg" aria-describedby="${helperId}">`);
    // The group keeps its name for a screen reader through Capsomer's legend.
    // The legend is visually hidden by a class the merchant app has (Tailwind's
    // sr-only), not by Capsomer's .cap-sr-only, which needs capsomer/base.css.
    expect(html).toMatch(/<legend><span class="sr-only">Lookback period<\/span><\/legend>/);
  });
});

describe("J35 audit settings: the monthly digest", () => {
  it("is Capsomer's switch named for the digest, posting audit_auto_run=true when on", () => {
    const html = render({ autoRun: true });
    const sw = html.match(/<label class="cap-switch">[\s\S]*?<\/label>/)?.[0] ?? "";
    expect(sw).toBeTruthy();
    const input = sw.match(/<input[^>]*>/)?.[0] ?? "";
    expect(input).toContain('role="switch"');
    expect(input).toContain('name="audit_auto_run"');
    expect(input).toContain('value="true"');
    expect(input).toContain("checked");
    expect(text(sw)).toContain("Monthly audit digest");
  });

  it("is unchecked when the stored digest is off", () => {
    const html = render({ autoRun: false });
    const input = html.match(/<label class="cap-switch">[\s\S]*?<input[^>]*>/)?.[0] ?? "";
    expect(input).not.toMatch(/\schecked/);
  });

  it("carries Recova's description without the AI clause, and the switch is described by it", () => {
    const html = render();
    const description =
      "On the 1st of each month, we run a fresh audit and email you a comparison versus the prior month. No extra charge.";
    expect(text(html)).toContain(description);
    expect(CODE).not.toContain("written by AI");
    const id = html.match(new RegExp(`<p[^>]*id="([^"]+)"[^>]*>${description}`))?.[1];
    expect(id).toBeTruthy();
    const input = html.match(/<input[^>]*role="switch"[^>]*>/)?.[0] ?? "";
    expect(input).toContain(`aria-describedby="${id}"`);
  });

  it("drops the hand-ported Toggle for Capsomer's", () => {
    expect(CODE).not.toContain("function Toggle");
    expect(CODE).not.toContain("translateX(16px)");
  });
});

describe("J35 audit settings: Recova's save bar", () => {
  it("is a right-aligned row holding Capsomer's primary Save changes button", () => {
    const html = render();
    const bar = html.match(/<div class="[^"]*justify-end[^"]*">[\s\S]*?Save changes<\/button>/)?.[0] ?? "";
    expect(bar).toBeTruthy();
    const button = bar.match(/<button[^>]*>[\s\S]*?Save changes<\/button>/)?.[0] ?? "";
    expect(button).toContain('type="submit"');
    expect(button).toContain('class="cap-btn"');
    expect(button).toContain('data-variant="primary"');
    expect(text(html)).not.toMatch(/\bSave\b(?! changes)/);
  });

  it("says Saved beside the button after a save, as a status, with no banner", () => {
    const html = render({ actionData: { ok: true, lookbackDays: 90, autoRun: false } });
    const bar = html.match(/<div class="[^"]*justify-end[^"]*">[\s\S]*?Save changes<\/button>/)?.[0] ?? "";
    expect(bar).toMatch(/<span role="status"[^>]*>Saved<\/span>/);
    expect(html).not.toContain("Saved.");
  });

  it("says Recova's failure sentence when the save is refused", () => {
    const html = render({ actionData: { ok: false, error: "x" } });
    expect(text(html)).toContain("Failed to save. Please try again.");
    expect(text(html)).not.toMatch(/\bSaved\b/);
  });

  it("says nothing before a save", () => {
    const t = text(render());
    expect(t).not.toMatch(/\bSaved\b/);
    expect(t).not.toContain("Failed to save");
  });
});

describe("J35 audit settings: look", () => {
  it("has no amber anywhere on the page (Q11)", () => {
    expect(SOURCE.toLowerCase()).not.toContain("amber");
  });

  it("uses no hand-rolled text size (RULES.md 5.2)", () => {
    expect(CODE).not.toMatch(/text-\[/);
  });

  it("adds no Foxhound class over a Capsomer component", () => {
    const html = render({ autoRun: true });
    for (const tag of html.matchAll(/class="(cap-[^"]*)"/g)) {
      for (const cls of tag[1].split(/\s+/)) expect(cls.startsWith("cap-"), cls).toBe(true);
    }
  });
});

describe("J35 audit settings: the switch off posts nothing, and nothing is off", () => {
  it("a form with no audit_auto_run writes false through the real action", async () => {
    const { db } = createInMemoryDb();
    harness.db = db;
    await db.insert(accounts).values({ id: "acct_j35", name: "Acme", createdAt: new Date(), auditAutoRun: true });
    const body = new FormData();
    body.append("audit_lookback_days", "60");
    const ctx = {
      get: (key: unknown) => {
        const name = String((key as { name?: string })?.name ?? "");
        if (name.includes("cloudflare")) return { env: {} as Env };
        return { membership: { accountId: "acct_j35" } };
      },
    } as never;
    await route.action({ request: new Request("http://x/settings/audit", { method: "POST", body }), context: ctx } as never);
    const rows = await db.select().from(accounts);
    expect(rows[0].auditAutoRun).toBe(false);
    expect(rows[0].auditLookbackDays).toBe(60);
  });
});

describe("J35 review: a write that throws reaches the merchant and the log", () => {
  it("the real action catches it, logs the Error, answers 500 and the page says Recova's failure line", async () => {
    const { db } = createInMemoryDb();
    const boom = new Error("D1_ERROR: database is locked");
    harness.db = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "batch") return async () => { throw boom; };
        return Reflect.get(target, prop, receiver);
      },
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const body = new FormData();
      body.append("audit_lookback_days", "60");
      body.append("audit_auto_run", "true");
      const ctx = {
        get: (key: unknown) => {
          const name = String((key as { name?: string })?.name ?? "");
          if (name.includes("cloudflare")) return { env: {} as Env };
          return { membership: { accountId: "acct_j35" } };
        },
      } as never;
      const result = (await route.action({
        request: new Request("http://x/settings/audit", { method: "POST", body }),
        context: ctx,
      } as never)) as unknown as { data: Record<string, unknown>; init: { status?: number } };

      expect(logged).toHaveBeenCalledWith("audit settings write failed:", boom);
      expect(result.init?.status).toBe(500);
      expect(result.data.ok).toBe(false);

      const html = render({ actionData: result.data });
      expect(text(html)).toContain("Failed to save. Please try again.");
      expect(html).toMatch(/<span role="alert"[^>]*>Failed to save\. Please try again\.<\/span>/);
    } finally {
      logged.mockRestore();
    }
  });
});
