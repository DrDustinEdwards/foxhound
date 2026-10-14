import { HOUND_MARK_PATH, HOUND_MARK_VIEWBOX } from "~/lib/brand/hound-mark";

/** Foxhound's mark inline, in currentColor: the PLACEHOLDER hound's head until
 *  Dustin picks the real logo (app/lib/brand/hound-mark.ts holds the drawing). */
export function HoundMark({ className }: { className?: string }) {
  return (
    <svg viewBox={HOUND_MARK_VIEWBOX} className={className} aria-hidden="true" focusable="false">
      <path fill="currentColor" fillRule="evenodd" d={HOUND_MARK_PATH} />
    </svg>
  );
}
