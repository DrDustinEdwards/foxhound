import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import Help, { QUICK_ANSWERS } from "~/routes/app/help";
import type { CronStatusRow } from "~/lib/help/platform-status.server";

// J13 (job_9704235b018b), Dustin's Q10 ruling of 2026-10-14: /help's contents
// are built from Capsomer's components at the release Foxhound pins (0.9.0),
// never hand-rolled Tailwind copies of a shared component. Content, sections,
// order and width stay legacy's and are pinned in help-sections-399.test.ts;
// this file pins the components and the accessibility they bring.
//
// Every assertion here was seen failing against the hand-rolled page before
// the rebuild (red output kept with the job).

const Page = Help as unknown as (props: {
  loaderData: { crons: CronStatusRow[]; nowMs: number };
}) => ReactElement;

const NOW = Date.UTC(2026, 7, 29, 12, 0, 0);

const crons: CronStatusRow[] = [
  { cronName: "recovery-tick", label: "Recovery sequences", status: "ok", lastSucceededAt: new Date(NOW - 4 * 60_000) },
  { cronName: "winback-send", label: "Win-back sequences", status: "stale", lastSucceededAt: new Date(NOW - 5 * 3_600_000) },
  { cronName: "expiring-cards", label: "Expiring card alerts", status: "error", lastSucceededAt: new Date(NOW - 2 * 86_400_000) },
  { cronName: "intelligence-ai", label: "Customer health scoring", status: "pending", lastSucceededAt: null },
];

function render(): string {
  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(Page, { loaderData: { crons, nowMs: NOW } })),
  );
}

const SOURCE = readFileSync(new URL("../app/routes/app/help.tsx", import.meta.url), "utf8");

/** The table row that holds a cron's label, or "" when there is none. */
function rowFor(html: string, label: string): string {
  const rows = html.match(/<tr[\s\S]*?<\/tr>/g) ?? [];
  return rows.find((r) => r.includes(label)) ?? "";
}

describe("J13 /help: landmarks", () => {
  it("renders no <main> of its own, since the shell's is the page's one main (ruling 146)", () => {
    expect(render()).not.toMatch(/<main[\s>]/);
  });
});

describe("J13 /help: the page head is Capsomer's PageHead", () => {
  it("puts the h1 and the subtitle in cap-page-head", () => {
    const html = render();
    expect(html).toMatch(/<header class="cap-page-head">[\s\S]*<h1 class="cap-page-head-title">Help<\/h1>/);
    expect(html).toContain('<p class="cap-page-head-lead">Quick answers, guides, and platform status.</p>');
  });
});

describe("J13 /help: heading order", () => {
  it("is one h1, then the four section h2s in legacy's order, with no level skipped", () => {
    const html = render();
    const headings = [...html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => ({
      level: Number(m[1]),
      text: m[2].replace(/<[^>]+>/g, ""),
    }));
    expect(headings[0]).toEqual({ level: 1, text: "Help" });
    expect(headings.filter((h) => h.level === 1)).toHaveLength(1);
    expect(headings.filter((h) => h.level === 2).map((h) => h.text)).toEqual([
      "Common questions",
      "Guides",
      "Platform status",
      "Contact",
    ]);
    for (let i = 1; i < headings.length; i++) {
      expect(headings[i].level - headings[i - 1].level).toBeLessThanOrEqual(1);
    }
    // The six questions are h3s, and so are the two status panels' titles.
    const h3 = headings.filter((h) => h.level === 3).map((h) => h.text);
    expect(h3).toEqual(expect.arrayContaining(["Background jobs", "MCP connectors"]));
    expect(h3.length).toBeGreaterThanOrEqual(QUICK_ANSWERS.length + 2);
  });
});

describe("J13 /help: Guides are Capsomer panels titled by their link", () => {
  // Recova is the spec for content, so each guide's description must show in
  // full. Capsomer's row-list cuts its detail line with an ellipsis, so each
  // guide is a Panel whose h3 title is the guide link, the description in the
  // body, where it wraps (the Contact pattern).
  const GUIDES: [string, string, string][] = [
    ["platform", "Platform", "Connecting Stripe, settings, team management, and billing"],
    ["audit", "Audit", "Free Stripe diagnostic, six scopes"],
    ["recovery", "Recovery", "Sequences, payments, dashboard, troubleshooting"],
    ["disputes", "Disputes", "Evidence building, triage, submission"],
    ["intelligence", "Intelligence", "Health scores, churn risk, MRR trends"],
  ];

  it("renders each guide as a cap-panel with the guide link as its h3 and the description in its body", () => {
    const html = render();
    for (const [slug, title, desc] of GUIDES) {
      expect(html, slug).toMatch(
        new RegExp(
          `<section class="cap-panel"><header class="cap-panel-head"><h3><a [^>]*href="/docs/${slug}"[^>]*>${title}</a></h3></header><div class="cap-panel-body">${desc}</div></section>`,
        ),
      );
    }
  });

  it("uses no row-list, whose detail line would cut the description", () => {
    expect(render()).not.toContain("cap-row");
    expect(SOURCE).not.toContain("capsomer/react/row-list");
    expect(SOURCE).not.toContain("capsomer/row-list.css");
  });

  it("keeps Platform full width above a two-column grid of the four products", () => {
    const html = render();
    const platform = html.indexOf('href="/docs/platform"');
    const grid = html.indexOf('<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">');
    expect(platform).toBeGreaterThan(-1);
    expect(grid).toBeGreaterThan(platform);
    for (const slug of ["audit", "recovery", "disputes", "intelligence"]) {
      expect(html.indexOf(`href="/docs/${slug}"`)).toBeGreaterThan(grid);
    }
  });

  it("keeps no hand-rolled card or hover class in the source", () => {
    expect(SOURCE).not.toContain("hover:border-brand");
    expect(SOURCE).not.toMatch(/className="[^"]*rounded-lg border border-border/);
  });
});

