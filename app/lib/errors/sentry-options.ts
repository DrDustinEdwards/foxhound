import type { CloudflareOptions, Event } from "@sentry/cloudflare";

// J05 (job_f1f5ebd7fe50): the Sentry posture, set before Dustin puts in
// SENTRY_DSN. With no DSN this returns undefined and the SDK initialises
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
//   breadcrumbs, emailed-link tokens in paths, query strings, and request
//   headers, cookies and bodies.
//
// @sentry/cloudflare stays pinned exactly (RULES.md 3.14).

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// DrizzleQueryError's message is "Failed query: <sql>\nparams: <values>".
const DRIZZLE_PARAMS = /\nparams: [\s\S]*$/;
// Routes whose last segment is one person's token (app/routes.ts).
const TOKEN_PATH = /\/(u|p|e\/[och]|invite)\/[^/?#\s'"]+/g;
// A query string or fragment on a URL inside free text.
const URL_QUERY = /[?#]\S*/g;

function scrubText(text: string): string {
  return text.replace(DRIZZLE_PARAMS, "\nparams: [redacted]").replace(EMAIL, "[email]").replace(TOKEN_PATH, "/$1/[token]");
}

function scrubUrl(url: string): string {
  return scrubText(url.replace(URL_QUERY, ""));
}

function scrubData(data: Record<string, unknown> | undefined): void {
  if (!data) return;
  for (const key of Object.keys(data)) {
    const value = data[key];
    if (/query/i.test(key)) delete data[key];
    else if (typeof value === "string") data[key] = /url/i.test(key) ? scrubUrl(value) : scrubText(value);
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
  for (const span of event.spans ?? []) {
    if (span.description) span.description = scrubUrl(span.description);
    scrubData(span.data);
  }
  delete event.user;
  return event;
}

export function sentryOptions(env: { SENTRY_DSN?: string }): CloudflareOptions | undefined {
  if (!env.SENTRY_DSN) return undefined;
  return {
    dsn: env.SENTRY_DSN,
    sendDefaultPii: false,
    tracesSampleRate: 0.1,
    beforeSend: (event) => scrubEvent(event),
    beforeSendTransaction: (event) => scrubEvent(event),
  };
}
