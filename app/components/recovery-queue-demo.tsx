import { Icon, iconCheck, iconClose, iconRefresh } from "capsomer/react/icons";
import { useEffect, useState } from "react";
import { usePrefersReducedMotion } from "capsomer/react/hooks";

import {
  amountClass,
  FINAL_FRAME,
  FRAMES,
  iconClass,
  PAYMENTS,
  recoveredText,
  recoveredTone,
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
//   - drawn icons instead of literal glyph characters, per DESIGN.md.
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
// All three icons, the one for `status` showing (the hidden attribute on the
// others), so the island can switch them.
function StatusIcons({ status }: { status: Status }) {
  return (
    <>
      <span hidden={status !== "failed"} data-queue-status="failed">
        <Icon d={iconClose} className="fh-icon-13 fh-icon-heavy" />
      </span>
      <span hidden={status !== "running"} data-queue-status="running">
        <Icon d={iconRefresh} className="fh-icon-13 fh-icon-heavy" />
      </span>
      <span hidden={status !== "recovered"} data-queue-status="recovered">
        <Icon d={iconCheck} className="fh-icon-13 fh-icon-heavy" />
      </span>
    </>
  );
}

function Stat({
  name,
  label,
  value,
  tone,
}: {
  name: string;
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="fh-queue-block">
      <div className="fh-queue-block-2 fh-mono fh-tiny fh-faint fh-caps-wide">{label}</div>
      <div className={statValueClass(tone)} data-queue-stat={name}>
        {value}
      </div>
    </div>
  );
}

export function RecoveryQueueDemo() {
  const reducedMotion = usePrefersReducedMotion();
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
    <div className="fh-queue-block-3" data-island="queue-demo">
      <p className="cap-sr-only">
        An illustration of the recovery queue working three sample failed payments. A Foxhound email
        sequence runs, a retry is attempted, and two of the three payments are recovered.
      </p>

      <div aria-hidden="true" className="fh-queue-col">
        <div className="fh-queue-chrome">
          <div className="fh-queue-block-4" />
          <div className="fh-queue-block-4" />
          <div className="fh-queue-block-4" />
          <div className="fh-queue-block-5">
            <div className="fh-queue-block-6 fh-center fh-mono fh-tiny fh-faint">
              foxhoundapp.com/recovery/dashboard
            </div>
          </div>
        </div>

        <div className="fh-queue-row-2">
          <span className="fh-mono fh-tiny fh-quiet fh-caps-wide">Recovery queue</span>
          <div className="fh-mk-inline-wide">
            <span
              className="fh-queue-label"
              style={{ opacity: pulse ? 1 : 0.3 }}
              data-queue-pulse=""
            />
            <span className="fh-mono fh-tiny fh-green">live</span>
          </div>
        </div>

        <ol className="fh-mk-column">
          {PAYMENTS.map((payment, i) => (
            <li key={payment.name} className={rowClass(frame.statuses[i])} data-queue-row={i}>
              <span className={iconClass(frame.statuses[i])} data-queue-icon="">
                <StatusIcons status={frame.statuses[i]} />
              </span>
              <span className="cap-grow">
                <span className="fh-line fh-truncate fh-small fh-medium fh-text">
                  {payment.name}
                </span>
                <span className="fh-line fh-mono fh-tiny fh-quiet" data-queue-meta="">
                  {frame.metas[i]}
                </span>
              </span>
              <span className={amountClass(frame.statuses[i])} data-queue-amount="">
                {payment.amount}
              </span>
            </li>
          ))}
        </ol>

        <div className="fh-queue-block-7">
          <div
            className="fh-queue-block-8 fh-mono fh-tiny fh-faint fh-caps-wide"
            data-queue-sequence=""
          >
            {`${activePayment.name} sequence`}
          </div>
          <div className="fh-mk-inline">
            {STEPS.map((label, i) => (
              <div key={label} className={stepClass(i, frame.done)} data-queue-step={i}>
                {label}
              </div>
            ))}
          </div>
        </div>

        <div className="fh-queue-grid">
          <Stat
            name="recovered"
            label="Recovered"
            value={recoveredText(frame.recovered)}
            tone={recoveredTone(frame.recovered)}
          />
          <Stat name="rate" label="Rate" value={frame.rate} />
          <Stat name="active" label="Active" value={String(frame.active)} />
        </div>

        <div className="fh-queue-block-9">
          <span className="fh-mono fh-tiny fh-faint fh-caps-wide">Sample data</span>
        </div>
      </div>
    </div>
  );
}
