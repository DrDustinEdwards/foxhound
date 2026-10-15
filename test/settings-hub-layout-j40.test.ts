import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import SettingsLayout from "~/layouts/settings";
import SettingsHub, { SETTINGS_HUB_ENTRIES } from "~/routes/app/settings/hub";

// J40 (job_c697eea931bc), rows S24 and S25, under Dustin's Q10 and Q11 rulings
// of 2026-10-14: the settings hub and its sub-menu, Recova's content and
// arrangement (app/(app)/settings/page.tsx blob 55b1445a, SettingsSidebar.tsx
// blob e1a283ec, layout.tsx blob 606c1733) on Capsomer 0.9.0, teal throughout.
// Every assertion here was seen failing before the change it pins.

const Hub = SettingsHub as unknown as (props: { loaderData: Record<string, unknown> }) => ReactElement;

const LOADED = {
  connectionCount: 1,
  firstStripeUserId: "acct_sample",
  activeSequences: 4,
  openDisputes: 2,
};

/** The layout with the hub inside it, at `path`, as the router renders it. */
function render(path = "/settings", loaderData: Record<string, unknown> = LOADED): string {
  const Stub = createRoutesStub([
    {
      Component: SettingsLayout,
      children: [
        { path: "/settings", Component: () => createElement(Hub, { loaderData }) },
        { path: "/settings/email", Component: () => createElement("p", null, "Email page") },
      ],
    },
  ]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: [path] }));
}

function classesOf(html: string): string[] {
  return [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1]!.split(/\s+/));
}

const SIDEBAR = readFileSync(new URL("../app/components/settings-sidebar.tsx", import.meta.url), "utf8");
const HUB = readFileSync(new URL("../app/routes/app/settings/hub.tsx", import.meta.url), "utf8");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the settings layout adds no landmark the shell already has", () => {
  it("renders no <main>, because AdminShell's main already holds every app page (ruling 146)", () => {
    for (const path of ["/settings", "/settings/email"]) {
      const html = render(path);
      expect(html, `the page rendered at ${path}`).toContain("Settings navigation");
      expect(html.match(/<main\b/g) ?? [], `a second main at ${path}`).toHaveLength(0);
    }
  });
});

describe("the sub-menu follows the theme, as the shell's own menu does", () => {
  it("no chrome token, which is dark in both themes, on the layout or the sub-menu", () => {
    const chrome = classesOf(render("/settings/email")).filter((c) => /(^|:)(bg|text|border)-chrome/.test(c));
    expect(chrome).toEqual([]);
  });

  it("the current item is marked in teal (brand), never amber", () => {
    const html = render("/settings/email");
    const current = html.match(/<a[^>]*aria-current="page"[^>]*>/)?.[0] ?? "";
    expect(current).toContain('href="/settings/email"');
    expect(current).toContain("border-brand");
    expect(classesOf(html).filter((c) => c.includes("amber"))).toEqual([]);
  });

  it("group labels are Recova's medium-weight sans, not mono", () => {
    // Recova: text-[0.6875rem] font-medium uppercase tracking-widest, no font-mono.
    const html = render("/settings");
    const label = html.match(/<p class="([^"]*)">Recovery<\/p>/)?.[1] ?? "";
    expect(label).toContain("text-micro");
    expect(label).toContain("font-medium");
    expect(label).not.toContain("font-mono");
  });
});

describe("the hub's descriptions are true", () => {
  it("Email does not promise a sender domain, which is not built (RULES.md 5.6)", () => {
    const email = SETTINGS_HUB_ENTRIES.find((e) => e.to === "/settings/email");
    expect(email?.description).toBe("Sender name, reply-to");
  });

  it("My account does not promise an appearance control the page does not have (S-CLOSEOUT 5)", () => {
    const account = SETTINGS_HUB_ENTRIES.find((e) => e.to === "/settings/account");
    expect(account?.description).toBe("Profile, sign out");
  });
});

describe("the hub is built from Capsomer's parts, in Recova's arrangement", () => {
  it("the title and its line are Capsomer's page head", () => {
    const html = render();
    expect(html).toContain("cap-page-head");
    expect(html).toContain("Your account, integrations, and recovery configuration.");
  });

  it("the three figures are Capsomer stat tiles, each a link to Recova's destination", () => {
    const html = render();
    const tiles = [...html.matchAll(/<a[^>]*class="cap-tile"[^>]*>/g)].map((m) => m[0]);
    expect(tiles).toHaveLength(3);
    expect(tiles[0]).toContain('href="/settings/stripe"');
    // Recova links Active sequences to /recovery/dashboard, which Foxhound has
    // at the same path since J09.
    expect(tiles[1]).toContain('href="/recovery/dashboard"');
    expect(tiles[2]).toContain('href="/disputes/dashboard"');
  });

  it("every entry is a Capsomer row, in the phone list and in the desktop grid", () => {
    const html = render();
    for (const entry of SETTINGS_HUB_ENTRIES) {
      const rows = html.match(new RegExp(`<li class="cap-row"[^>]*>(?:(?!</li>).)*href="${entry.to}"`, "g")) ?? [];
      expect(rows, `${entry.label} as a row`).toHaveLength(2);
    }
  });

  it("keeps Recova's two columns on the desktop grid", () => {
    expect(render()).toMatch(/class="[^"]*sm:grid-cols-2[^"]*"/);
  });

  it("no hand-rolled card or text size outside the five", () => {
    const src = code(HUB);
    expect(src).not.toMatch(/rounded-(lg|xl|\[)/);
    expect(src).not.toMatch(/text-(caption|h2|\[)/);
    expect(code(SIDEBAR)).not.toMatch(/text-(caption|h2|\[)/);
  });
});
