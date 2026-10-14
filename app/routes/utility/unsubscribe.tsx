import { Check, X } from "lucide-react";

import "capsomer/panel.css";
// Capsomer's tokens and the teal family (capbase layer), which the panel, the
// status tones and the focus ring read. The site header loads the same file;
// importing it here keeps the page whole under any layout (as legal-page.tsx).
import "~/site-header.css";

import { Header } from "~/components/header";
import { Wordmark } from "~/components/wordmark";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { RATE_LIMIT_UNSUBSCRIBE } from "~/lib/constants";
import { recordUnsubscribe } from "~/lib/email/suppression";
import { verifyUnsubscribeToken } from "~/lib/email/unsubscribe-token";
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
// visit (or the List-Unsubscribe POST arriving after a preview GET) is a no-op.
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
  | { state: "done" }
  | { state: "already"; email: string };

// GET: render the confirmation page. A mail client's link preview or a human click
// both land here; both suppress. The first visit reads "unsubscribed", any later
// one (or one for an address a bounce already suppressed) "already unsubscribed".
export async function loader({ params, context }: Route.LoaderArgs): Promise<LoaderState> {
  const { env } = context.get(cloudflareContext);
  const token = params.token;
  // The route requires :token, so Recova's no-token state ("Invalid unsubscribe
  // link.") cannot arise here; an absent token folds into the invalid state.
  const payload = token ? await verifyUnsubscribeToken(env, token) : null;
  if (!payload || !token) return { state: "invalid" };
  const outcome = await recordUnsubscribe(env, payload, token);
  return outcome === "already" ? { state: "already", email: payload.email } : { state: "done" };
}

// POST: the RFC 8058 one-click List-Unsubscribe-Post request. Same suppression
// write, but the mail client only needs a 200; no page is rendered. Idempotent
// with the GET, so a client that POSTs then also opens the link double-writes to
// a single row.
export async function action({ params, context }: Route.ActionArgs): Promise<Response> {
  const { env } = context.get(cloudflareContext);
  const token = params.token;
  const payload = token ? await verifyUnsubscribeToken(env, token) : null;
  if (payload && token) {
    await recordUnsubscribe(env, payload, token);
  }
  // Always 200 for one-click: a bad token is not worth telling a mail client
  // about, and never leaks token validity.
  return new Response(null, { status: 200 });
}

function message(data: LoaderState): string {
  switch (data.state) {
    case "invalid":
      return "This unsubscribe link is invalid or has expired.";
    case "already":
      return `${data.email} is already unsubscribed.`;
    case "done":
      return "You've been unsubscribed. You won't receive any more recovery emails.";
  }
}

// The status mark: Recova's 48px circle on the tone's tint with a 1px edge in the
// tone, a check for success and an X for failure. Capsomer 0.9.0 has no round
// status mark (status.css draws a glyph or a pill), so it is composed here from
// the family's ok and crit tone tokens. Decorative: the sentence beside it says
// the same thing.
const MARK = {
  ok: "border-[var(--ok)] bg-[var(--ok-soft)] text-[var(--ok)]",
  crit: "border-[var(--crit)] bg-[var(--crit-soft)] text-[var(--crit)]",
} as const;

// Layout is Recova's: the page centred both ways under the site header, a 480px
// column with 40px by 24px padding and centred text, the wordmark 32px above the
// card, the card at 40px by 32px, the 48px mark 20px above the sentence, the
// sentence 24px above the link. Look is Capsomer's (Q12): the column sits in the
// teal family with Foxhound's neutrals (.fh-cap, as the legal pages), the card is
// Capsomer's panel (its body-only state), and the focus ring is the family's
// teal. Text is on the five sizes (RULES.md 5.2): Recova's 20px wordmark is
// title (1.25rem, exact), its 15px sentence body (1rem, the nearest), its 13px
// link label (0.8125rem, exact).
export default function Unsubscribe({ loaderData }: Route.ComponentProps) {
  const tone = loaderData.state === "done" || loaderData.state === "already" ? "ok" : "crit";
  const Icon = tone === "ok" ? Check : X;
  return (
    <div className="flex min-h-screen flex-col">
      <Header isAuthenticated={false} />
      <main className="flex flex-1 items-center justify-center bg-bg">
        <div
          className="fh-cap w-full max-w-[480px] px-6 py-10 text-center [--border-focus:var(--ring)]"
          data-family="teal"
        >
          {/* The page's heading, for screen readers only: Recova's page has none
              visible, and the wordmark is not one. */}
          <h1 className="sr-only">Unsubscribe</h1>
          <div className="mb-8">
            <Wordmark size="title" />
          </div>
          <div className="cap-panel">
            <div className="px-8 py-10">
              <div
                data-status-mark={tone}
                aria-hidden="true"
                className={`mx-auto mb-5 flex size-12 items-center justify-center rounded-full border ${MARK[tone]}`}
              >
                <Icon className="size-5" strokeWidth={2.5} />
              </div>
              <p role="status" className="m-0 mb-6 text-body leading-relaxed text-text">
                {message(loaderData)}
              </p>
              {/* Recova's small underlined link in the secondary text colour. Its
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
