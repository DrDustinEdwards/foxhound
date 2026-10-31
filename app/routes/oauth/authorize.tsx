import { Alert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import type { ReactNode } from "react";
import { data, Form, redirect, useNavigation } from "react-router";

import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/field.css";
import "capsomer/panel.css";
// Capsomer's tokens and the amber family (capbase layer), which the panel, the
// buttons, the alert and the focus ring read. The site header loads the same
// file; this page has no header, so it imports it itself, as auth-card.tsx does.
import "~/site-header.css";

import { Wordmark } from "~/components/wordmark";
import { getDb } from "~/db";
import { MEMBER_ROLE } from "~/lib/auth";
import { resolveActiveMembership } from "~/lib/auth/account";
import { getSession } from "~/lib/auth/session";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { RATE_LIMIT_OAUTH_APPROVE } from "~/lib/constants";
import { isWithinRateLimit } from "~/lib/http/rate-limit";
import { CONSENT_CAPABILITIES } from "~/lib/oauth/consent-copy";
import { grantedScopes, MERCHANT_SCOPES } from "~/lib/oauth/metadata";
import { describeRedirect } from "~/lib/oauth/redirects";
import {
  checkAuthorizeRequest,
  denyRedirect,
  issueAuthorizationCode,
} from "~/lib/oauth/provider.server";

import type { Route } from "./+types/authorize";
import { NOINDEX, noindexHeader } from "~/lib/seo/meta";
import { readForm } from "~/lib/http/body";

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
//     runs on every request, the cache policy makes this path private, no-store
//     (app/lib/http/cache-policy.ts), and the login action answers with a
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

export function meta() {
  return [{ title: "Authorize access - Foxhound" }, NOINDEX];
}

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
  redirectLocal: boolean;
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

export async function loader({ request, context }: Route.LoaderArgs): Promise<Consent | Refusal> {
  const { env } = context.get(cloudflareContext);
  const params = new URL(request.url).searchParams;
  const db = getDb(env);

  // The request is checked before the session, as Recova did: a malformed or
  // unknown-client request is refused without a sign-in detour.
  const check = await checkAuthorizeRequest(db, params, new URL(request.url).origin);
  if (!check.ok) return check;

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
    return { ok: false, title: "Owner approval needed", message: OWNER_ONLY };
  }

  const redirectTo = describeRedirect(check.redirectUri);
  return {
    ok: true,
    clientId: check.clientId,
    clientName: check.clientName,
    redirectUri: check.redirectUri,
    state: check.state,
    codeChallenge: check.codeChallenge,
    wantsWrite: check.wantsWrite,
    publishedBy: check.metadataDocument ? new URL(check.clientId).hostname : null,
    redirectHost: redirectTo.host,
    redirectLocal: redirectTo.local,
    accountId: membership.accountId,
    accountName: membership.accountName ?? session.user.email ?? "your Foxhound account",
    email: session.user.email,
  };
}

/** The words for a refusal on the card. Recova showed its raw error codes
 *  (authorize_failed, unknown_client); a raw code is a Recova bug not copied. */
const EXPIRED_REQUEST = "This request is no longer valid. Start again from the app you are connecting.";
const TOO_MANY = "Too many attempts. Wait a minute and try again.";
const DEMO_REFUSED = "The demo account cannot be connected.";
const OWNER_ONLY = "Only the account owner can connect an app to this account.";
const ACCOUNT_CHANGED ="Your active account changed in another tab. Check the account above and approve again.";

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

  const form = await readForm(request);
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
    metadataDocument: check.metadataDocument ? { clientName: check.clientName, redirectUris: check.redirectUris } : null,
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

/**
 * Recova's frame: `min-h-screen flex items-center justify-center p-6` around a
 * `w-full max-w-[460px]` card with a 40px inset. The card is Capsomer's panel
 * through its HTML contract, body only, because the React Panel always draws
 * an h2 header band and this page's one heading is its h1 (the gap J62 named).
 * The wrapper puts the parts in Capsomer's amber family with Foxhound's
 * neutrals (.fh-cap), so the buttons and the focus ring are amber. The inner
 * div's 24px plus the panel body's own 16px is Recova's 40px.
 */
function ConsentCard({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg p-6">
      <div
        className="fh-cap w-full max-w-[460px] [--border-focus:var(--ring)]" data-cap-site="foxhound"
        data-family="amber"
        data-oauth-consent=""
      >
        <section className="cap-panel">
          <div className="cap-panel-body">
            <div className="p-6">{children}</div>
          </div>
        </section>
      </div>
    </main>
  );
}

