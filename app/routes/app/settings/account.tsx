import { isEmail } from "@dustinedwards/site-runtime/email";
import { data, redirect } from "react-router";
import { eq } from "drizzle-orm";
import "capsomer/banner.css";
import "capsomer/segmented.css";
import "capsomer/select.css";

import {
  accountSessions,
  passkeyLastUsed,
  passkeyRows,
  requireFreshSession,
  revokeSessionById,
  securityHistory,
  SessionNotFresh,
  signInMethods,
} from "@dustinedwards/site-runtime/sign-in";
import { isAPIError } from "better-auth/api";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";

import "capsomer/inline-confirm.css";
import {
  SignInMethodsPanel,
  type SignedInDevices,
  type SignInSettings,
} from "~/components/sign-in-settings";
import { SettingsLayout } from "capsomer/react/settings-row";
import { routerRenderLink } from "capsomer/react/link";
import { account as authAccount, getDb, passkey } from "~/db";
import { accountScope, authContext } from "~/lib/auth/context";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { applyIntelligenceContext, MRR_ERROR } from "~/lib/settings/apply.server";
import { buildAccountProfileUpdate } from "~/lib/settings/persist.server";
import { getAccount } from "~/lib/settings/queries.server";
import { cancelMerchant } from "~/lib/admin/merchant-cancel.server";
import { getBetterAuth, getSession, listMemberships, setSessionActiveAccount } from "~/lib/auth";
import type { AuthContext } from "~/lib/auth/context";
import { ownedAccountNames } from "~/lib/auth/deletion-copy";
import { isDisposableEmail } from "@dustinedwards/site-runtime/sign-in-form";
import { MEMBER_ROLE } from "~/lib/auth/roles";
import { isThemeChoice } from "capsomer/theme-server";
import { DEFAULT_THEME } from "~/lib/theme";

import type { Route } from "./+types/account";
import {
  Appearance,
  ChangeEmail,
  DangerZone,
  ProfileForm,
  SignedIn,
  type ActionResult,
} from "~/components/account-settings-parts";
import { noindexMeta } from "~/lib/seo/meta";
import { readForm } from "@dustinedwards/site-runtime/body";
import { BODY_MAX_BYTES } from "~/lib/http/body";

// The three context fields feed the recovery email prompt ("Merchant context: ..." in recovery/email-generation.ts). They are written through applyIntelligenceContext, the one writer the merchant's agent tool shares, and the name through buildAccountProfileUpdate. "Cancel account" keeps billing records, and the record of recovered payments the fees are billed on. Sign out is a button that posts.

export const meta = noindexMeta("My account - Foxhound");

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const account = await getAccount(getDb(env), auth.membership.accountId);
  if (!account) throw new Response("Not Found", { status: 404 });
  return {
    signIn: {
      ...(await signInSettings(env, auth.userId, auth.isDemo)),
      devices: await devicesOrStale(env, request, auth),
      history:
        auth.isDemo || auth.viewingAs
          ? null
          : await securityHistory(env.DB, auth.userId, SECURITY_HISTORY_SHOWN),
      // The address the passkey providers are told (the Signal API), only on this person's own page: an admin's view names someone else's passkeys.
      signalAs: auth.isDemo || auth.viewingAs ? null : { id: auth.userId, email: auth.email },
    },
    account,
    cancelledAt: account.cancelledAt,
    userEmail: auth.email,
    // Every account this person owns, which a deletion clears, so the confirmation can say which. From the session's memberships, so this loader reads no other account's rows.
    ownedAccountNames: ownedAccountNames(auth.memberships),
    // The theme this account stores, which is the one the root drew the page in: accounts.theme is NOT NULL, so for a signed-in merchant resolveThemePreference always takes it (lib/theme.ts).
    theme: isThemeChoice(account.theme) ? account.theme : DEFAULT_THEME,
    // Only the owner may cancel the account; the action enforces it, this only decides whether to draw the control (team.tsx does the same).
    isOwner: auth.membership.role === MEMBER_ROLE.OWNER,
    // The demo saves nothing, the theme included (lib/settings/theme-choice.ts).
    isDemo: auth.isDemo,
  };
}

/** The Sign-in panel's lists: this person's passkeys, as site-runtime's accountPasskeys gives them, each with its credential id for the Signal API on removal; and which of Google and Apple are joined. Read from Better Auth's tables by the session's user (as delete-account.server.ts does), not through accountPasskeys's own session read, which an admin's read-only view does not have. The demo changes nothing, so it lists none. */
async function signInSettings(
  env: Env,
  userId: string,
  isDemo: boolean,
): Promise<Omit<SignInSettings, "devices" | "history" | "signalAs">> {
  const methods = signInMethods(env, { social: true });
  const offered = [
    methods.google ? { id: "google" as const, label: "Google" } : null,
    methods.apple ? { id: "apple" as const, label: "Apple" } : null,
  ].filter((p) => p !== null);
  if (isDemo) return { passkeys: [], providers: offered.map((p) => ({ ...p, accountId: null })) };
  const db = getDb(env);
  const [stored, lastUsed, joined] = await Promise.all([
    db
      .select({
        id: passkey.id,
        name: passkey.name,
        aaguid: passkey.aaguid,
        createdAt: passkey.createdAt,
        credentialId: passkey.credentialID,
      })
      .from(passkey)
      .where(eq(passkey.userId, userId)),
    passkeyLastUsed(env.DB, userId),
    db
      .select({ id: authAccount.id, providerId: authAccount.providerId })
      .from(authAccount)
      .where(eq(authAccount.userId, userId)),
  ]);
  const credentialOf = new Map(stored.map((p) => [p.id, p.credentialId]));
  const byProvider = new Map(joined.map((a) => [a.providerId, a.id]));
  return {
    passkeys: passkeyRows(stored, lastUsed).map((p) => ({
      ...p,
      credentialId: credentialOf.get(p.id) ?? "",
    })),
    providers: offered.map((p) => ({ ...p, accountId: byProvider.get(p.id) ?? null })),
  };
}

