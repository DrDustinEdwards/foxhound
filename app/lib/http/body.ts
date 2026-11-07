// EVERY REQUEST BODY IS READ TO A CEILING (site-runtime ./body), counted as it
// arrives, so a post far past anything Foxhound accepts is refused with 413
// before it is held in memory. Content-Length can be absent or understated, so
// it is not trusted. The dispute evidence upload has its own, larger ceiling
// (routes/app/disputes/detail.action.server.ts).

/** A form or JSON post: the largest field Foxhound takes is 20,000 characters. */
export const BODY_MAX_BYTES = 256 * 1024;

/** A Stripe webhook event: Stripe's largest (an invoice with many lines) is well under this. */
export const WEBHOOK_BODY_MAX_BYTES = 1024 * 1024;
