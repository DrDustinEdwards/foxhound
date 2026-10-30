import { scrubText as scrubSharedText, scrubUrl as scrubSharedUrl } from "@dustinedwards/site-runtime/log";
import type { CloudflareOptions, Event } from "@sentry/cloudflare";

// J05 (job_f1f5ebd7fe50): the Sentry posture, set before Dustin puts in
// SENTRY_DSN. With no DSN this returns undefined and the SDK initializes
// nothing, exactly as before. With a DSN:
//
// - sendDefaultPii is false, written out so a changed SDK default cannot turn
//   on IP addresses, cookies or user data unnoticed.
// - tracesSampleRate is 0.1. Errors are always sent (sampleRate is untouched);
//   only performance traces are sampled. One in ten requests is enough to see
//   latency shape at Foxhound's volume, keeps the free quota from being spent
//   on every page view, and sends one tenth of the request URLs and span data.
// - beforeSend and beforeSendTransaction scrub what Foxhound itself would send:
//   bound Drizzle query params (a failed webhook claim binds the whole Stripe
//   event, customer email and name included), email addresses in messages and
//   breadcrumbs, emailed-link tokens in paths, query strings, request
//   headers, cookies and bodies, the trace context's url and header data, and
//   raw console arguments. A scrubber that throws drops the event.
//
// Sentry never wraps the money Durable Object.

// Routes whose last segment is one person's token (app/routes.ts).
const TOKEN_PATH = /\/(u|p|e\/[och]|invite)\/[^/?#\s'"]+/g;
// Data keys that hold a query string, request headers, cookies, or raw console
// arguments (the Console integration keeps them unformatted beside the message).
const DROP_KEY = /query|header|cookie|arguments/i;

// The text and URL scrubbers are site-runtime's ./log (emails, URL queries,
// Stripe keys, Drizzle params), with Foxhound's token routes.
const scrubText = (text: string) => scrubSharedText(text, { tokenPath: TOKEN_PATH });
const scrubUrl = (url: string) => scrubSharedUrl(url, { tokenPath: TOKEN_PATH });

function scrubValue(key: string, value: unknown): unknown {
  if (typeof value === "string") return /url|path/i.test(key) ? scrubUrl(value) : scrubText(value);
  if (Array.isArray(value)) return value.map((v) => scrubValue(key, v));
  if (value && typeof value === "object") {
    scrubData(value as Record<string, unknown>);
    return value;
  }
  return value;
}

function scrubData(data: Record<string, unknown> | undefined): void {
  if (!data) return;
  for (const key of Object.keys(data)) {
    if (DROP_KEY.test(key)) delete data[key];
    else data[key] = scrubValue(key, data[key]);
  }
}

function scrubEvent<T extends Event>(event: T): T {
  if (event.message) event.message = scrubText(event.message);
  if (event.transaction) event.transaction = scrubUrl(event.transaction);
  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = scrubText(ex.value);
  }
  for (const crumb of event.breadcrumbs ?? []) {
    if (crumb.message) crumb.message = scrubText(crumb.message);
    scrubData(crumb.data);
  }
  if (event.request) {
    if (event.request.url) event.request.url = scrubUrl(event.request.url);
    delete event.request.query_string;
    delete event.request.cookies;
    delete event.request.headers;
    delete event.request.data;
  }
  // The http.server span writes url.full, url.path, url.query and every
  // request header into the trace context, on errors and transactions alike.
  scrubData(event.contexts?.trace?.data as Record<string, unknown> | undefined);
  for (const span of event.spans ?? []) {
    if (span.description) span.description = scrubUrl(span.description);
    scrubData(span.data as Record<string, unknown> | undefined);
  }
  delete event.user;
  return event;
}

// A scrubber that throws must not let the unscrubbed event through: drop it.
function scrubOrDrop<T extends Event>(event: T): T | null {
  try {
    return scrubEvent(event);
  } catch {
    return null;
  }
}

export function sentryOptions(env: { SENTRY_DSN?: string }): CloudflareOptions | undefined {
  if (!env.SENTRY_DSN) return undefined;
  return {
    dsn: env.SENTRY_DSN,
    sendDefaultPii: false,
    tracesSampleRate: 0.1,
    beforeSend: (event) => scrubOrDrop(event),
    beforeSendTransaction: (event) => scrubOrDrop(event),
  };
}
