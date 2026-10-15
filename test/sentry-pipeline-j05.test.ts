import { AsyncLocalStorage } from "node:async_hooks";

import * as Sentry from "@sentry/cloudflare";
import { describe, expect, it } from "vitest";

import { sentryOptions } from "~/lib/errors/sentry-options";

// J05 review (PR #93): the scrubber proven through the REAL SDK pipeline, not
// on hand-built event objects. wrapRequestHandler runs under Node with
// AsyncLocalStorage on globalThis (the Workers runtime provides it), the
// options are sentryOptions() itself with the trace rate forced to 1 for this
// test only so a transaction is always sent, and a capturing transport records
// every envelope the SDK would have sent to Sentry.

describe("J05: what the SDK actually sends carries no personal data", () => {
  it("a token-path POST with a console.error and a captureException leaks nothing", async () => {
    const g = globalThis as { AsyncLocalStorage?: unknown };
    const hadAls = "AsyncLocalStorage" in g;
    const previousAls = g.AsyncLocalStorage;
    g.AsyncLocalStorage = AsyncLocalStorage;
    try {
      const sent: string[] = [];
      const transport = (o: Parameters<typeof Sentry.createTransport>[0]) =>
        Sentry.createTransport(o, async (req) => {
          sent.push(typeof req.body === "string" ? req.body : new TextDecoder().decode(req.body));
          return { statusCode: 200 };
        });
      const base = sentryOptions({ SENTRY_DSN: "https://k@o.ingest.test/1" });
      expect(base).toBeDefined();
      const options = { ...base!, tracesSampleRate: 1, transport };

      const waits: Promise<unknown>[] = [];
      const context = {
        waitUntil: (p: Promise<unknown>) => void waits.push(p),
        passThroughOnException() {},
        props: {},
      } as unknown as ExecutionContext;
      const request = new Request("https://foxhoundapp.com/p/tok_SECRET123?token=QTOKEN&email=jane@example.com", {
        method: "POST",
        headers: {
          referer: "https://foxhoundapp.com/u/tok_REFERER?x=jane@example.com",
          "content-type": "application/json",
          "x-customer-email": "jane@example.com",
          "stripe-signature": "t=1,v1=SIGVALUE",
        },
        body: JSON.stringify({ customer_email: "jane@example.com" }),
      });

      const quiet = console.error;
      console.error = () => {};
      let res: Response;
      try {
        res = await Sentry.wrapRequestHandler({ options, request, context }, async () => {
          console.error(
            "billing run failed for account a1:",
            "Failed query: insert into x values (?)\nparams: jane@example.com,Jane Doe",
          );
          Sentry.captureException(new Error("boom for bob@example.org at https://f.test/x?q=QSTRING"), {
            extra: { scope: "t" },
          });
          return new Response("ok");
        });
      } finally {
        console.error = quiet;
      }
      await res.text();
      await new Promise((r) => setTimeout(r, 50));
      await Promise.all(waits);
      await Sentry.flush(2000);

      const text = sent.join("\n");
      // A clean result counts only if something was sent: the error event and
      // the transaction.
      expect(text).toContain('"type":"event"');
      expect(text).toContain('"type":"transaction"');
      expect(text).toContain("boom for [email]");
      for (const needle of [
        "tok_SECRET123",
        "QTOKEN",
        "QSTRING",
        "tok_REFERER",
        "SIGVALUE",
        "jane@example.com",
        "bob@example.org",
        "Jane Doe",
      ]) {
        expect(text, needle).not.toContain(needle);
      }
    } finally {
      if (hadAls) g.AsyncLocalStorage = previousAls;
      else delete g.AsyncLocalStorage;
    }
  });
});
