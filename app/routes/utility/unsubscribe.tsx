import { Button } from "capsomer/react/button";
import { Check, X } from "lucide-react";
import { Form, useActionData, useNavigation } from "react-router";

import "capsomer/button.css";
import "capsomer/panel.css";
// Capsomer's tokens and the amber family (capbase layer), which the panel, the
// status tones and the focus ring read. The site header loads the same file;
// importing it here keeps the page whole under any layout (as legal-page.tsx).
import "~/site-header.css";

import { Header } from "~/components/header";
import { Wordmark } from "~/components/wordmark";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { RATE_LIMIT_UNSUBSCRIBE } from "~/lib/constants";
import { recordDigestUnsubscribe, recordUnsubscribe } from "~/lib/email/suppression";
import { verifyUnsubscribeToken, type UnsubscribeTokenPayload } from "~/lib/email/unsubscribe-token";
import { isWithinRateLimit } from "~/lib/http/rate-limit";

import type { Route } from "./+types/unsubscribe";

export function meta() {
  return [{ title: "Unsubscribe - Foxhound" }];
}

// This URL is per-recipient and token-bearing, so it is never cacheable by any
// shared intermediary (Dustin, 2026-08-04). Neither side sent a directive here:
// legacy sets no Cache-Control on its unsubscribe route either, and Foxhound's
// own e/o pixel was the only one of the four tokenised routes that did. Same
// correctness class as the F2 robots row, where Foxhound already disallows
// /u/ /p/ /e/ that legacy crawled and the ledger records that it must not be
// reverted; robots.txt is advisory and a cache directive is not.
const NO_STORE = "no-store, no-cache, must-revalidate, private";

export function headers() {
  return { "Cache-Control": NO_STORE };
}

// CAN-SPAM one-click unsubscribe (ROUTES.md public-utility /u/:token, ARCHITECTURE
// non-negotiable #8). Every dunning email signs a real unsubscribe token
// (execute-step.ts) into a /u/:token link plus the RFC 8058 List-Unsubscribe /
// List-Unsubscribe-Post headers (send.ts). The token is HMAC-signed and stateless
// (app/lib/email/unsubscribe-token.ts, mirrors the /e/* engagement + /p/ card-update
// pattern); it is verified before anything runs, so a tampered/garbage link renders
// a clean "invalid link" state, never a stack trace. A valid link writes an
// account-scoped email_suppressions row (reason=unsubscribe) that isSuppressed()
// then gates every future send on. The suppression write is idempotent, so a second
// confirm (or the List-Unsubscribe POST arriving after it) is a no-op.
//
// ONLY A POST WRITES. A GET verifies the token and shows a confirm button: mail
// security scanners and link previews fetch every link in a message, and a write
// on GET unsubscribed customers who never clicked. The button posts back to this
// URL; so does a mail client's RFC 8058 one-click request.
//
// No auth: the visitor is a merchant's customer, not a Foxhound account holder, so
// there is no session to thread; the header takes the root loader's theme, as in
// card-update.tsx. Account scope comes from the signed token
// payload, never from a query param.
//
// ROW F7 (J26). Recova's app/api/unsubscribe/route.ts (blob 31de4bc5, read whole)
// is the spec for the page: its four states and their words, its per-IP limit and
// its layout. Foxhound's engine above stays; Recova's Supabase token lookup is not
// copied.

// Recova's limit: 10 requests per 60 seconds per IP, else a plain-text 429
// "Too many requests", checked before the token is looked at. Middleware rather
// than the loader so the answer is that plain response, not the error page, and
// so neither the root loader nor the suppression write runs for a throttled
// request. The RFC 8058 POST is not limited: Recova had no POST, and a mail
// client's one-click request must not be refused for sharing an IP.
export const middleware: Route.MiddlewareFunction[] = [
  async ({ request, context }, next) => {
    if (request.method === "POST") return next();
    const { env } = context.get(cloudflareContext);
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const allowed = await isWithinRateLimit(
      env,
      "unsubscribe",
      ip,
      RATE_LIMIT_UNSUBSCRIBE.max,
      RATE_LIMIT_UNSUBSCRIBE.windowMs,
    );
    if (!allowed) {
      return new Response("Too many requests", {
        status: 429,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": NO_STORE },
      });
    }
    return next();
  },
];

type LoaderState =
  | { state: "invalid" }
  | { state: "confirm" }
  | { state: "changed" }
  | { state: "done" }
  | { state: "already"; email: string };

/**
 * Follow one valid link. A customer token suppresses the address, as Recova's
 * route does. A digest token (E23) switches off that account's weekly digest
 * and writes no suppression row, so the merchant's notices and every other
 * account sharing the address carry on (RULES.md 3.16); "changed" when the
 * account no longer mails the digest to that address.
 */
async function follow(env: Env, payload: UnsubscribeTokenPayload, token: string): Promise<LoaderState> {
  const outcome =
    payload.list === "digest" ? await recordDigestUnsubscribe(env, payload) : await recordUnsubscribe(env, payload, token);
  if (outcome === "changed") return { state: "changed" };
  return outcome === "already" ? { state: "already", email: payload.email } : { state: "done" };
}

// GET: verify the link and offer the confirm button. Writes nothing, so a
// scanner or a preview that fetches the link unsubscribes nobody.
export async function loader({ params, context }: Route.LoaderArgs): Promise<LoaderState> {
  const { env } = context.get(cloudflareContext);
  const token = params.token;
  // The route requires :token, so Recova's no-token state ("Invalid unsubscribe
  // link.") cannot arise here; an absent token folds into the invalid state.
  const payload = token ? await verifyUnsubscribeToken(env, token) : null;
  if (!payload || !token) return { state: "invalid" };
  return { state: "confirm" };
}