describe("J13 /help: Platform status uses Capsomer Panel, Table and Status", () => {
  it("draws Background jobs and MCP connectors as Capsomer panels with h3 titles", () => {
    const html = render();
    for (const title of ["Background jobs", "MCP connectors"]) {
      expect(html).toMatch(
        new RegExp(`<section class="cap-panel"[^>]*><header class="cap-panel-head"><h3[^>]*>${title}</h3>`),
      );
    }
  });

  it("puts each list in a Capsomer table inside a focusable region named by its panel heading", () => {
    const html = render();
    for (const [id, name] of [
      ["help-background-jobs", "Background jobs"],
      ["help-mcp-connectors", "MCP connectors"],
    ]) {
      expect(html).toContain(`<h3 id="${id}">${name}</h3>`);
      expect(html).toContain(
        `<div class="cap-table-wrap" data-cap="table" role="region" aria-labelledby="${id}" tabindex="0"><table class="cap-table">`,
      );
    }
  });

  it("names every column for assistive tech without showing a header row legacy never had", () => {
    const html = render();
    for (const cols of [
      ["Job", "Last succeeded", "Status"],
      ["Connector", "Tools", "Status"],
    ]) {
      expect(html).toContain(
        `<thead class="sr-only"><tr>${cols.map((c) => `<th scope="col">${c}</th>`).join("")}</tr></thead>`,
      );
    }
  });

  it("marks no prose cell as a number (data-num is for figures only)", () => {
    expect(render()).not.toContain("data-num");
  });

  it("names each cron in a row header and says its status in words through Capsomer Status", () => {
    const html = render();
    const expected: Record<CronStatusRow["status"], { tone: string; word: string }> = {
      ok: { tone: "ok", word: "OK" },
      stale: { tone: "warn", word: "Stale" },
      error: { tone: "crit", word: "Error" },
      pending: { tone: "nodata", word: "Pending" },
    };
    for (const cron of crons) {
      const row = rowFor(html, cron.label);
      expect(row, cron.label).toContain(`<th scope="row">${cron.label}</th>`);
      const { tone, word } = expected[cron.status];
      // The word is the accessible text; the glyph inside is aria-hidden.
      expect(row).toMatch(
        new RegExp(`<span class="cap-status" data-tone="${tone}"><svg class="cap-status-glyph"[^>]*aria-hidden="true"[\\s\\S]*?</svg>${word}</span>`),
      );
    }
  });

  it("puts no aria-label on a generic element (the old StatusDot's defect)", () => {
    // aria-label is prohibited on a div or span with no role. The table's
    // scroll region carries one, which is allowed because it is role="region".
    const generic = (render().match(/<(div|span)\s[^>]*>/g) ?? []).filter(
      (tag) => /\saria-label=/.test(tag) && !/\srole="/.test(tag),
    );
    expect(generic).toEqual([]);
  });

  it("keeps the connector's green mark decorative: a Capsomer ok glyph hidden from assistive tech", () => {
    const row = rowFor(render(), "Foxhound Merchant");
    expect(row).toContain('<th scope="row">Foxhound Merchant');
    expect(row).toMatch(/<span aria-hidden="true"><span class="cap-status" data-tone="ok"><svg class="cap-status-glyph"[\s\S]*?<\/svg><\/span><\/span>/);
  });
});

describe("J13 /help: Contact is a Capsomer panel", () => {
  it("titles the panel with the mailto link and keeps the sentence in its body", () => {
    const html = render();
    expect(html).toMatch(
      /<section class="cap-panel"><header class="cap-panel-head"><h3[^>]*><a href="mailto:support@foxhoundapp.com"[^>]*>support@foxhoundapp.com<\/a><\/h3><\/header><div class="cap-panel-body">[^<]*Responses within 24 hours on business days\./,
    );
  });
});
