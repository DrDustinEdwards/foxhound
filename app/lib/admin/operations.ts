// Pure display helpers for /admin/operations (not a .server module: the page's
// component renders them).

import type { Tone as StatusTone } from "capsomer/react/status";

/** The Operations page. */
export const OPERATIONS_PATH = "/admin/operations";

export type CronLockState = "idle" | "running" | "not-released" | "unreadable";

/** A lock's state as a word with Capsomer's status glyph (Recova's Idle,
 *  Running and Stale pills), in the amber family's tones only. */
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
