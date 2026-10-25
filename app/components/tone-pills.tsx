import type { DeclineCategory } from "~/lib/constants";
import type { Feature } from "~/lib/marketing/features-content";
import { CATEGORY_PILL_WORDS } from "~/lib/marketing/recovery-copy";

import "capsomer/status.css";

// Recova's tinted pills as Capsomer badges with no glyph, each on its own tint
// with an edge in its color: the decline category (CategoryPill: soft blue,
// network amber, expired orange, fraud red; Foxhound's revoked red and
// unclassified gray), the sequence step (SequenceTimeline: blue for an email,
// amber for a retry, its timing in mono beneath) and the product tag on a
// feature card (FeatureCard: Recovery amber, Disputes blue, Intelligence
// green, Audit and Platform gray).

const TONE: Record<DeclineCategory, "info" | "accent" | "warn" | "crit" | "nodata"> = {
  soft: "info",
  network: "accent",
  expired: "warn",
  fraud: "crit",
  revoked: "crit",
  unknown: "nodata",
};

// The badge's edge takes the word's color, as Recova's bordered pills do.
const EDGE = "[--_line:var(--_fg)]";
// Capsomer's badge has no accent tone; the accent's own tint and text stand in.
const ACCENT = "[--_bg:var(--accent-soft)] [--_fg:var(--accent-text)]";

export function CategoryPill({ category }: { category: DeclineCategory }) {
  const tone = TONE[category];
  return (
    <span className={`cap-pill ${EDGE} ${tone === "accent" ? ACCENT : ""}`} data-tone={tone === "accent" ? undefined : tone}>
      {CATEGORY_PILL_WORDS[category]}
    </span>
  );
}

export function StepChip({ retry, timing }: { retry: boolean; timing: string }) {
  return (
    <span
      className={`cap-pill flex-col gap-0 rounded-lg px-3 py-1.5 text-micro font-medium ${EDGE} ${retry ? ACCENT : ""}`}
      data-tone={retry ? undefined : "info"}
    >
      {retry ? "Retry" : "Email"}
      <span className="font-mono text-source font-normal opacity-70">{timing}</span>
    </span>
  );
}

const PRODUCT_TONE: Record<Feature["product"], string> = {
  Recovery: ACCENT,
  Disputes: "",
  Intelligence: "",
  Audit: "[--_bg:var(--raised)] [--_fg:var(--dim)] [--_line:var(--line)]",
  Platform: "[--_bg:var(--raised)] [--_fg:var(--dim)] [--_line:var(--line)]",
};

export function ProductTag({ product }: { product: Feature["product"] }) {
  const tone = product === "Disputes" ? "info" : product === "Intelligence" ? "ok" : undefined;
  return (
    <span className={`cap-pill shrink-0 font-mono text-source ${EDGE} ${PRODUCT_TONE[product]}`} data-tone={tone}>
      {product}
    </span>
  );
}
