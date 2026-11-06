import { useEffect, useState, useSyncExternalStore } from "react";
import { Check, RefreshCw, X } from "lucide-react";

import {
  amountClass,
  FINAL_FRAME,
  FRAMES,
  iconClass,
  PAYMENTS,
  recoveredText,
  recoveredTone,
  REDUCED_MOTION_QUERY,
  rowClass,
  type Status,
  statValueClass,
  stepClass,
  STEPS,
} from "~/lib/marketing/queue-demo-frames";

// The home hero visual: a looping, self-running view of the recovery queue
// working a batch of failed payments (ruling 6, adapted from legacy's animated
// hero). It shows the thing the product actually does, which a static screen
// cannot: a payment fails, a sequence runs, a retry lands, the money comes
// back and the counters move.
//
// Adapted, not ported. Four things changed on the way over:
//   - Foxhound tokens throughout. Legacy hardcoded sizes below the type scale
//     (0.5rem, 0.5625rem); text-micro is the floor here, so the panel is a
//     little taller than legacy's and the step chips a little wider.
//   - lucide icons instead of literal glyph characters, per DESIGN.md.
//   - It sizes to its OWN content. Legacy was h-full inside a fixed-height
//     hero and would clip exactly the way the ledger mock did (commit
//     1c98363). Nothing here may reintroduce a fixed height.
//   - It honors prefers-reduced-motion by settling on the final frame and
//     scheduling nothing. An indefinite auto-playing loop with no pause
//     control is a WCAG 2.2.2 problem, and the canon target is 2.2 AA.
//
// The frames and their classes are lib/marketing/queue-demo-frames.ts. On a page
// that does not hydrate, the queue-demo island (islands/queue-demo.ts) plays
// them on this markup: every status icon is drawn, the ones not showing hidden,
// and data-queue names each part it changes.

// prefers-reduced-motion is an external store, so it is READ through
// useSyncExternalStore rather than sampled into state inside the animation
// effect. Two reasons, one per direction.
//
// The lint reason: settling the frame with setFrameIndex(FINAL_FRAME) in the
// effect body is a synchronous setState in an effect
// (react-hooks/set-state-in-effect). Hoisting it to a lazy useState initialiser
// would not do, because this component server-renders: window does not exist
// there, so the server and the first client render would disagree and hydration
// would mismatch. useSyncExternalStore exists for exactly that shape, and takes
// the server snapshot as its third argument.
//
// The correctness reason: the old read happened once on mount, so a visitor who
// turned reduced motion ON while the page sat open kept the loop running. That
// is the WCAG 2.2.2 case this behavior is here to serve.
function subscribeToReducedMotion(onStoreChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", onStoreChange);
  return () => query.removeEventListener("change", onStoreChange);
}

