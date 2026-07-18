// Small status pill shared across the recovery surfaces (5b) and later slices.
// Tones mirror the border/bg/text pattern already established by Alert
// (auth-ui.tsx). "purple" is used ONLY for win-back attribution (DESIGN.md:
// purple is exclusively Stripe Connect UI and win-back attribution).

export type BadgeTone = "neutral" | "success" | "failure" | "purple" | "free";

const TONE_CLASS_NAME: Record<BadgeTone, string> = {
  neutral: "border-border text-text-tertiary",
  success: "border-green bg-green-bg text-success-text",
  failure: "border-red bg-red-bg text-error-text",
  purple: "border-purple bg-purple-bg text-purple",
  free: "border-border-i text-text-tertiary",
};

export function Badge({ tone, children }: { tone: BadgeTone; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-micro uppercase tracking-wide ${TONE_CLASS_NAME[tone]}`}
    >
      {children}
    </span>
  );
}
