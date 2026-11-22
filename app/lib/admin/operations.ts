// Pure display helpers for /admin/operations (not a .server module: the page's
// component renders them).

import type { Tone as StatusTone } from "capsomer/react/status";

/** The Operations page. */
export const OPERATIONS_PATH = "/admin/operations";

export type CronLockState = "idle" | "running" | "not-released" | "unreadable";

export const LOCK_STATUS: Record<CronLockState, { tone: StatusTone; word: string }> = {
  running: { tone: "ok", word: "Running" },
  idle: { tone: "nodata", word: "Idle" },
  "not-released": { tone: "crit", word: "Not released" },
  unreadable: { tone: "crit", word: "Could not read" },
};

/** A setting's kind in a plain word. */
export function settingKindWord(kind: "binding" | "var" | "secret"): string {
  return kind === "binding" ? "Binding" : kind === "var" ? "Variable" : "Secret";
}