/** Recova's small mono label over a block (its 11px uppercase eyebrow). */
function Eyebrow({ id, children, className = "" }: { id?: string; children: ReactNode; className?: string }) {
  return (
    <p id={id} className={`font-mono text-micro uppercase tracking-wide text-text-tertiary ${className}`}>
      {children}
    </p>
  );
}

export default function Authorize({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle" ? navigation.formData?.get("intent") : null;

  if (!loaderData.ok) {
    return (
      <ConsentCard>
        <h1 className="mb-2 text-title font-medium text-text">{loaderData.title}</h1>
        <p className="text-label text-text-subtle">{loaderData.message}</p>
      </ConsentCard>
    );
  }

  const consent = loaderData;
  const error = actionData && "error" in actionData ? actionData.error : null;

  return (
    <ConsentCard>
      <div className="mb-8">
        <Wordmark size="title" />
      </div>

      <h1 className="mb-2 text-title font-medium text-text">
        {consent.clientName} wants to connect to your Foxhound account
      </h1>
      <p className="mb-2 text-label text-text-subtle">
        Approving grants access to the account below. You can revoke it any time from Settings.
      </p>
      {/* Who the client is and where its access goes, as site-runtime's MCP
          consent page says it (mcp-login.mjs): a metadata-document client's
          name is vouched for by the host that publishes it, a registered
          client's is only its own claim. */}
      <p className="mb-6 text-label text-text-subtle" data-oauth-client="">
        {consent.publishedBy ? (
          <>
            Published by <strong className="font-medium text-text">{consent.publishedBy}</strong>.
          </>
        ) : (
          "This app registered itself, so its name is its own claim, not checked."
        )}{" "}
        Its access will be sent to <strong className="font-medium text-text">{consent.redirectHost}</strong>.
      </p>

      {consent.redirectLocal ? (
        <div className="mb-5">
          <Alert tone="warn">
            This sends access to an app on your computer. Continue only if you just started connecting from it.
          </Alert>
        </div>
      ) : null}

      <div className="mb-5 rounded-lg border border-border-sub bg-bg px-4 py-3">
        <Eyebrow className="mb-1">Account</Eyebrow>
        <p className="text-label font-medium text-text">{consent.accountName}</p>
        {consent.email ? <p className="mt-0.5 font-mono text-micro text-text-subtle">{consent.email}</p> : null}
      </div>

      <div className="mb-6">
        <Eyebrow id="oauth-can" className="mb-2">
          What {consent.clientName} can do
        </Eyebrow>
        <ul aria-labelledby="oauth-can" className="m-0 list-disc pl-4 text-label leading-relaxed text-text-secondary">
          {CONSENT_CAPABILITIES.filter((c) => !c.write).map((c) => (
            <li key={c.text}>{c.text}</li>
          ))}
        </ul>
      </div>

      {error ? (
        <div className="mb-3">
          <Alert tone="crit">{error}</Alert>
        </div>
      ) : null}

      <Form method="post">
        <input type="hidden" name="client_id" value={consent.clientId} />
        <input type="hidden" name="redirect_uri" value={consent.redirectUri} />
        <input type="hidden" name="response_type" value="code" />
        <input type="hidden" name="code_challenge" value={consent.codeChallenge} />
        <input type="hidden" name="code_challenge_method" value="S256" />
        <input type="hidden" name="account_id" value={consent.accountId} />
        {consent.state ? <input type="hidden" name="state" value={consent.state} /> : null}
        <div className="mb-6 rounded-lg border border-border-sub bg-bg px-4 py-3">
          <label className="cap-check items-start text-label">
            <input type="checkbox" name="allow_write" value="1" defaultChecked={consent.wantsWrite} className="mt-1" />
            <span>
              <span className="font-medium">Allow changes</span>
              {CONSENT_CAPABILITIES.filter((c) => c.write).map((c) => (
                <span key={c.text} className="mt-0.5 block text-text-subtle">
                  {c.text}
                </span>
              ))}
              <span className="mt-0.5 block text-text-subtle">Without this, {consent.clientName} can only read.</span>
              <span className="mt-0.5 block font-mono text-micro text-text-subtle">{MERCHANT_SCOPES.write}</span>
            </span>
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Button
            type="submit"
            name="intent"
            value="allow"
            variant="primary"
            size="lg"
            pending={submitting === "allow"}
          >
            {submitting === "allow" ? "Approving..." : "Allow access"}
          </Button>
          <Button
            type="submit"
            name="intent"
            value="deny"
            size="lg"
            pending={submitting === "deny"}
          >
            Deny
          </Button>
        </div>
      </Form>

      <p className="mt-5 text-center text-micro text-text-subtle">
        Foxhound never shares your Stripe access token with third-party clients.
      </p>
    </ConsentCard>
  );
}
