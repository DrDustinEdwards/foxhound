// EVERY REQUEST BODY IS READ TO A CEILING (site-runtime ./body), counted as it
// arrives, so a post far past anything Foxhound accepts is refused with 413
// before it is held in memory. Content-Length can be absent or understated, so
// it is not trusted. The dispute evidence upload has its own, larger ceiling
// (routes/app/disputes/detail.action.server.ts).

import { readCapped, readCappedBytes } from "@dustinedwards/site-runtime/body";

/** A form or JSON post: the largest field Foxhound takes is 20,000 characters. */
export const BODY_MAX_BYTES = 256 * 1024;

/** A Stripe webhook event: Stripe's largest (an invoice with many lines) is well under this. */
export const WEBHOOK_BODY_MAX_BYTES = 1024 * 1024;

function tooLarge(): Response {
  return new Response("Payload Too Large", { status: 413, headers: { "Cache-Control": "no-store" } });
}

/** The body as text. Throws the 413 Response when it is longer than `max`. */
export async function readText(request: Request, max = BODY_MAX_BYTES): Promise<string> {
  const text = await readCapped(request, max);
  if (text === null) throw tooLarge();
  return text;
}

/** The body parsed as JSON; throws as request.json() does, or the 413. */
export async function readJson(request: Request, max = BODY_MAX_BYTES): Promise<unknown> {
  return JSON.parse(await readText(request, max));
}

/** The body parsed as a form; throws as request.formData() does, or the 413. */
export async function readForm(request: Request, max = BODY_MAX_BYTES): Promise<FormData> {
  const bytes = await readCappedBytes(request, max);
  if (bytes === null) throw tooLarge();
  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    headers: { "Content-Type": request.headers.get("content-type") ?? "" },
  }).formData();
}
