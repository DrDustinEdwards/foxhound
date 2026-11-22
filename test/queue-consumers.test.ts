import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import * as constants from "~/lib/constants";

// The queue names the worker routes on and the queues wrangler.jsonc consumes were two lists that
// nothing compared, so a handler arm could be unreachable. Both sides are derived here, neither
// transcribed (like cron-registry.test.ts, which derives its schedules from wrangler.jsonc).

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function read(relativePath: string): string {
  return readFileSync(`${ROOT}/${relativePath}`, "utf8");
}

/** JSONC: drop whole-line comments only. A blanket "//" strip would eat the
 *  scheme separator inside every https:// value in this file. Same rule
 *  cron-registry.test.ts uses on the same file. */
function parseJsonc(raw: string): unknown {
  const stripped = raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  return JSON.parse(stripped);
}

const WRANGLER = parseJsonc(read("wrangler.jsonc")) as {
  queues?: {
    consumers?: {
      queue: string;
      max_retries?: number;
      max_batch_size?: number;
      retry_delay?: number;
      dead_letter_queue?: string;
    }[];
    producers?: { queue: string; binding: string }[];
  };
};

const WRANGLER_CONSUMERS = WRANGLER.queues?.consumers ?? [];
const WRANGLER_QUEUES = WRANGLER_CONSUMERS.map((c) => c.queue);

/** Every queue name the worker routes on, derived from the `batch.queue === CONSTANT` comparisons
 *  in both files that route, with the constant resolved to its value. */
const ROUTED_QUEUE_NAMES: string[] = (() => {
  const sources = ["workers/app.ts", "app/lib/queue/consumer.ts"];
  const names = new Set<string>();
  for (const file of sources) {
    for (const match of read(file).matchAll(/batch\.queue\s*===\s*([A-Z0-9_]+)/g)) {
      const value = (constants as Record<string, unknown>)[match[1]];
      if (typeof value === "string") names.add(value);
    }
  }
  return [...names].sort();
})();

describe("queue consumers", () => {
  it("every queue the code routes on is a registered consumer, and the reverse", () => {
    for (const queue of ROUTED_QUEUE_NAMES) {
      expect(
        WRANGLER_QUEUES,
        `${queue} is routed in the worker and has no wrangler consumer, so that arm is unreachable`,
      ).toContain(queue);
    }
    for (const queue of WRANGLER_QUEUES) {
      expect(
        ROUTED_QUEUE_NAMES,
        `${queue} has a wrangler consumer and nothing branches on it, so its messages are acked and dropped`,
      ).toContain(queue);
    }
  });

  it("a dead_letter_queue named on any consumer is itself consumed", () => {
    for (const consumer of WRANGLER_CONSUMERS) {
      if (!consumer.dead_letter_queue) continue;
      expect(
        WRANGLER_QUEUES,
        `${consumer.queue} dead-letters into ${consumer.dead_letter_queue}, which nothing consumes`,
      ).toContain(consumer.dead_letter_queue);
    }
  });

  it("max_retries mirrors the constants that claim to mirror it", () => {
    for (const [queue, retries] of [
      [constants.EMAIL_QUEUE_NAME, constants.EMAIL_QUEUE_MAX_RETRIES],
      [constants.AUDIT_QUEUE_NAME, constants.AUDIT_QUEUE_MAX_RETRIES],
    ] as const) {
      expect(WRANGLER_CONSUMERS.find((c) => c.queue === queue)?.max_retries, queue).toBe(retries);
    }
  });

  it("the monthly audit queue is produced into and delivers one message per invocation", () => {
    // Each account must spend its Stripe pages in its own subrequest budget; a batch of ten would
    // put ten accounts back under one limit.
    expect(WRANGLER.queues?.producers).toContainEqual({
      queue: constants.AUDIT_QUEUE_NAME,
      binding: "AUDIT_QUEUE",
    });
    expect(
      WRANGLER_CONSUMERS.find((c) => c.queue === constants.AUDIT_QUEUE_NAME)?.max_batch_size,
    ).toBe(1);
  });
});
