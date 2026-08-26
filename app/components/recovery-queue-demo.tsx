import { useEffect, useState, useSyncExternalStore } from "react";
import { Check, RefreshCw, X } from "lucide-react";

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
//   - It honours prefers-reduced-motion by settling on the final frame and
//     scheduling nothing. An indefinite auto-playing loop with no pause
//     control is a WCAG 2.2.2 problem, and the canon target is 2.2 AA.

type Status = "failed" | "running" | "recovered";
type StepState = "done" | "active" | "pending";

interface Payment {
  name: string;
  amount: string;
}

const PAYMENTS: Payment[] = [
  { name: "Teamflow", amount: "$349" },
  { name: "Bolt Analytics", amount: "$129" },
  { name: "Northstar Inc", amount: "$599" },
];

const STEPS = ["E1", "R1", "E2", "R2", "E3", "R3", "E4"];

const IDLE_METAS = [
  "insufficient_funds, step 1 of 4",
  "card_expired, step 2 of 4",
  "do_not_honor, step 1 of 4",
];

interface Frame {
  statuses: Status[];
  metas: string[];
  /** How many of STEPS are complete; the next one is the active chip. */
  done: number;
  activeSequence: number;
  recovered: number;
  rate: string;
  active: number;
  holdMs: number;
}

// The whole animation as data. A list of frames beats a chain of awaited
// setState calls: the reduced-motion path is then just "render the last one",
// and the loop is a single timer rather than a cancellable async walk.
const FRAMES: Frame[] = [
  {
    statuses: ["failed", "failed", "failed"],
    metas: IDLE_METAS,
    done: 0,
    activeSequence: 0,
    recovered: 0,
    rate: "0%",
    active: 3,
    holdMs: 1200,
  },
  {
    statuses: ["failed", "failed", "failed"],
    metas: ["Email 1 sent, awaiting retry", IDLE_METAS[1], IDLE_METAS[2]],
    done: 0,
    activeSequence: 0,
    recovered: 0,
    rate: "0%",
    active: 3,
    holdMs: 1400,
  },
  {
    statuses: ["failed", "failed", "failed"],
    metas: ["Email 1 sent, awaiting retry", IDLE_METAS[1], IDLE_METAS[2]],
    done: 1,
    activeSequence: 0,
    recovered: 0,
    rate: "0%",
    active: 3,
    holdMs: 1000,
  },
  {
    statuses: ["running", "failed", "failed"],
    metas: ["Retry charging", IDLE_METAS[1], IDLE_METAS[2]],
    done: 2,
    activeSequence: 0,
    recovered: 0,
    rate: "0%",
    active: 3,
    holdMs: 1200,
  },
  {
    statuses: ["recovered", "failed", "failed"],
    metas: ["Recovered on day 3", IDLE_METAS[1], IDLE_METAS[2]],
    done: 3,
    activeSequence: 0,
    recovered: 349,
    rate: "33%",
    active: 2,
    holdMs: 1800,
  },
  {
    statuses: ["recovered", "running", "failed"],
    metas: ["Recovered on day 3", "Retry charging", IDLE_METAS[2]],
    done: 2,
    activeSequence: 1,
    recovered: 349,
    rate: "33%",
    active: 2,
    holdMs: 1400,
  },
  {
    statuses: ["recovered", "recovered", "failed"],
    metas: ["Recovered on day 3", "Recovered on day 7", IDLE_METAS[2]],
    done: 4,
    activeSequence: 1,
    recovered: 478,
    rate: "67%",
    active: 1,
    holdMs: 4200,
  },
];

const FINAL_FRAME = FRAMES.length - 1;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

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
// is the WCAG 2.2.2 case this behaviour is here to serve.
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

function stepStateAt(index: number, done: number): StepState {
  if (index < done) return "done";
  if (index === done) return "active";
  return "pending";
}

const STATUS_ICON_CLASS: Record<Status, string> = {
  failed: "bg-red-bg text-red",
  running: "bg-amber-bg text-amber-text",
  recovered: "bg-green-bg text-green",
};

const AMOUNT_CLASS: Record<Status, string> = {
  failed: "text-text-subtle",
  running: "text-amber-text",
  recovered: "text-green",
};

const STEP_CLASS: Record<StepState, string> = {
  done: "border-green bg-green-bg text-green",
  active: "border-amber-border-interactive bg-amber-bg text-amber-text",
  pending: "border-border text-text-subtle",
};

function StatusIcon({ status }: { status: Status }) {
  if (status === "failed") return <X width={13} height={13} strokeWidth={2.5} aria-hidden />;
  if (status === "running") return <RefreshCw width={13} height={13} strokeWidth={2.5} aria-hidden />;
  return <Check width={13} height={13} strokeWidth={2.5} aria-hidden />;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="px-3 py-2.5">
      <div className="mb-1 font-mono text-micro uppercase tracking-widest text-text-subtle">{label}</div>
      <div className={`font-mono text-label font-medium transition-colors duration-300 ${tone ?? "text-text"}`}>
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
    <div className="w-full">
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
            />
            <span className="font-mono text-micro text-green">live</span>
          </div>
        </div>

        <ol className="flex flex-col">
          {PAYMENTS.map((payment, i) => (
            <li
              key={payment.name}
              className={`flex items-center gap-3 border-b border-border-sub px-4 py-3 transition-colors duration-300 ${
                frame.statuses[i] === "recovered" ? "bg-surface2" : ""
              }`}
            >
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors duration-300 ${STATUS_ICON_CLASS[frame.statuses[i]]}`}
              >
                <StatusIcon status={frame.statuses[i]} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-label font-medium text-text">{payment.name}</span>
                <span className="block font-mono text-micro text-text-subtle">{frame.metas[i]}</span>
              </span>
              <span
                className={`shrink-0 font-mono text-label font-medium transition-colors duration-300 ${AMOUNT_CLASS[frame.statuses[i]]}`}
              >
                {payment.amount}
              </span>
            </li>
          ))}
        </ol>

        <div className="border-b border-border-sub bg-bg px-4 py-3">
          <div className="mb-2 font-mono text-micro uppercase tracking-widest text-text-subtle">
            {activePayment.name} sequence
          </div>
          <div className="flex items-center gap-1">
            {STEPS.map((label, i) => (
              <div
                key={label}
                // w-8 and NO shrink-0, both legacy's (components/hero/
                // RecoveryDemo.tsx stepClass). This row previously carried w-7
                // plus shrink-0, justified as clearing a 320px viewport. The
                // measurement inverted that: legacy already handles narrow
                // viewports, by letting the chips COMPRESS under flex's default
                // shrink of 1. Legacy sets flex-shrink-0 on the status icons and
                // deliberately not here. Foxhound had added shrink-0, which turns
                // a flexible 248px row into a rigid one, and then narrowed the
                // chips to make the rigid row fit. The narrowing compensated for
                // a self-inflicted constraint, not for anything legacy does.
                className={`flex h-5 w-8 items-center justify-center rounded border font-mono text-micro transition-colors duration-300 ${STEP_CLASS[stepStateAt(i, frame.done)]}`}
              >
                {label}
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-3 divide-x divide-border-sub">
          <Stat
            label="Recovered"
            value={`$${frame.recovered.toLocaleString("en-US")}`}
            tone={frame.recovered > 0 ? "text-green" : "text-text"}
          />
          <Stat label="Rate" value={frame.rate} />
          <Stat label="Active" value={String(frame.active)} />
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
