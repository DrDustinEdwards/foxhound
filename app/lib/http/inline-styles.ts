// THE ONLY INLINE <style> ELEMENTS ON THE SITE, and the hashes the CSP trusts
// them by (J22, F16). site-runtime's policy has no 'unsafe-inline' for style
// elements (style="" attributes are still allowed, style-src-attr), so each
// inline <style> is trusted by the SHA-256 of its exact text.
//
// A HASH, NOT THE NONCE, on purpose. The nonce reaches components through the
// root loader's data, which the client keeps from the first document; if the
// root loader revalidates after an action, a <style> rendered on a later
// client-side navigation would carry the NEW request's nonce, which the
// document's policy never named, and the browser would drop it silently. A
// hash names the content, so it holds on every render path.
//
// test/security-headers.test.ts recomputes each hash from these strings (and
// test/blog-diagrams-j25.test.ts the diagram hashes from their files) and
// fails if one drifts, and fails if any <style> element in app/ renders
// anything other than one of these constants.

// /features: the CSS-only product filter, ported from legacy's mechanism.
// FeatureFilterShell sets data-feature-filter on the wrapper and these
// selectors hide any card whose data-product does not match.
export const FEATURE_FILTER_CSS = `
[data-feature-filter="Recovery"] [data-product]:not([data-product="Recovery"]) { display: none; }
[data-feature-filter="Disputes"] [data-product]:not([data-product="Disputes"]) { display: none; }
[data-feature-filter="Intelligence"] [data-product]:not([data-product="Intelligence"]) { display: none; }
[data-feature-filter="Audit"] [data-product]:not([data-product="Audit"]) { display: none; }
[data-feature-filter="Platform"] [data-product]:not([data-product="Platform"]) { display: none; }
`.trim();

// /blog: the classes of legacy's hand-drawn cover fallback SVG.
export const BLOG_COVER_FALLBACK_CSS = `
.dz-base { fill: var(--bg); }
.dz-band { fill: var(--brand-text); }
`.trim();

// /blog/<slug>: the <style> inside each of Recova's eight diagram SVGs (J25,
// F23), inlined by `:::diagram[slug]` (app/lib/blog/diagrams.server.ts). The
// CSS lives in public/diagrams/*.svg, byte-identical to legacy, so it is
// hashed rather than copied here. Each hash is of the element's text as the
// browser parses it, so the files' &quot; references are hashed as ".
// test/blog-diagrams-j25.test.ts recomputes them from the files and fails if
// a file changes without its hash.
export const DIAGRAM_STYLE_HASHES: readonly string[] = [
  "sha256-UfEVYMsrDqwUdZg5pvKg2zi3fKlqnf5zD/aecIopmFw=", // decline-code-taxonomy.svg
  "sha256-5kiDd35yF+ELXjCDvtUTFXKlNM3T6SohFFA4GzgZ5GY=", // dispute-lifecycle.svg
  "sha256-B4rehl+x1OzYeMWkyLgNeYHZIKLt+rYbTOI2HAxr+XY=", // dunning-sequence-timeline.svg
  "sha256-BvbyQGxw8HpFscigsfruagxZTc7Cnocw89EpvQ90giw=", // involuntary-vs-voluntary.svg
  "sha256-cnlhoKNzPB4sTlf0rDCMx9DbsFR5Suy6GzQxWoncync=", // mrr-waterfall.svg
  "sha256-iYyHHXx7b2AgDCYZrnEWnh9pnhhVa5jMXLOm/PdczN8=", // nrr-calculation.svg
  "sha256-tRIoDdJL7nnmoWvyvQpjCBlGQLvGP4GJKDZoaNimZVc=", // recovery-sequence.svg
  "sha256-JK3i1u4EVRleKm3eOdHal6RNhcf9zYW1dPZgGK79440=", // recovery-vs-smart-retries.svg
];

export const INLINE_STYLE_HASHES: readonly string[] = [
  "sha256-kauF8mYaRsSeQ+zliDpLHTpyel4lJpD4YfS8YtTBTp4=", // FEATURE_FILTER_CSS
  "sha256-jhMI5icJZb23S3t6rnr6WoUj4k7g5rjXoiGq1e8iGvA=", // BLOG_COVER_FALLBACK_CSS
  ...DIAGRAM_STYLE_HASHES,
];
