import { Icon, iconCheck, iconClose, iconRefresh } from "capsomer/react/icons";
import { useEffect, useState } from "react";
import { AppFrame } from "capsomer/react/app-frame";
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

import "capsomer/app-frame.css";

// The home hero visual: a looping, self-running view of the recovery queue working a batch of failed payments: a payment fails, a sequence runs, a retry lands, the money comes back and the counters move.
// It sizes to its own content; nothing here may reintroduce a fixed height (a fixed-height hero clipped the old ledger mock). Text-micro is the floor. It honors prefers-reduced-motion by settling on the final frame and scheduling nothing: an indefinite auto-playing loop with no pause control fails WCAG 2.2.2.
// The frames and their classes are lib/marketing/queue-demo-frames.ts. On a page that does not hydrate, the queue-demo island (islands/queue-demo.ts) plays them on this markup: every status icon is drawn, the ones not showing hidden, and data-queue names each part it changes.

// prefers-reduced-motion is an external store, so it is read through useSyncExternalStore, not sampled into state inside the animation effect. A synchronous setState in the effect fails react-hooks/set-state-in-effect, and a lazy useState initialiser would mismatch hydration (window does not exist on the server); useSyncExternalStore takes the server snapshot as its third argument. It also follows a visitor who turns reduced motion on while the page is open.
// All three icons are drawn, the one for `status` showing (the hidden attribute on the others), so the island can switch them.
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
      <div className="fh-label fh-queue-block-2 fh-queue-label-text">{label}</div>
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
      {/* The window is Capsomer's app frame: decorative, with the sentence a
          screen reader hears in place of the invented rows. */}
      <AppFrame
        decorative
        description="An illustration of the recovery queue working three sample failed payments. A Foxhound email sequence runs, a retry is attempted, and two of the three payments are recovered."
        address="foxhoundapp.com/recovery/dashboard"
        foot={<span className="fh-label fh-queue-label-text">Sample data</span>}
      >
        <div className="fh-queue-row-2">
          <span className="fh-label">Recovery queue</span>
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
      </AppFrame>
    </div>
  );
}
