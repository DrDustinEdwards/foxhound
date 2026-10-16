// The hand-made blog diagrams behind `:::diagram[slug]` (J25, row F23).
//
// Legacy lib/markdown.ts (blob 62a2e55c) read public/diagrams/<slug>.svg off
// local disk with node:fs at request time. A Worker has no such disk, so the
// same files are bundled into the server build here, read once as raw text by
// Vite. public/diagrams/ stays the one copy: the browser fetches
// /diagrams/<slug>.svg from it as a static asset, and the renderer inlines the
// same bytes. Only the top level is bundled; public/diagrams/source/ holds the
// readable sources legacy kept beside them and is never inlined, exactly as
// legacy's `public/diagrams/${slug}.svg` path with a [a-z0-9-] slug never
// reached it.
//
// The files are Recova's apart from colour: Q11 (APPROVED-DIFFERENCES.md,
// Dustin "yes", 2026-10-14) puts teal on every page, so each of Recova's gold
// accent literals in their <style> takes the value of the teal token that
// replaced its token in the Q11 change: --brand-bg for the accent tint,
// --brand-dark and --brand-text for accent lines and text, and in the dark
// theme --brand-border-interactive for accent lines and --brand-ui for the
// accent arrow. test/blog-diagrams-j25.test.ts pins the values and every
// other byte to Recova's.
//
// One meaning only. In this engine `:::diagram[slug]` names a file here and
// nothing else (never Mermaid or inline source): BLOG-EDITOR-COMPARISON.md
// records that dustinedwards-info uses the same name for Mermaid, and that a
// shared renderer must pick one meaning or the eight posts break.

const FILES = import.meta.glob<string>("/public/diagrams/*.svg", {
  query: "?raw",
  import: "default",
  eager: true,
});

const DIAGRAMS: ReadonlyMap<string, string> = new Map(
  Object.entries(FILES).map(([path, svg]) => [path.slice("/public/diagrams/".length, -".svg".length), svg]),
);

/** The SVG text for a diagram slug, or undefined when no such file exists. */
export function diagramSvg(slug: string): string | undefined {
  return DIAGRAMS.get(slug);
}
