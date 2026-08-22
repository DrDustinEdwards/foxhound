// S31's vocabulary, in a CLIENT-SAFE module because the form renders it.
// Nothing here touches the database.
//
// Ported from legacy's BrandVoiceForm.tsx (blob `8dd126bf`) and
// BrandVoiceSection.tsx (blob `9f4de70c`), verbatim strings.

/** The seven preset voices, exactly legacy's list and order. */
export const BRAND_VOICE_PRESETS = [
  "friendly and conversational",
  "reassuring and low-pressure",
  "professional and formal",
  "direct and no-nonsense",
  "concise and minimal",
  "personal and founder-led",
  "helpful and educational",
] as const;

/** Legacy's sentinel for the "Custom..." option. Never stored: the form submits
 *  the textarea's contents instead. */
export const CUSTOM_PRESET = "custom";

export interface CategoryVoiceRow {
  /** The decline category, which is also the form field suffix. */
  key: "soft" | "expired" | "network" | "fraud";
  label: string;
  description: string;
  /** Legacy's coloured dot per category. */
  dotClass: string;
}

/**
 * THE FOUR CATEGORIES LEGACY HAS A COLUMN FOR, with its labels and
 * descriptions verbatim.
 *
 * Foxhound's `DECLINE_CATEGORIES` has SIX keys. `revoked` and `unknown` are
 * deliberately absent here: legacy has no column for them and its resolver's
 * `default:` arm sends them to the general voice. Rendering a field for them
 * would be inventing a column, which is the addition; leaving them out is the
 * port.
 */
export const CATEGORY_VOICE_ROWS: readonly CategoryVoiceRow[] = [
  {
    key: "soft",
    label: "Soft declines",
    description: "Insufficient funds, temporary holds. Most common, highest recovery rate.",
    dotClass: "bg-blue",
  },
  {
    key: "expired",
    label: "Expired card",
    description: "Card expired. Customer needs to update their payment method.",
    dotClass: "bg-amber",
  },
  {
    key: "network",
    label: "Network declines",
    description: "Bank or processor errors. Often resolves on retry without customer action.",
    dotClass: "bg-orange",
  },
  {
    key: "fraud",
    label: "Fraud / hard declines",
    description: "Card flagged or blocked. Sensitive situation, handle carefully.",
    dotClass: "bg-red",
  },
];

export type CategoryVoiceKey = CategoryVoiceRow["key"];

/** The form field name for one category. One place, so the render and the
 *  allowlist cannot drift apart. */
export function voiceFieldName(key: CategoryVoiceKey): string {
  return `voice_${key}`;
}

/**
 * Which select option a stored value maps back to. Legacy's `initCategoryVoice`:
 * empty means "Same as main voice", a known preset selects itself, and anything
 * else is a custom string.
 */
export function presetForStoredVoice(stored: string | null): { preset: string; custom: string } {
  if (!stored) return { preset: "", custom: "" };
  return (BRAND_VOICE_PRESETS as readonly string[]).includes(stored)
    ? { preset: stored, custom: "" }
    : { preset: CUSTOM_PRESET, custom: stored };
}

/** What the form submits for one category: the textarea when Custom is chosen,
 *  the preset otherwise. Legacy's `resolvedVoice`. */
export function submittedVoice(preset: string, custom: string): string {
  return preset === CUSTOM_PRESET ? custom : preset;
}
