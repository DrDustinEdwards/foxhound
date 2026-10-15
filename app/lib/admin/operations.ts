// Pure display helpers for /admin/operations (not a .server module: the page's
// component renders them).

import type { Tone as StatusTone } from "capsomer/react/status";

import { plural } from "~/lib/admin/overview";

/** The Operations page. */
export const OPERATIONS_PATH = "/admin/operations";

export type CronLockState = "idle" | "running" | "not-released" | "unreadable";

/** A lock's state as a word with Capsomer's status glyph (Recova's Idle,
 *  Running and Stale pills), in the teal family's tones only (Q11). */
export const LOCK_STATUS: Record<CronLockState, { tone: StatusTone; word: string }> = {
  running: { tone: "ok", word: "Running" },
  idle: { tone: "nodata", word: "Idle" },
  "not-released": { tone: "crit", word: "Not released" },
  unreadable: { tone: "crit", word: "Could not read" },
};

/** "1 cron lock held, none not released.", with a third sentence only when a
 *  lock could not be read. */
export function lockSummaryWords(locks: ReadonlyArray<{ state: CronLockState }>): string {
  const held = locks.filter((l) => l.state === "running").length;
  const notReleased = locks.filter((l) => l.state === "not-released").length;
  const unreadable = locks.filter((l) => l.state === "unreadable").length;
  const first = `${held === 0 ? "No cron lock" : plural(held, "cron lock", "cron locks")} held, ${
    notReleased === 0 ? "none" : notReleased
  } not released.`;
  return unreadable === 0 ? first : `${first} ${plural(unreadable, "lock", "locks")} could not be read.`;
}

/** A setting's kind in a plain word. */
export function settingKindWord(kind: "binding" | "var" | "secret"): string {
  return kind === "binding" ? "Binding" : kind === "var" ? "Variable" : "Secret";
}

/** "28 of 30 migrations applied to this database." */
export function migrationsSummaryWords(applied: number, total: number): string {
  return applied === total
    ? `All ${plural(total, "migration", "migrations")} applied to this database.`
    : `${applied} of ${plural(total, "migration", "migrations")} applied to this database.`;
}
