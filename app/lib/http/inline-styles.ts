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
// test/security-headers.test.ts recomputes each hash from these strings and
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

export const INLINE_STYLE_HASHES: readonly string[] = [
  "sha256-kauF8mYaRsSeQ+zliDpLHTpyel4lJpD4YfS8YtTBTp4=", // FEATURE_FILTER_CSS
  "sha256-jhMI5icJZb23S3t6rnr6WoUj4k7g5rjXoiGq1e8iGvA=", // BLOG_COVER_FALLBACK_CSS
];