/** Where this person is signed in, from Better Auth's own list, which wants a sign-in from the last 10 minutes: "stale" until then, and the panel asks for one, as adding a passkey does. The demo and an admin's read-only view list none: the request's session is not this person's. */
async function devicesOrStale(
  env: Env,
  request: Request,
  auth: AuthContext,
): Promise<SignedInDevices> {
  if (auth.isDemo || auth.viewingAs) return null;
  return (await accountSessions(await getBetterAuth(env), request)) ?? "stale";
}

const SECURITY_HISTORY_SHOWN = 10;

/** The session when it was made in the last 10 minutes (site-runtime
 *  requireFreshSession), else null, which the page answers by asking for a
 *  new sign-in. */
async function freshSession(env: Env, request: Request) {
  return requireFreshSession(await getBetterAuth(env), request).catch((error: unknown) => {
    if (error instanceof SessionNotFresh) return null;
    throw error;
  });
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env, auth, accountId } = accountScope(context);
  const form = await readForm(request, BODY_MAX_BYTES);
  const intent = String(form.get("_action") ?? "");

  switch (intent) {
    case "profile": {
      // One save for the name and the three context fields. Each context field is passed only when the form carries it (`formData.has(...)`): a Customer Type with no radio chosen posts nothing and leaves the stored value alone, where reading it as blank would clear it.
      const name = String(form.get("name") ?? "").trim();
      if (!name) {
        // An empty name is refused before anything is written: the name is the business's name in the header and in every recovery email's prompt.
        return data<ActionResult>(
          {
            action: intent,
            ok: false,
            error: "Account name is required.",
            field: "name",
          },
          { status: 400 },
        );
      }
      const posted = (key: string) => (form.has(key) ? String(form.get(key)) : undefined);
      try {
        // ONE BATCH, all or nothing: the name's update rides in the context's batch. The context's MRR check refuses before anything is committed, so a refused save writes nothing, the name included.
        const db = getDb(env);
        const result = await applyIntelligenceContext(
          db,
          accountId,
          {
            merchantIndustry: posted("merchantIndustry"),
            primaryCustomerType: posted("primaryCustomerType"),
            merchantMrrSelfReported: posted("merchantMrrSelfReported"),
          },
          undefined,
          [buildAccountProfileUpdate(db, accountId, { name })],
        );
        if (!result.ok) {
          return data<ActionResult>(
            result.error === MRR_ERROR
              ? {
                  action: intent,
                  ok: false,
                  error: result.error,
                  field: "merchantMrrSelfReported",
                }
              : { action: intent, ok: false, error: result.error },
            { status: 400 },
          );
        }
      } catch (err) {
        // A failed update answers with the SaveBar line, not an error page. The whole error is logged, stack included; it carries no form values.
        console.error("account settings write failed:", err);
        return data<ActionResult>({ action: intent, ok: false }, { status: 500 });
      }
      return data<ActionResult>({ action: intent, ok: true });
    }
    case "cancel-account": {
      // OWNER ONLY, refused before any read or write. Canceling disconnects every Stripe connection and stops all recovery on the account, so a member never does it (same shape as team.tsx's gate).
      if (auth.membership.role !== MEMBER_ROLE.OWNER) {
        return data<ActionResult>(
          { action: intent, ok: false, error: "Only the account owner can cancel the account." },
          { status: 403 },
        );
      }
      // Canceling an account is on the HUMAN-FOREVER denylist: no agent tool reaches it.
      const db = getDb(env);
      const outcome = await cancelMerchant(env, accountId);
      // Move this session to another account the caller holds, if any. With none left, the marker is cleared and the app shell lands them on the signed-in empty state at /connect, as an accountless session does.
      const session = await getSession(env, request);
      if (session) {
        const remaining = (await listMemberships(db, auth.userId)).filter(
          (m) => m.accountId !== accountId,
        );
        if (remaining.length > 0) {
          await setSessionActiveAccount(db, session.session.id, remaining[0].accountId);
        }
      }
      return data<ActionResult>({
        action: intent,
        ok: true,
        warning:
          outcome.deauthorizeErrors.length > 0
            ? "Account canceled. Revoking access at Stripe did not complete for every connection, so check your Stripe dashboard."
            : undefined,
      });
    }
    case "delete-account": {
      // A sign-in from the last 10 minutes first (site-runtime requireFreshSession, the rule Better Auth holds its own risky changes to): a borrowed or forgotten session cannot delete the account. Stale answers as signing a device out does, and the page asks for a new sign-in.
      const fresh = await freshSession(env, request);
      if (!fresh)
        return data<ActionResult>({ action: intent, ok: false, error: "stale" }, { status: 403 });
      // Better Auth's own delete (/delete-user), for the SIGNED-IN user only: it takes no id, so a person deletes themselves and nobody else. Foxhound's deletion runs in its hooks (delete-account.server.ts), and site-runtime's log line and notice follow it. Its answer clears the session cookie, and the person goes to "/".
      let deleted: Response | null = null;
      try {
        deleted = await (
          await getBetterAuth(env)
        ).api.deleteUser({ body: {}, headers: request.headers, asResponse: true });
      } catch (err) {
        console.error("account deletion failed:", err);
      }
      if (!deleted?.ok) {
        if (deleted)
          logEvent("account_deletion_failed", { status: deleted.status }, { level: "error" });
        return data<ActionResult>(
          {
            action: intent,
            ok: false,
            error: "Failed to delete account. Please contact support.",
          },
          { status: 500 },
        );
      }
      const headers = new Headers();
      for (const cookie of deleted.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
      return redirect("/", { headers });
    }
    case "change-email": {
      // Through Better Auth's /change-email: the link goes to the CURRENT address first (auth.server.ts). A sign-in from the last 10 minutes first, as for delete; site-runtime refuses the endpoint without one too.
      const fresh = await freshSession(env, request);
      if (!fresh)
        return data<ActionResult>({ action: intent, ok: false, error: "stale" }, { status: 403 });
      const newEmail = String(form.get("newEmail") ?? "")
        .trim()
        .toLowerCase();
      const refuse = (error: string) =>
        data<ActionResult>({ action: intent, ok: false, error }, { status: 400 });
      if (!isEmail(newEmail)) return refuse("Enter an email address.");
      if (newEmail === fresh.user.email.toLowerCase())
        return refuse("That is already your address.");
      if (isDisposableEmail(newEmail)) return refuse("Disposable email addresses are not allowed.");
      // An address nobody has confirmed would get the link at the new address alone (Better Auth's other branch), so it is refused: every way into Foxhound confirms the address, so this is only ever an old account.
      if (!fresh.user.emailVerified)
        return refuse("Sign in with an email link first, then change your address.");
      try {
        await (
          await getBetterAuth(env)
        ).api.changeEmail({
          body: { newEmail },
          headers: request.headers,
        });
      } catch (error) {
        if (isAPIError(error) && error.body?.code === "SESSION_NOT_FRESH") {
          return data<ActionResult>({ action: intent, ok: false, error: "stale" }, { status: 403 });
        }
        logEvent("email_change_failed", { error: errorMessage(error) }, { level: "error" });
        return data<ActionResult>(
          { action: intent, ok: false, error: "The email was not sent. Try again in a minute." },
          { status: 500 },
        );
      }
      // Better Auth answers the same whether or not the new address is taken,
      // so this says nothing about it either.
      return data<ActionResult>({ action: intent, ok: true, sentTo: fresh.user.email });
    }
    case "sign-out-device": {
      // By the session's id, so no session token reaches the page (site-runtime ./sign-in).
      try {
        const ok = await revokeSessionById(
          await getBetterAuth(env),
          request,
          String(form.get("session") ?? ""),
        );
        return data<ActionResult>({ action: intent, ok }, { status: ok ? 200 : 404 });
      } catch (error) {
        if (!isAPIError(error) || error.body?.code !== "SESSION_NOT_FRESH") throw error;
        return data<ActionResult>({ action: intent, ok: false, error: "stale" }, { status: 403 });
      }
    }
    default:
      return data<ActionResult>(
        { action: intent, ok: false, error: "Unknown settings action." },
        { status: 400 },
      );
  }
}

export default function AccountSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { account, cancelledAt, userEmail, ownedAccountNames, theme, isOwner, isDemo } = loaderData;
  const result = actionData as ActionResult | undefined;

  return (
    <SettingsLayout renderLink={routerRenderLink} title="My account">
      <div className="fh-account-top">
        <ProfileForm account={account} result={result?.action === "profile" ? result : undefined} />
      </div>

      <Appearance initial={theme ?? DEFAULT_THEME} isDemo={Boolean(isDemo)} />

      <div className="fh-account-part">
        <SignInMethodsPanel initial={loaderData.signIn} isDemo={Boolean(isDemo)} />
      </div>

      <div className="fh-account-part">
        <section className="cap-panel">
          <div className="cap-panel-body">
            <SignedIn userEmail={userEmail} />
            {isDemo ? null : <ChangeEmail result={result} />}
            <DangerZone
              cancelledAt={cancelledAt}
              isOwner={Boolean(isOwner)}
              ownedAccountNames={ownedAccountNames}
              result={result}
            />
          </div>
        </section>
      </div>
    </SettingsLayout>
  );
}
