import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Event } from "@sentry/cloudflare";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { describe, expect, it } from "vitest";

import { sentryOptions } from "~/lib/errors/sentry-options";

// J05: Sentry posture before Dustin sets SENTRY_DSN.
// RULES.md 3.14 keeps the package pinned exactly; this suite pins what the SDK
// is told to do on the day the DSN goes in: no default PII, sampled tracing,
// and a scrubber that takes personal data out of what Foxhound itself sends.
// Every assertion runs against the options object the worker entry passes to
// withSentry, not a copy of it.

const ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, ROOT)), "utf8");

const DSN = "https://k@o.ingest.test/1";

function withDsn() {
  const opts = sentryOptions({ SENTRY_DSN: DSN });
  if (!opts) throw new Error("expected options when SENTRY_DSN is set");
  return opts;
}

// The scrubber is called through the options object, the way the SDK calls it.
function runBeforeSend(event: Event): Event | null {
  const opts = withDsn();
  expect(typeof opts.beforeSend).toBe("function");
  return opts.beforeSend!(event as never, {}) as Event | null;
}

function runBeforeSendTransaction(event: Event): Event | null {
  const opts = withDsn();
  expect(typeof opts.beforeSendTransaction).toBe("function");
  return opts.beforeSendTransaction!(event as never, {}) as Event | null;
}

describe("J05: the options object carries the posture", () => {

  it("the worker entry passes THIS function to withSentry", () => {
    const entry = read("workers/app.ts");
    expect(entry).toContain('import { sentryOptions } from "~/lib/errors/sentry-options";');
    expect(entry).toMatch(/withSentry<Env>\(\s*sentryOptions,/);
    expect(entry).not.toContain("tracesSampleRate: 1");
  });
});

describe("J05: personal data is scrubbed from what the call sites send", () => {
  it("a Drizzle query error loses its bound params (customer emails and names)", () => {
    // A failed D1 query throws DrizzleQueryError, whose message is the SQL plus
    // every bound parameter. recordOutcome and both webhook routes pass such
    // messages to captureException, and the webhook claim binds the whole
    // Stripe event payload.
    const err = new DrizzleQueryError(
      "insert into webhook_events (payload) values (?)",
      ['{"customer_email":"jane@example.com","name":"Jane Doe"}'],
      new Error("D1_ERROR: UNIQUE constraint failed"),
    );
    expect(err.message).toContain("jane@example.com");

    const out = runBeforeSend({
      exception: { values: [{ type: "DrizzleQueryError", value: err.message }] },
    });
    const value = out?.exception?.values?.[0]?.value ?? "";
    expect(value).toContain("Failed query: insert into webhook_events");
    expect(value).not.toContain("jane@example.com");
    expect(value).not.toContain("Jane Doe");
    expect(value).toContain("params: [redacted]");
  });

  it("transactions are scrubbed too: name, request and outgoing span URLs", () => {
    const out = runBeforeSendTransaction({
      type: "transaction",
      transaction: "GET /p/tok_secret123",
      request: { url: "https://foxhoundapp.com/p/tok_secret123" },
      spans: [
        {
          span_id: "a",
          trace_id: "b",
          start_timestamp: 0,
          description: "GET https://api.stripe.com/v1/customers/search?query=email:'jane@example.com'",
          data: { "url.full": "https://api.stripe.com/v1/customers/search?query=x", "url.query": "?query=x" },
        },
      ],
    });
    expect(out?.transaction).toBe("GET /p/[token]");
    expect(out?.request?.url).toBe("https://foxhoundapp.com/p/[token]");
    const span = out?.spans?.[0];
    expect(span?.description).toBe("GET https://api.stripe.com/v1/customers/search");
    expect(span?.data?.["url.full"]).toBe("https://api.stripe.com/v1/customers/search");
    expect(span?.data?.["url.query"]).toBeUndefined();
  });

  it("a URL inside an error message loses its query string (review LOW 4)", () => {
    const out = runBeforeSend({
      exception: { values: [{ type: "Error", value: "fetch failed: https://api.test/v1/x?email=QSTRING done" }] },
    });
    expect(out?.exception?.values?.[0]?.value).toBe("fetch failed: https://api.test/v1/x done");
  });

  it("a scrubber that throws drops the event instead of sending it raw (review LOW 5)", () => {
    const hostile = {
      get message(): string {
        throw new Error("getter boom");
      },
    } as unknown as Event;
    let out: Event | null | undefined;
    expect(() => {
      out = runBeforeSend(hostile);
    }).not.toThrow();
    expect(out).toBeNull();
  });
});
