import { PRIVATE_PAGE_HEADERS } from "@dustinedwards/site-runtime/edge-cache";
import { ConsentRefusal, ConsentScreen } from "capsomer/react/consent";
import type { FormHTMLAttributes, ReactNode } from "react";
import { data, Form, redirect, useNavigation } from "react-router";
import { describeRedirect } from "@dustinedwards/site-runtime/mcp-login";

import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/field.css";
import "capsomer/panel.css";
import "capsomer/consent.css";
// Capsomer's tokens and the amber family (capbase layer), which the panel, the
// buttons, the alert and the focus ring read. The site header loads the same
// file; this page has no header, so it imports it itself, as auth-card.tsx does.
import "~/site-header.css";

import { Wordmark } from "~/components/wordmark";
import { getDb } from "~/db";
import { MEMBER_ROLE } from "~/lib/auth";
import { resolveActiveMembership } from "~/lib/auth/account";
import { getSession } from "~/lib/auth/session";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { RATE_LIMIT_OAUTH_APPROVE } from "~/lib/constants";
import { isWithinRateLimit } from "~/lib/http/rate-limit";
import { CONSENT_CAPABILITIES } from "~/lib/oauth/consent-copy";
import { grantedScopes, MERCHANT_SCOPES } from "~/lib/oauth/metadata";
import {
  checkAuthorizeRequest,
  denyRedirect,
  issueAuthorizationCode,
} from "~/lib/oauth/provider.server";

import type { Route } from "./+types/authorize";
import { NOINDEX, noindexHeader } from "~/lib/seo/meta";
import { readForm } from "@dustinedwards/site-runtime/body";
import { BODY_MAX_BYTES } from "~/lib/http/body";

// /oauth/authorize: the page where a signed-in merchant
// lets an external agent connect to one Foxhound account.
//
// Recova is the spec for the content and layout: app/oauth/authorize/page.tsx
// (63884241) and ConsentButtons.tsx (eb31e8e9), read whole. One 460px card
// centered on the page, with no site navigation (Recova's root layout has
// none): the wordmark, the h1 naming the client, the line under it, the
// account box, what the client can do, the error, Allow access and Deny side
// by side, and the closing line. A refused request is the same card holding
// Recova's title and message. The parts are Capsomer's, amber, on
// the five text sizes.
//
// The engine is Foxhound's (app/lib/oauth/provider.server.ts). Ruling 8's
// inherited artifacts, each where it lands:
//   - The signed-out round trip keeps EVERY query parameter, iterated rather
//     than picked, because a hand-picked list once dropped RFC 8707's resource.
//     /login honors it through safeNextPath, whose checks are anchored.
//   - Recova's force-dynamic fix and its hard-navigation login fix existed
//     because Next.js served a cached signed-out render. A React Router loader
//     runs on every request, this page is private, no-store (its `headers`
//     below), and the login action answers with a
//     server redirect that carries the session cookie, so neither has anything
//     to fix here.
//   - The scope a URL asks for can never raise what is granted. Every grant
//     holds merchant.read; merchant.write only when the owner ticks "Allow
//     changes", which starts ticked when the client asked for it (MCP ruling
//     2026-10-10, rule 12.1, least scope first). Recova's admin-only selector is
//     not built (see the PR).
//
// The account is the session's active one, resolved again in the action from
// the session. The form posts back the id the card showed only
// so that a switch in another tab is refused rather than silently approved.

// Hydrates: this page has client logic (root.tsx renders <Scripts/> only for a route that says so).
export const handle = { hydrate: true };

export function meta() {
  return [{ title: "Authorize access - Foxhound" }, NOINDEX];
}

// Drawn for one reader, and its URL holds a token: kept out of caches and Web Analytics (site-runtime PRIVATE_PAGE_HEADERS).
export const headers = () => PRIVATE_PAGE_HEADERS;

export const middleware: Route.MiddlewareFunction[] = [noindexHeader];

type Refusal = { ok: false; title: string; message: string };
type Consent = {
  ok: true;
  clientId: string;
  clientName: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  /** Whether "Allow changes" starts ticked: the client asked for merchant.write. */
  wantsWrite: boolean;
  /** The host publishing a metadata-document client's name, or null for a
   *  registered client, whose name is its own claim. */
  publishedBy: string | null;
  /** Where the code goes, and whether that is an app on this computer. */
  redirectHost: string;
  /** site-runtime's words when the access goes to an app on this computer, else null. */
  redirectWarning: string | null;
  /** Posted back as a consistency check only, never as the authority. */
  accountId: string;
  accountName: string;
  email: string;
};

