import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Event } from "@sentry/cloudflare";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { describe, expect, it } from "vitest";

import { sentryOptions } from "~/lib/errors/sentry-options";

// J05 (job_f1f5ebd7fe50): Sentry posture before Dustin sets SENTRY_DSN.
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
  it("is still inert with no DSN", () => {
    expect(sentryOptions({})).toBeUndefined();
    expect(sentryOptions({ SENTRY_DSN: "" })).toBeUndefined();
  });

  it("sets sendDefaultPii to false EXPLICITLY, not by leaving it out", () => {
    // The SDK default is false today. Written out so a default change in a
    // future version cannot turn on IP addresses and cookies unnoticed.
    const opts = withDsn();
    expect(Object.prototype.hasOwnProperty.call(opts, "sendDefaultPii")).toBe(true);
    expect(opts.sendDefaultPii).toBe(false);
  });

  it("samples traces at 10 percent, never every request", () => {
    const opts = withDsn();
    expect(opts.tracesSampleRate).toBe(0.1);
    expect(opts.tracesSampler).toBeUndefined();
  });

  it("keeps the DSN it was given", () => {
    expect(withDsn().dsn).toBe(DSN);
  });

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

  it("an email address in a plain message or breadcrumb is masked", () => {
    const out = runBeforeSend({
      message: "no customer for jane@example.com",
      breadcrumbs: [{ category: "console", message: "billing card read failed: bob@example.org" }],
    });
    expect(out?.message).toBe("no customer for [email]");
    expect(out?.breadcrumbs?.[0]?.message).toBe("billing card read failed: [email]");
  });

  it("emailed-link tokens and query strings leave the request URL", () => {
    const out = runBeforeSend({
      request: {
        url: "https://foxhoundapp.com/u/tok_secret123?x=1",
        query_string: "token=abc",
        cookies: { session: "s" },
        headers: { cookie: "session=s", "stripe-signature": "t=1,v1=abc" },
        data: '{"email":"jane@example.com"}',
      },
    });
    expect(out?.request?.url).toBe("https://foxhoundapp.com/u/[token]");
    expect(out?.request?.query_string).toBeUndefined();
    expect(out?.request?.cookies).toBeUndefined();
    expect(out?.request?.headers).toBeUndefined();
    expect(out?.request?.data).toBeUndefined();
  });

  it("every token-bearing route is covered: /p, /e/o, /e/c, /e/h, /invite, ?token=", () => {
    for (const [url, want] of [
      ["https://f.test/p/abc", "https://f.test/p/[token]"],
      ["https://f.test/e/o/abc", "https://f.test/e/o/[token]"],
      ["https://f.test/e/c/abc", "https://f.test/e/c/[token]"],
      ["https://f.test/e/h/abc", "https://f.test/e/h/[token]"],
      ["https://f.test/invite/abc", "https://f.test/invite/[token]"],
      ["https://f.test/reset-password?token=abc", "https://f.test/reset-password"],
    ] as const) {
      expect(runBeforeSend({ request: { url } })?.request?.url).toBe(want);
    }
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

  it("ids in extra context are kept, because they are what makes an event useful", () => {
    const out = runBeforeSend({
      extra: { scope: "stripe-webhook-process", eventType: "invoice.paid", eventId: "evt_1" },
    });
    expect(out?.extra).toEqual({ scope: "stripe-webhook-process", eventType: "invoice.paid", eventId: "evt_1" });
  });
});
