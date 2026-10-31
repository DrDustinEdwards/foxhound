// The home hero's recovery queue (components/recovery-queue-demo.tsx) as data: its frames and the classes
// each state draws with. Shared with the queue-demo island (islands/queue-demo.ts), which plays the same
// frames on a page that does not hydrate. No imports: the island is bundled on its own.

export type Status = "failed" | "running" | "recovered";
type StepState = "done" | "active" | "pending";

interface Payment {
  name: string;
  amount: string;
}

export const PAYMENTS: Payment[] = [
  { name: "Teamflow", amount: "$349" },
  { name: "Bolt Analytics", amount: "$129" },
  { name: "Northstar Inc", amount: "$599" },
];

export const STEPS = ["E1", "R1", "E2", "R2", "E3", "R3", "E4"];

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
export const FRAMES: Frame[] = [
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

export const FINAL_FRAME = FRAMES.length - 1;

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function stepStateAt(index: number, done: number): StepState {
  if (index < done) return "done";
  if (index === done) return "active";
  return "pending";
}

const STATUS_ICON_CLASS: Record<Status, string> = {
  failed: "bg-red-bg text-red",
  running: "bg-brand-bg text-brand-text",
  recovered: "bg-green-bg text-green",
};

const AMOUNT_CLASS: Record<Status, string> = {
  failed: "text-text-subtle",
  running: "text-brand-text",
  recovered: "text-green",
};

const STEP_CLASS: Record<StepState, string> = {
  done: "border-green bg-green-bg text-green",
  active: "border-brand-border-interactive bg-brand-bg text-brand-text",
  pending: "border-border text-text-subtle",
};

/** A payment's row, tinted once it is recovered. */
export function rowClass(status: Status): string {
  return `flex items-center gap-3 border-b border-border-sub px-4 py-3 transition-colors duration-300 ${
    status === "recovered" ? "bg-surface2" : ""
  }`;
}

export function iconClass(status: Status): string {
  return `flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors duration-300 ${STATUS_ICON_CLASS[status]}`;
}

export function amountClass(status: Status): string {
  return `shrink-0 font-mono text-label font-medium transition-colors duration-300 ${AMOUNT_CLASS[status]}`;
}

// w-8 and NO shrink-0, both legacy's (components/hero/RecoveryDemo.tsx stepClass). This row previously
// carried w-7 plus shrink-0, justified as clearing a 320px viewport. The measurement inverted that:
// legacy already handles narrow viewports, by letting the chips COMPRESS under flex's default shrink of
// 1. Legacy sets flex-shrink-0 on the status icons and deliberately not here. Foxhound had added
// shrink-0, which turns a flexible 248px row into a rigid one, and then narrowed the chips to make the
// rigid row fit. The narrowing compensated for a self-inflicted constraint, not for anything legacy does.
export function stepClass(index: number, done: number): string {
  return `flex h-5 w-8 items-center justify-center rounded border font-mono text-micro transition-colors duration-300 ${STEP_CLASS[stepStateAt(index, done)]}`;
}

export function statValueClass(tone?: string): string {
  return `font-mono text-label font-medium transition-colors duration-300 ${tone ?? "text-text"}`;
}

export function recoveredText(recovered: number): string {
  return `$${recovered.toLocaleString("en-US")}`;
}

export function recoveredTone(recovered: number): string {
  return recovered > 0 ? "text-green" : "text-text";
}