/** /login?next= carrying this request's whole query, every parameter kept. */
function loginRedirect(params: URLSearchParams): Response {
  const search = new URLSearchParams();
  for (const [k, v] of params) if (k !== "intent") search.append(k, v);
  const next = `/oauth/authorize?${search.toString()}`;
  return redirect(`/login?next=${encodeURIComponent(next)}`);
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const params = new URL(request.url).searchParams;
  const db = getDb(env);

  // The request is checked before the session, as Recova did: a malformed or
  // unknown-client request is refused without a sign-in detour, with a 400
  // (area 11, A8): the card is the same, and the status says it is a refusal.
  const check = await checkAuthorizeRequest(db, params, new URL(request.url).origin);
  if (!check.ok)
    return data<Refusal>(
      { ok: false, title: check.title, message: check.message },
      { status: 400 },
    );

  const session = await getSession(env, request);
  if (!session) throw loginRedirect(params);

  const membership = await resolveActiveMembership(
    db,
    session.user.id,
    session.session.activeAccountId ?? null,
  );
  if (!membership) throw redirect("/connect");
  // The grant carries write tools, so only the account owner approves one, as
  // only an owner creates an API key (/settings/api-keys).
  if (membership.role !== MEMBER_ROLE.OWNER) {
    return data<Refusal>(
      { ok: false, title: "Owner approval needed", message: OWNER_ONLY },
      { status: 403 },
    );
  }

  const redirectTo = describeRedirect(check.redirectUri);
  const consent: Consent = {
    ok: true,
    clientId: check.clientId,
    clientName: check.clientName,
    redirectUri: check.redirectUri,
    state: check.state,
    codeChallenge: check.codeChallenge,
    wantsWrite: check.wantsWrite,
    publishedBy: check.metadataDocument ? new URL(check.clientId).hostname : null,
    redirectHost: redirectTo.host,
    redirectWarning: redirectTo.warning,
    accountId: membership.accountId,
    accountName: membership.accountName ?? session.user.email ?? "your Foxhound account",
    email: session.user.email,
  };
  return consent;
}

/** The words for a refusal on the card. Recova showed its raw error codes
 *  (authorize_failed, unknown_client); a raw code is a Recova bug not copied. */
const EXPIRED_REQUEST =
  "This request is no longer valid. Start again from the app you are connecting.";
