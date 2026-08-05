import { Alert, AuthShell } from "~/components/auth-ui";
import { Header } from "~/components/header";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { recordUnsubscribe } from "~/lib/email/suppression";
import { verifyUnsubscribeToken } from "~/lib/email/unsubscribe-token";
import { DEFAULT_THEME } from "~/lib/theme";

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
export function headers() {
  return { "Cache-Control": "no-store, no-cache, must-revalidate, private" };
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
// there is no session or theme cookie to thread (DEFAULT_THEME is the SSR default,
// same posture as card-update.tsx). Account scope comes from the signed token
// payload, never from a query param.

type LoaderState = { state: "invalid" } | { state: "done" };

// GET: render the confirmation page. A mail client's link preview or a human click
// both land here; both suppress and both show the same confirmation.
export async function loader({ params, context }: Route.LoaderArgs): Promise<LoaderState> {
  const { env } = context.get(cloudflareContext);
  const token = params.token;
  const payload = token ? await verifyUnsubscribeToken(env, token) : null;
  if (!payload || !token) return { state: "invalid" };
  await recordUnsubscribe(env, payload, token);
  return { state: "done" };
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

export default function Unsubscribe({ loaderData }: Route.ComponentProps) {
  return (
    <>
      <Header isAuthenticated={false} theme={DEFAULT_THEME} />
      {loaderData.state === "invalid" ? (
        <AuthShell title="Link not found">
          <Alert tone="error">This unsubscribe link is invalid or has expired.</Alert>
        </AuthShell>
      ) : (
        <AuthShell title="You have been unsubscribed">
          <Alert tone="success">
            You will no longer receive payment recovery emails at this address.
          </Alert>
        </AuthShell>
      )}
    </>
  );
}