function getReducedMotion(): boolean {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

// The server cannot know the preference, so it renders the animation's first
// frame, which is what it rendered before this change too.
function getReducedMotionOnServer(): boolean {
  return false;
}

// All three icons, the one for `status` showing (Tailwind's `hidden` on the
// others), so the island can switch them.
function StatusIcons({ status }: { status: Status }) {
  return (
    <>
      <X width={13} height={13} strokeWidth={2.5} aria-hidden className={status === "failed" ? undefined : "hidden"} data-queue-status="failed" />
      <RefreshCw width={13} height={13} strokeWidth={2.5} aria-hidden className={status === "running" ? undefined : "hidden"} data-queue-status="running" />
      <Check width={13} height={13} strokeWidth={2.5} aria-hidden className={status === "recovered" ? undefined : "hidden"} data-queue-status="recovered" />
    </>
  );
}

function Stat({ name, label, value, tone }: { name: string; label: string; value: string; tone?: string }) {
  return (
    <div className="px-3 py-2.5">
      <div className="mb-1 font-mono text-micro uppercase tracking-widest text-text-subtle">{label}</div>
      <div className={statValueClass(tone)} data-queue-stat={name}>
        {value}
      </div>
    </div>
  );
}

export function RecoveryQueueDemo() {
  const reducedMotion = useSyncExternalStore(
    subscribeToReducedMotion,
    getReducedMotion,
    getReducedMotionOnServer,
  );
  const [tickIndex, setTickIndex] = useState(0);
  const [pulse, setPulse] = useState(true);

  useEffect(() => {
    // Settle on the finished state and schedule nothing at all. The frame is
    // derived below rather than assigned here, so nothing is set in this body.
    if (reducedMotion) return;

    let frame = 0;
    let frameTimer: ReturnType<typeof setTimeout>;
    const advance = () => {
      frame = (frame + 1) % FRAMES.length;
      setTickIndex(frame);
      frameTimer = setTimeout(advance, FRAMES[frame].holdMs);
    };
    frameTimer = setTimeout(advance, FRAMES[0].holdMs);

    const pulseTimer = setInterval(() => setPulse((v) => !v), 800);
    return () => {
      clearTimeout(frameTimer);
      clearInterval(pulseTimer);
    };
  }, [reducedMotion]);

  const frame = FRAMES[reducedMotion ? FINAL_FRAME : tickIndex];
  const activePayment = PAYMENTS[frame.activeSequence];

  return (
    <div className="w-full" data-island="queue-demo">
      <p className="sr-only">
        An illustration of the recovery queue working three sample failed payments. A Foxhound email
        sequence runs, a retry is attempted, and two of the three payments are recovered.
      </p>

      <div
        aria-hidden="true"
        className="flex w-full flex-col overflow-hidden rounded-xl border border-border bg-surface"
      >
        <div className="flex items-center gap-1.5 border-b border-border-sub bg-bg px-3 py-2">
          <div className="h-2.5 w-2.5 rounded-full bg-border" />
          <div className="h-2.5 w-2.5 rounded-full bg-border" />
          <div className="h-2.5 w-2.5 rounded-full bg-border" />
          <div className="mx-3 flex-1">
            <div className="rounded border border-border-sub bg-surface px-2 py-0.5 text-center font-mono text-micro text-text-subtle">
              app.foxhoundapp.com/recovery
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between border-b border-border-sub px-4 py-3">
          <span className="font-mono text-micro uppercase tracking-widest text-text-tertiary">
            Recovery queue
          </span>
          <div className="flex items-center gap-1.5">
            <span
              className="h-1.5 w-1.5 rounded-full bg-green transition-opacity duration-300"
              style={{ opacity: pulse ? 1 : 0.3 }}
              data-queue-pulse=""
            />
            <span className="font-mono text-micro text-green">live</span>
          </div>
        </div>

        <ol className="flex flex-col">
          {PAYMENTS.map((payment, i) => (
            <li key={payment.name} className={rowClass(frame.statuses[i])} data-queue-row={i}>
              <span className={iconClass(frame.statuses[i])} data-queue-icon="">
                <StatusIcons status={frame.statuses[i]} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-label font-medium text-text">{payment.name}</span>
                <span className="block font-mono text-micro text-text-subtle" data-queue-meta="">
                  {frame.metas[i]}
                </span>
              </span>
              <span className={amountClass(frame.statuses[i])} data-queue-amount="">
                {payment.amount}
              </span>
            </li>
          ))}
        </ol>

        <div className="border-b border-border-sub bg-bg px-4 py-3">
          <div className="mb-2 font-mono text-micro uppercase tracking-widest text-text-subtle" data-queue-sequence="">
            {`${activePayment.name} sequence`}
          </div>
          <div className="flex items-center gap-1">
            {STEPS.map((label, i) => (
              <div key={label} className={stepClass(i, frame.done)} data-queue-step={i}>
                {label}
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-3 divide-x divide-border-sub">
          <Stat name="recovered" label="Recovered" value={recoveredText(frame.recovered)} tone={recoveredTone(frame.recovered)} />
          <Stat name="rate" label="Rate" value={frame.rate} />
          <Stat name="active" label="Active" value={String(frame.active)} />
        </div>

        <div className="border-t border-border-sub bg-bg px-4 py-2">
          <span className="font-mono text-micro uppercase tracking-widest text-text-subtle">
            Sample data
          </span>
        </div>
      </div>
    </div>
  );
}
