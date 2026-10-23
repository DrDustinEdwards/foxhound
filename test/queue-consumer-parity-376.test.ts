import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import * as constants from "~/lib/constants";

// RULING 376 ITEM (9): A HANDLER ARM NOTHING COULD REACH, AND A COMMENT THAT
// SAID OTHERWISE.
//
// consumer.ts dispatches on `batch.queue`. Its bounce-and-complaint arm matches
// EMAIL_EVENTS_QUEUE_NAME, wrangler.jsonc registered consumers for
// foxhound-email and foxhound-email-dlq only, and the queue itself did not
// exist on the account. So the arm was unreachable twice over, while a comment
// in wrangler.jsonc claimed the foxhound-email registration was "what keeps
// that handler reachable". Registering one queue does not reach a handler that
// branches on another.
//
// The failure was not that a queue broke. It was that the list of queues the
// CODE routes on and the list the PIPELINE subscribes to were two lists, and
// nothing compared them. So this compares them, in the shape 379 binding 3 set
// for exactly this: both sides derived, neither transcribed, and the READERS
// mutated as well as the lists, because a parser that returns nothing makes
// "every queue is consumed" vacuously true.
//
// Same model as test/cron-registry.test.ts, which derives its schedules from
// wrangler.jsonc rather than mirroring them.

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

/**
 * Every queue name the worker ROUTES ON, derived from source.
 *
 * Both files, because the routing is split across them and a guard scoped to
 * one of them would be a guess about where the next arm gets written:
 * workers/app.ts peels off the dead-letter queue and hands everything else to
 * handleQueueBatch, which branches on the other two. The match is on the
 * comparison itself, `batch.queue === SOME_CONSTANT`, so a new arm is picked up
 * by existing, and the constant NAME is then resolved to its VALUE through the
 * constants module rather than by re-reading the string out of the source.
 * That is what makes this a check on the deployed contract and not on spelling.
 */
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

describe("every queue the worker routes on has a consumer, and the reverse", () => {

  it("EVERY queue the code routes on is registered as a consumer", () => {
    for (const queue of ROUTED_QUEUE_NAMES) {
      expect(
        WRANGLER_QUEUES,
        `${queue} is routed in the worker and has no wrangler consumer, so that arm is unreachable`,
      ).toContain(queue);
    }
  });

  it("AND EVERY registered consumer is a queue the code routes on", () => {
    for (const queue of WRANGLER_QUEUES) {
      expect(
        ROUTED_QUEUE_NAMES,
        `${queue} has a wrangler consumer and nothing branches on it, so its messages are acked and dropped`,
      ).toContain(queue);
    }
  });

  it("a dead_letter_queue named on any consumer is itself consumed", () => {
    // A DLQ with no consumer is the silent discard 313 measured and ended. If a
    // consumer names one, something has to read it.
    for (const consumer of WRANGLER_CONSUMERS) {
      if (!consumer.dead_letter_queue) continue;
      expect(
        WRANGLER_QUEUES,
        `${consumer.queue} dead-letters into ${consumer.dead_letter_queue}, which nothing consumes`,
      ).toContain(consumer.dead_letter_queue);
    }
  });

  it("max_retries matches EMAIL_QUEUE_MAX_RETRIES, which claims to mirror it", () => {
    // constants.ts says that constant "exists specifically to mirror this
    // value" and nothing enforced it: the constant has no other reader, so the
    // two could drift silently in either direction.
    const email = WRANGLER_CONSUMERS.find((c) => c.queue === constants.EMAIL_QUEUE_NAME);
    expect(email?.max_retries).toBe(constants.EMAIL_QUEUE_MAX_RETRIES);
  });
});

describe("the monthly audit queue (job_97878f0d1fde)", () => {
  const audit = WRANGLER_CONSUMERS.find((c) => c.queue === constants.AUDIT_QUEUE_NAME);

  it("is routed, consumed, and produced into through AUDIT_QUEUE", () => {
    expect(ROUTED_QUEUE_NAMES).toContain(constants.AUDIT_QUEUE_NAME);
    expect(audit).toBeDefined();
    expect(WRANGLER.queues?.producers).toContainEqual({
      queue: constants.AUDIT_QUEUE_NAME,
      binding: "AUDIT_QUEUE",
    });
  });

  it("delivers ONE message per invocation, which is the whole fix", () => {
    // Each account must spend its Stripe pages in its own subrequest budget. A
    // batch of ten would put ten accounts back under one limit.
    expect(audit?.max_batch_size).toBe(1);
  });

  it("spreads its retries out, so a short outage cannot use every attempt", () => {
    // Without a delay the four deliveries land within seconds of each other and
    // a one-minute Stripe or model outage exhausts them all.
    expect(audit?.retry_delay).toBeGreaterThanOrEqual(60);
  });

  it("max_retries matches AUDIT_QUEUE_MAX_RETRIES, which decides the last attempt's alert", () => {
    expect(audit?.max_retries).toBe(constants.AUDIT_QUEUE_MAX_RETRIES);
  });
});
