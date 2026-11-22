// S31's vocabulary, in a CLIENT-SAFE module because the form renders it. Nothing here touches the
// database.

export const BRAND_VOICE_PRESETS = [
  "friendly and conversational",
  "reassuring and low-pressure",
  "professional and formal",
  "direct and no-nonsense",
  "concise and minimal",
  "personal and founder-led",
  "helpful and educational",
] as const;

/** Never stored: the form submits the textarea's contents instead. */
export const CUSTOM_PRESET = "custom";

export interface CategoryVoiceRow {
  /** The decline category, which is also the form field suffix. */
  key: "soft" | "expired" | "network" | "fraud";
  label: string;
  description: string;
  dot: "blue" | "brand" | "orange" | "red";
}

/** Foxhound's `DECLINE_CATEGORIES` has SIX keys. */
export const CATEGORY_VOICE_ROWS: readonly CategoryVoiceRow[] = [
  {
    key: "soft",
    label: "Soft declines",
    description: "Insufficient funds, temporary holds. Most common, highest recovery rate.",
    dot: "blue",
  },
  {
    key: "expired",
    label: "Expired card",
    description: "Card expired. Customer needs to update their payment method.",
    dot: "brand",
  },
  {
    key: "network",
    label: "Network declines",
    description: "Bank or processor errors. Often resolves on retry without customer action.",
    dot: "orange",
  },
  {
    key: "fraud",
    label: "Fraud / hard declines",
    description: "Card flagged or blocked. Sensitive situation, handle carefully.",
    dot: "red",
  },
];

export type CategoryVoiceKey = CategoryVoiceRow["key"];

/** The form field name for one category. One place, so the render and the
 *  allowlist cannot drift apart. */
export function voiceFieldName(key: CategoryVoiceKey): string {
  return `voice_${key}`;
}

/** Which select option a stored value maps back to. */
export function presetForStoredVoice(stored: string | null): { preset: string; custom: string } {
  if (!stored) return { preset: "", custom: "" };
  return (BRAND_VOICE_PRESETS as readonly string[]).includes(stored)
    ? { preset: stored, custom: "" }
    : { preset: CUSTOM_PRESET, custom: stored };
}

/**
 * What the form submits for one category: the textarea when Custom is chosen, the preset otherwise.
 */
export function submittedVoice(preset: string, custom: string): string {
  return preset === CUSTOM_PRESET ? custom : preset;
}
