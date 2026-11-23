import sanitizeHtml from "sanitize-html";

// AI-generated dunning email bodies (recovery_steps.ai_body_html) are written by a controlled
// generation pipeline (email-generation.ts's brand-voice sanitizers), never by a customer, but the
// /recovery/sequence preview expander renders this HTML directly to a merchant.
const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ["p", "br", "strong", "em", "a", "ul", "ol", "li"],
  allowedAttributes: { a: ["href", "target", "rel"] },
  allowedSchemes: ["http", "https", "mailto"],
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
  // No allowedStyles, so no style parsing: vite.config.ts aliases postcss to a stub that throws.
  parseStyleAttributes: false,
};

export function sanitizeEmailPreviewHtml(html: string): string {
  return sanitizeHtml(html, SANITIZE_OPTIONS);
}
