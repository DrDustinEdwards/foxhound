// The five docs guides behind /docs/:slug. Every sentence is true of Foxhound's engine and its built settings pages. Where
// Foxhound has not built what a heading describes, the Part says so, and H3s whose whole content was that feature are cut.
// Figures come from the engine's constants, not retyped: the fee, the cap, the windows, the bands and the schedules.
import type { DocWidgetName } from "~/components/docs/doc-widgets";
import { PLATFORM_GUIDE } from "~/lib/marketing/docs-platform";
import { AUDIT_GUIDE } from "~/lib/marketing/docs-audit";
import { RECOVERY_GUIDE } from "~/lib/marketing/docs-recovery";
import { DISPUTES_GUIDE } from "~/lib/marketing/docs-disputes";
import { INTELLIGENCE_GUIDE } from "~/lib/marketing/docs-intelligence";

// The block vocabulary. A plain string is a paragraph; anything richer is a tagged object, so the two forms cannot be confused.
// Inline: Strong, Code, RelLink, a bare font-mono span, and a HealthScoreBadge in the intelligence thresholds paragraph. Block:
// H3, Note, Tip, Steps, List and a reference table.

export type DocInline =
  | string
  | { code: string }
  | { strong: string }
  | { mono: string }
  | { badge: number }
  | { link: string; to: string };

export type DocRich = string | DocInline[];

export type DocBlock =
  | string
  | { kind: "p"; body: DocInline[] }
  | { kind: "h3"; text: string }
  | { kind: "note"; body: DocRich }
  | { kind: "tip"; body: DocRich }
  | { kind: "steps"; items: DocRich[] }
  | { kind: "list"; items: DocRich[] }
  | { kind: "table"; label: string; columns: string[]; rows: DocRich[][] }
  | { kind: "widget"; name: DocWidgetName };

export interface DocGuide {
  slug: string;
  title: string;
  description: string;
  /** The page's h1. */
  heading: string;
  /** ISO date the guide first shipped, for the TechArticle JSON-LD (measured from git: commit `5478d6b`). There is no
   *  `dateModified`: the content module tracks no per-guide revision and the Worker has no git at runtime. */
  datePublished: string;
  sections: { heading: string; body: DocBlock[] }[];
}

const DOCS_FIRST_PUBLISHED = "2026-07-19";

export const DOC_GUIDES: DocGuide[] = [
  PLATFORM_GUIDE,
  AUDIT_GUIDE,
  RECOVERY_GUIDE,
  DISPUTES_GUIDE,
  INTELLIGENCE_GUIDE,
].map((g) => ({ ...g, datePublished: DOCS_FIRST_PUBLISHED }));

export function getDocGuide(slug: string): DocGuide | undefined {
  return DOC_GUIDES.find((g) => g.slug === slug);
}
