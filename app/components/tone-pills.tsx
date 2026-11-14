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

// Capsomer's tag badge: the word on its tone's tint with an edge in the word's own color
// (--tag-edge, app.css), or, for the accent, the amber family's tint and text. fh-pill-word keeps
// the badge's own word (sans, semibold, no case change) where Foxhound's tags are mono capitals.
const AMBER = "amber";

export function CategoryPill({ category }: { category: DeclineCategory }) {
  const tone = TONE[category];
  return (
    <span
      className="cap-pill fh-pill-word"
      data-variant="tag"
      data-tone={tone === "accent" ? undefined : tone}
      data-family={tone === "accent" ? AMBER : undefined}
    >
      {CATEGORY_PILL_WORDS[category]}
    </span>
  );
}

export function StepChip({ retry, timing }: { retry: boolean; timing: string }) {
  return (
    <span
      className="fh-tone-pills-col cap-pill fh-pill-word fh-tiny fh-medium"
      data-variant="tag"
      data-tone={retry ? undefined : "info"}
      data-family={retry ? AMBER : undefined}
    >
      {retry ? "Retry" : "Email"}
      <span className="fh-mono fh-source fh-regular">{timing}</span>
    </span>
  );
}

// Audit and Platform are the tag's quiet label: no tint, a hairline edge.
export function ProductTag({ product }: { product: Feature["product"] }) {
  const tone = product === "Disputes" ? "info" : product === "Intelligence" ? "ok" : undefined;
  return (
    <span
      className="cap-keep cap-pill fh-pill-word fh-mono fh-source"
      data-variant="tag"
      data-tone={tone}
      data-family={product === "Recovery" ? AMBER : undefined}
    >
      {product}
    </span>
  );
}
