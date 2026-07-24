import sanitizeHtml from "sanitize-html";

// AI-generated dunning email bodies (recovery_steps.ai_body_html) are written
// by a controlled generation pipeline (email-generation.ts's brand-voice
// sanitizers), never by a customer, but the /recovery/sequences preview
// expander renders this HTML directly to a merchant. Sanitizing here, once,
// server-side, before it ever reaches loaderData, is defense-in-depth against
// a prompt-injection or DB-tamper scenario - the same posture legacy took
// (client-side DOMPurify with an identical allowlist), moved server-side so
// no unsanitized HTML is ever shipped to the browser in the first place.
const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ["p", "br", "strong", "em", "a", "ul", "ol", "li"],
  allowedAttributes: { a: ["href", "target", "rel"] },
  allowedSchemes: ["http", "https", "mailto"],
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
};

export function sanitizeEmailPreviewHtml(html: string): string {
  return sanitizeHtml(html, SANITIZE_OPTIONS);
}
