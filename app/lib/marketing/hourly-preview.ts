import { HOUR_MS } from "~/lib/constants";

/**
 * A marketing preview built once per clock hour and served to every request in it: the seeds are cheap, but their
 * deadlines count whole days from `now`, so each preview is drawn at the top of its hour.
 */
export function hourlyPreview<T>(build: (hourStart: Date) => T): (nowMs: number) => T {
  let cached: { hour: number; preview: T } | null = null;
  return (nowMs) => {
    const hour = Math.floor(nowMs / HOUR_MS);
    if (cached?.hour !== hour) cached = { hour, preview: build(new Date(hour * HOUR_MS)) };
    return cached.preview;
  };
}
