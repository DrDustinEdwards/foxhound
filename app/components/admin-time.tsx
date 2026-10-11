import { useEffect, useId, useRef } from "react";
import { attach } from "capsomer/behaviour/tooltip";
import { exact } from "capsomer/behaviour/time";
import { Time } from "capsomer/react/time";

// A time in the admin: relative in words ("5 minutes ago"), with the exact time
// (your zone, then UTC) in a tooltip on hover and keyboard focus. Capsomer's
// Time keeps the exact form for a row's detail view, and the admin's tables
// have none, so the tooltip is where Dustin's review (2026-10-11) asked for it.
// The trigger takes focus so the tip is reachable without a mouse. The tip sits
// beside the time, not above it, so it never covers the line above (a time is
// usually one line in a list or a card; Dustin's review, 2026-10-11).
//
// Capsomer's Tooltip wrapper renders its tip as a <div>, which is invalid inside
// the <p> lines these times sit in, so this wires the same behaviour module
// (show on hover and focus, Esc hides) to a <span> tip with the same classes.
export function AdminTime({ at, empty = "never" }: { at: Date | null | undefined; empty?: string }) {
  const id = useId();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (triggerRef.current && tipRef.current) return attach(triggerRef.current, tipRef.current);
  }, [at]);

  if (!at) return <span className="text-text-tertiary">{empty}</span>;
  return (
    <>
      <span ref={triggerRef} tabIndex={0} aria-describedby={id}>
        <Time at={at} />
      </span>
      <span
        ref={tipRef}
        id={id}
        className="cap-popover"
        data-cap="tooltip"
        data-variant="tooltip"
        data-side="inline-end"
        role="tooltip"
        popover="manual"
      >
        {/* Plain text in the tip's own colours: Capsomer's exact Time paints
            itself in --text, which is the tip's background. The viewer's zone
            differs from the server's, so the browser's words win. */}
        <span suppressHydrationWarning>{exact(at.getTime())}</span>
        <span className="cap-popover-arrow" aria-hidden="true" />
      </span>
    </>
  );
}