const TOO_MANY = "Too many attempts. Wait a minute and try again.";
const DEMO_REFUSED = "The demo account cannot be connected.";
const OWNER_ONLY = "Only the account owner can connect an app to this account.";
const ACCOUNT_CHANGED =
  "Your active account changed in another tab. Check the account above and approve again.";

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);

  // ONLY THIS ORIGIN MAY APPROVE. A page elsewhere that posted here with a
  // signed-in merchant's cookie would mint a code for a client and verifier of
  // its own choosing. The session cookie's SameSite=Lax already stops that in
  // every current browser; this check does not rely on it.
  const self = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if ((origin && origin !== self) || (site && site !== "same-origin")) {
    return data({ error: EXPIRED_REQUEST }, { status: 403 });
  }

  const form = await readForm(request, BODY_MAX_BYTES);
  const params = new URLSearchParams();
  for (const [k, v] of form) if (typeof v === "string") params.append(k, v);

  const session = await getSession(env, request);
  if (!session) throw loginRedirect(params);

  const db = getDb(env);
  // Re-checked from the posted fields: nothing carried in a hidden input is
  // trusted, so a tampered redirect URI is refused here, never followed.
  const check = await checkAuthorizeRequest(db, params, self);
  if (!check.ok) return data({ error: EXPIRED_REQUEST }, { status: 400 });

  // This origin is the issuer the metadata names, sent back as iss (RFC 9207).
  if (params.get("intent") === "deny") {
    return redirect(denyRedirect(check.redirectUri, check.state, self));
  }

  // Recova's per-user cap on minting codes.
  const within = await isWithinRateLimit(
    env,
    "oauth-approve",
    session.user.id,
    RATE_LIMIT_OAUTH_APPROVE.max,
    RATE_LIMIT_OAUTH_APPROVE.windowMs,
  );
  if (!within) return data({ error: TOO_MANY }, { status: 429 });

  const membership = await resolveActiveMembership(
    db,
    session.user.id,
    session.session.activeAccountId ?? null,
  );
  if (!membership) throw redirect("/connect");
  if (membership.role !== MEMBER_ROLE.OWNER) return data({ error: OWNER_ONLY }, { status: 403 });

  // THE ACCOUNT THE CARD SHOWED MUST BE THE ONE APPROVED. The session's active
  // account is still the only authority; the posted id can only
  // refuse, never choose. A merchant who switched account in another tab after
  // the card rendered is stopped here, and the revalidated card shows the
  // account they would now be approving for.
  if (params.get("account_id") !== membership.accountId) {
    return data({ error: ACCOUNT_CHANGED }, { status: 409 });
  }

  const target = await issueAuthorizationCode(db, {
    clientId: check.clientId,
    metadataDocument: check.metadataDocument
      ? { clientName: check.clientName, redirectUris: check.redirectUris }
      : null,
    redirectUri: check.redirectUri,
    state: check.state,
    codeChallenge: check.codeChallenge,
    accountId: membership.accountId,
    userId: session.user.id,
    // What the owner ticked, never what the client asked for.
    scopes: grantedScopes(params.get("allow_write") === "1"),
    issuer: self,
    now: new Date(),
  });
  if (!target) return data({ error: DEMO_REFUSED }, { status: 403 });
  return redirect(target);
}

// Recova's frame (one 460px card centered on a full-height page, the
// wordmark on top) is Capsomer's consent screen, in its amber family with
// Foxhound's neutrals (.fh-cap), so the buttons and the focus ring are amber.
// Its words are site-runtime's MCP consent page's (mcp-login.mjs): a
// metadata-document client's name is vouched for by the host that publishes
// it, a registered client's is only its own claim.
function Frame({ children }: { children: ReactNode }) {
  return (
    <div
      className="fh-cap flex min-h-screen items-center bg-bg [--border-focus:var(--ring)]"
      data-cap-site="foxhound"
      data-family="amber"
    >
      {children}
    </div>
  );
}

// React Router's Form, for its pending state. Its props are narrower than a
// form's (the router's method and encoding names), so the screen's post goes
// through this wrapper, which passes what the screen sets (it always posts).
function PostForm({ className, children }: FormHTMLAttributes<HTMLFormElement>) {
  return (
    <Form method="post" className={className}>
      {children}
    </Form>
  );
}

export default function Authorize({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const intent = navigation.state !== "idle" ? navigation.formData?.get("intent") : null;
  const submitting = intent === "allow" || intent === "deny" ? intent : null;

  if (!loaderData.ok) {
    return (
      <Frame>
        <ConsentRefusal title={loaderData.title}>{loaderData.message}</ConsentRefusal>
      </Frame>
    );
  }

  const consent = loaderData;
  const error = actionData && "error" in actionData ? actionData.error : null;

  return (
    <Frame>
      <ConsentScreen
        client={consent.clientName}
        product="Foxhound"
        publishedBy={consent.publishedBy}
        redirectHost={consent.redirectHost}
        redirectWarning={consent.redirectWarning}
        account={{ name: consent.accountName, email: consent.email }}
        can={CONSENT_CAPABILITIES.filter((c) => !c.write).map((c) => c.text)}
        write={{
          items: CONSENT_CAPABILITIES.filter((c) => c.write).map((c) => c.text),
          scope: MERCHANT_SCOPES.write,
          defaultChecked: consent.wantsWrite,
        }}
        error={error}
        hidden={{
          client_id: consent.clientId,
          redirect_uri: consent.redirectUri,
          response_type: "code",
          code_challenge: consent.codeChallenge,
          code_challenge_method: "S256",
          account_id: consent.accountId,
          state: consent.state || undefined,
        }}
        submitting={submitting}
        brand={<Wordmark size="title" />}
        footnote="Foxhound never shares your Stripe access token with third-party clients."
        Form={PostForm}
      />
    </Frame>
  );
}