/** The confirm button's field, which tells the page's own POST from a mail client's. */
const CONFIRM_FIELD = "confirm";

// POST: the page's confirm button, or the RFC 8058 one-click
// List-Unsubscribe-Post request. Both write the suppression. The button gets the
// page's outcome back; a mail client only needs a 200 and no page, whether the
// token was good or not, so token validity never leaks to it. The first confirm
// reads "unsubscribed", any later one (or one for an address a bounce already
// suppressed) "already unsubscribed".
export async function action({ params, context, request }: Route.ActionArgs): Promise<Response | LoaderState> {
  const { env } = context.get(cloudflareContext);
  const token = params.token;
  const fromPage = (await request.formData().catch(() => null))?.get(CONFIRM_FIELD) === "1";
  const payload = token ? await verifyUnsubscribeToken(env, token) : null;
  const outcome: LoaderState = payload && token ? await follow(env, payload, token) : { state: "invalid" };
  return fromPage ? outcome : new Response(null, { status: 200 });
}

function message(data: LoaderState): string {
  switch (data.state) {
    // A digest link for an address the account no longer uses has expired in
    // the sense Recova's words mean, and nothing was switched off.
    case "invalid":
    case "changed":
      return "This unsubscribe link is invalid or has expired.";
    case "confirm":
      return "Confirm to stop receiving these emails.";
    case "already":
      return `${data.email} is already unsubscribed.`;
    case "done":
      return "You've been unsubscribed. You won't receive any more recovery emails.";
  }
}

const HEADING: Record<LoaderState["state"], string> = {
  invalid: "Unsubscribe link not valid",
  confirm: "Unsubscribe",
  changed: "Unsubscribe link not valid",
  already: "Already unsubscribed",
  done: "Unsubscribed",
};

// The status mark: Recova's 48px circle on the tone's tint with a 1px edge in the
// tone, a check for success and an X for failure. Capsomer 0.9.0 has no round
// status mark (status.css draws a glyph or a pill), so it is composed here from
// the family's ok and crit tone tokens. Decorative: the sentence beside it says
// the same thing.
const MARK = {
  ok: "border-[var(--ok)] bg-[var(--ok-soft)] text-[var(--ok)]",
  crit: "border-[var(--crit)] bg-[var(--crit-soft)] text-[var(--crit)]",
} as const;

// Layout is Recova's: the page centered both ways under the site header, a 480px
// column with 40px by 24px padding and centered text, the wordmark 32px above the
// card, the card at 40px by 32px, the 48px mark 20px above the sentence, the
// sentence 24px above the link. Look is Capsomer's (Q12): the column sits in the
// amber family with Foxhound's neutrals (.fh-cap, as the legal pages), the card is
// Capsomer's panel (its body-only state), and the focus ring is the family's
// amber. Text is on the five sizes (RULES.md 5.2): Recova's 20px wordmark is
// title (1.25rem, exact), its 15px sentence body (1rem, the nearest), its 13px
// link label (0.8125rem, exact).
export default function Unsubscribe({ loaderData }: Route.ComponentProps) {
  const posted = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  // The confirm's outcome once the button posted, else the link's own state.
  const state: LoaderState = posted && !(posted instanceof Response) ? posted : loaderData;
  const confirming = state.state === "confirm";
  const tone = state.state === "done" || state.state === "already" ? "ok" : "crit";
  const Icon = tone === "ok" ? Check : X;
  return (
    <div className="flex min-h-screen flex-col">
      <Header isAuthenticated={false} />
      <main className="flex flex-1 items-center justify-center bg-bg">
        <div
          className="fh-cap w-full max-w-[480px] px-6 py-10 text-center [--border-focus:var(--ring)]" data-cap-site="foxhound"
          data-family="amber"
        >
          {/* The page's heading, for screen readers only: Recova's page has none
              visible, and the wordmark is not one. It names the outcome, so the
              result is in the heading as well as the status paragraph. */}
          <h1 className="sr-only">{HEADING[state.state]}</h1>
          <div className="mb-8">
            <Wordmark size="title" />
          </div>
          <div className="cap-panel">
            <div className="px-8 py-10">
              {confirming ? null : (
                <div
                  data-status-mark={tone}
                  aria-hidden="true"
                  className={`mx-auto mb-5 flex size-12 items-center justify-center rounded-full border ${MARK[tone]}`}
                >
                  <Icon className="size-5" strokeWidth={2.5} />
                </div>
              )}
              <p role="status" className="m-0 mb-6 text-body leading-relaxed text-text">
                {message(state)}
              </p>
              {confirming ? (
                <Form method="post" className="mb-6">
                  <input type="hidden" name={CONFIRM_FIELD} value="1" />
                  <Button type="submit" variant="primary" pending={busy}>
                    Unsubscribe
                  </Button>
                </Form>
              ) : null}
              {/* Recova's small underlined link in the secondary text color. Its
                  box is Capsomer's minimum target height (--target), so the 13px
                  line is still a 24px target (WCAG 2.2, 2.5.8). */}
              <a
                href="/"
                className="inline-flex min-h-[var(--target)] items-center text-label text-text-secondary underline underline-offset-2 hover:text-text"
              >
                Return to Foxhound
              </a>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
