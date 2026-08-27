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
// wrangler.jsonc rather than mirroring them, and test/ci-gate-parity.test.ts.

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
  queues?: { consumers?: { queue: string; max_retries?: number; dead_letter_queue?: string }[] };
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
  // GUARD THE INSTRUMENT FIRST. An assertion that can pass by reading nothing is
  // the exact failure this file exists to catch, so a parser that silently
  // returned [] must not read as agreement.
  it("derived a non-empty routed list from source", () => {
    expect(ROUTED_QUEUE_NAMES.length).toBeGreaterThanOrEqual(3);
    expect(ROUTED_QUEUE_NAMES).toContain(constants.EMAIL_QUEUE_NAME);
    expect(ROUTED_QUEUE_NAMES).toContain(constants.EMAIL_DLQ_QUEUE_NAME);
    expect(ROUTED_QUEUE_NAMES).toContain(constants.EMAIL_EVENTS_QUEUE_NAME);
  });

  it("derived a non-empty consumer list from wrangler.jsonc", () => {
    expect(WRANGLER_QUEUES.length).toBeGreaterThanOrEqual(3);
    expect(new Set(WRANGLER_QUEUES).size).toBe(WRANGLER_QUEUES.length);
  });

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

  it("the events queue specifically is both routed and registered, which is what 376 (9) turned on", () => {
    expect(ROUTED_QUEUE_NAMES).toContain("foxhound-email-events");
    expect(WRANGLER_QUEUES).toContain("foxhound-email-events");
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

describe("the readers themselves", () => {
  // 379 binding 3: mutate the reader, not only the lists. These pin the two
  // parsers against the shapes that would make the checks above vacuous.
  it("the routed-name reader resolves constants to values, not to their names", () => {
    // If it returned identifiers, every name would be SCREAMING_CASE and none
    // would match a wrangler queue.
    for (const name of ROUTED_QUEUE_NAMES) {
      expect(name).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("the routed-name reader actually reads BOTH source files", () => {
    // The dead-letter arm lives only in workers/app.ts and the events arm only
    // in consumer.ts, so finding both is proof the reader is not scoped to one.
    expect(read("workers/app.ts")).toContain("batch.queue === EMAIL_DLQ_QUEUE_NAME");
    expect(read("app/lib/queue/consumer.ts")).toContain("batch.queue === EMAIL_EVENTS_QUEUE_NAME");
    expect(ROUTED_QUEUE_NAMES).toContain(constants.EMAIL_DLQ_QUEUE_NAME);
    expect(ROUTED_QUEUE_NAMES).toContain(constants.EMAIL_EVENTS_QUEUE_NAME);
  });

  it("the jsonc reader keeps values containing a scheme separator", () => {
    // The naive "strip everything after //" is the bug this guards: it would
    // corrupt every https:// value in wrangler.jsonc and could take a queues
    // block with it.
    const raw = read("wrangler.jsonc");
    expect(raw).toContain("https://");
    expect(() => parseJsonc(raw)).not.toThrow();
  });
});
