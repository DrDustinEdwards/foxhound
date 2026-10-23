import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { DocWidget } from "~/components/docs/doc-widgets";
import { HealthScoreBadge } from "~/components/docs/health-score-badge";
import {
  AUDIT_LOOKBACK_DAYS,
  HEALTH_SCORE_AT_RISK_THRESHOLD,
} from "~/lib/constants";
import { DEADLINE_SOON_DAYS, DEADLINE_URGENT_DAYS } from "~/lib/disputes/labels";
import { WATCH_CEILING } from "~/lib/intelligence/health-band";
import { DOC_GUIDES, type DocBlock, type DocInline } from "~/lib/marketing/docs-content";
import { classifyDecline } from "~/lib/recovery/decline";
import { DECLINE_CATEGORY_LABELS } from "~/lib/recovery/labels";

// J73, row M18: the five guides carry Recova's Part structure, with every claim
// true of Foxhound's engine, on Capsomer's components.
//
// THE SPEC IS RECOVA'S SOURCE, read whole at these blobs through Capsid's repo
// "legacy": app/(marketing)/docs/platform/page.tsx 2b69517b, audit 3b1153b4,
// recovery 6166a6be, disputes 598fcbaa, intelligence e7f18266. The Part lists
// below are their TOC arrays, word for word, with "Recova" read as "Foxhound"
// (branding, RULES.md 1.2). The H3 lists are their H3 children in order.

const ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, ROOT)), "utf8");

function inlineText(node: DocInline): string {
  if (typeof node === "string") return node;
  if ("code" in node) return node.code;
  if ("strong" in node) return node.strong;
  if ("mono" in node) return node.mono;
  if ("badge" in node) return String(node.badge);
  return node.link;
}
const rich = (r: string | DocInline[]): string => (typeof r === "string" ? r : r.map(inlineText).join(""));

function blockText(b: DocBlock): string {
  if (typeof b === "string") return b;
  switch (b.kind) {
    case "p":
      return rich(b.body);
    case "h3":
      return b.text;
    case "note":
    case "tip":
      return rich(b.body);
    case "steps":
    case "list":
      return b.items.map(rich).join("\n");
    case "table":
      return [...b.columns, ...b.rows.flat().map(rich)].join("\n");
    case "widget":
      return "";
  }
}

const guide = (slug: string) => DOC_GUIDES.find((g) => g.slug === slug)!;
const textOf = (slug: string) =>
  guide(slug)
    .sections.map((s) => [s.heading, ...s.body.map(blockText)].join("\n"))
    .join("\n");


// Recova's H3s, in order, MINUS the ones cut because the feature they describe
// does not exist in Foxhound. Each cut is named with its reason, so a cut is a
// decision in this file and never a silent omission.

describe("J73 PLANT 2: every claim is Foxhound's engine, not Recova's", () => {

  it("RECOVERY: every decline code the guide names classifies into the category it is shown under", () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(DocWidget, { name: "decline-categories" })));
    for (const [category, label] of Object.entries(DECLINE_CATEGORY_LABELS)) {
      const start = html.indexOf(`data-category="${category}"`);
      expect(start, `${label} card`).toBeGreaterThanOrEqual(0);
      const end = html.indexOf("data-category=", start + 1);
      const card = html.slice(start, end === -1 ? undefined : end);
      const codes = [...card.matchAll(/<code[^>]*>([a-z_]+)<\/code>/g)].map((m) => m[1]!);
      if (category !== "unknown") expect(codes.length, `${category} names codes`).toBeGreaterThan(0);
      for (const code of codes) expect(classifyDecline(code), code).toBe(category);
    }
  });

  it("DISPUTES: the deadline bands are the dashboard's constants, and no reminder email is promised", () => {
    const text = textOf("disputes");
    expect(text).toContain(`${DEADLINE_URGENT_DAYS} days or fewer`);
    expect(text).toContain(`${DEADLINE_SOON_DAYS} days or fewer`);
    expect(text).not.toMatch(/reminder emails at/i);
  });

  it("INTELLIGENCE: the thresholds are healthScoreBand's, and the badges agree", () => {
    const text = textOf("intelligence");
    expect(text).toContain(`below ${HEALTH_SCORE_AT_RISK_THRESHOLD}`);
    expect(text).toContain(`${WATCH_CEILING} and above`);
    expect(text).not.toMatch(/34-66|67-100|0-33/);
    const pill = (score: number) => renderToStaticMarkup(createElement(HealthScoreBadge, { score }));
    expect(pill(HEALTH_SCORE_AT_RISK_THRESHOLD - 2)).toContain('data-tone="crit"');
    expect(pill(HEALTH_SCORE_AT_RISK_THRESHOLD)).toContain('data-tone="warn"');
    expect(pill(WATCH_CEILING)).toContain('data-tone="ok"');
  });

  it("AUDIT: the anonymous lookback is the engine's constant", () => {
    expect(textOf("audit")).toContain(`${AUDIT_LOOKBACK_DAYS} days`);
    expect(textOf("audit")).not.toMatch(/30%/);
  });

  it("every in-guide link points at a route Foxhound serves", () => {
    const routes = read("app/routes.ts");
    const links = DOC_GUIDES.flatMap((g) => g.sections)
      .flatMap((s) => s.body)
      .flatMap((b) => {
        if (typeof b === "string") return [];
        const runs: (string | DocInline[])[] =
          b.kind === "p" ? [b.body] : b.kind === "note" || b.kind === "tip" ? [b.body] : b.kind === "steps" || b.kind === "list" ? b.items : b.kind === "table" ? b.rows.flat() : [];
        return runs.flatMap((r) => (typeof r === "string" ? [] : r.flatMap((n) => (typeof n !== "string" && "to" in n ? [n.to] : []))));
      });
    expect(links.length).toBeGreaterThan(3);
    for (const to of links.filter((l) => l.startsWith("/"))) {
      const [first, ...rest] = to.slice(1).split("/");
      const last = rest.at(-1) ?? first!;
      expect(routes, `${to} is not a route`).toContain(`"${to.startsWith("/docs/") ? ":slug" : last}"`);
    }
  });
});
