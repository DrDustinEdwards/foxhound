// The only inline <style> elements on the site, trusted by SHA-256 hash because site-runtime's policy has no
// 'unsafe-inline' for style elements. A hash, not the nonce: after an action revalidates the root loader, a
// <style> rendered on a later client navigation would carry a new nonce the document's policy never named
// and the browser would drop it. test/security-headers.test.ts recomputes each hash and fails on drift.

// /features: the CSS-only product filter; FeatureFilterShell sets data-feature-filter and these hide cards whose data-product differs.
export const FEATURE_FILTER_CSS = `
[data-feature-filter="Recovery"] [data-product]:not([data-product="Recovery"]) { display: none; }
[data-feature-filter="Disputes"] [data-product]:not([data-product="Disputes"]) { display: none; }
[data-feature-filter="Intelligence"] [data-product]:not([data-product="Intelligence"]) { display: none; }
[data-feature-filter="Audit"] [data-product]:not([data-product="Audit"]) { display: none; }
[data-feature-filter="Platform"] [data-product]:not([data-product="Platform"]) { display: none; }
`.trim();

// /blog: the hand-drawn cover fallback SVG's classes.
export const BLOG_COVER_FALLBACK_CSS = `
.dz-base { fill: var(--ground); }
.dz-band { fill: var(--accent-text); }
`.trim();

export const INLINE_STYLE_HASHES: readonly string[] = [
  "sha256-kauF8mYaRsSeQ+zliDpLHTpyel4lJpD4YfS8YtTBTp4=", // FEATURE_FILTER_CSS
  "sha256-phAeQDMUpa4Ct4tjvuNbN5/kiRQcape0nOTzY4LQjKE=", // BLOG_COVER_FALLBACK_CSS
];
