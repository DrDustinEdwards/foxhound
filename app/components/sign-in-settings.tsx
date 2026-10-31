import { Alert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { useState } from "react";
import { useFetcher, useRevalidator } from "react-router";
import type { SecurityHistoryEntry } from "@dustinedwards/site-runtime/sign-in";
import { signalUnknownCredential } from "@dustinedwards/site-runtime/sign-in-client";

import { authClient, signInAgain, signInAgainIfStale } from "~/lib/auth/client";
import { formatDateShort } from "~/lib/date-format";
import { DEMO_READ_ONLY_MESSAGE } from "~/lib/demo/session";

/** Where this person is signed in (site-runtime's sessionRows, current first);
 *  "stale" when listing them needs a fresh sign-in; null when not shown. */
export type SignedInDevices =
  | { id: string; device: string | null; signedInAt: Date; lastActiveAt: Date; current: boolean }[]
  | "stale"
  | null;

/** What /settings/account's loader reads for this panel. */
export type SignInSettings = {
  /** `name` is passkeyLabel's: the name, else the provider's, else "Passkey". */
  passkeys: { id: string; name: string; credentialId: string }[];
  /** The providers Foxhound offers, and the joined account's id for each. */
  providers: { id: "google" | "apple"; label: string; accountId: string | null }[];
  devices: SignedInDevices;
  /** The latest sign-ins and sign-in changes (site-runtime securityHistory),
   *  newest first; null when not shown. */
  history: SecurityHistoryEntry[] | null;
};

const WAY_IN: Record<string, string> = {
  link: "an email link",
  code: "an emailed code",
  passkey: "a passkey",
  google: "Google",
  apple: "Apple",
};
const PROVIDER: Record<string, string> = { google: "Google", apple: "Apple" };

/** One history row in words, such as "Signed in with a passkey". */
function historyLabel({ kind, via }: Pick<SecurityHistoryEntry, "kind" | "via">): string {
  const provider = (via && PROVIDER[via]) ?? "A sign-in method";
  switch (kind) {
    case "sign-in":
      return via && WAY_IN[via] ? `Signed in with ${WAY_IN[via]}` : "Signed in";
    case "passkey-added":
      return "Passkey added";
    case "passkey-removed":
      return "Passkey removed";
    case "sign-in-linked":
      return `${provider} connected`;
    case "sign-in-unlinked":
      return `${provider} disconnected`;
    case "email-changed":
      return "Email address changed";
    case "recovery":
      return "Signed in by email with no passkey left; other devices signed out";
  }
}

/**
 * How this person signs in (site-runtime ./sign-in): their passkeys, and
 * Google or Apple joined to the account. Joining happens only here, while
 * signed in, never by a matching email at sign-in. The email link always
 * works, so nothing here can lock anyone out. Each change is Better Auth's
 * own endpoint through the client, then the loader reads the list again.
 * Below them, the devices signed in, each of which can be signed out, and the
 * latest sign-ins and sign-in changes.
 */
export function SignInMethodsPanel({ initial, isDemo }: { initial: SignInSettings; isDemo: boolean }) {
  const revalidator = useRevalidator();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signOut = useFetcher<{ ok: boolean; error?: string }>();
  const signOutFailed =
    signOut.state === "idle" && signOut.data?.ok === false
      ? signOut.data.error === "stale"
        ? "Sign in again, then sign that device out."
        : "That device was not signed out."
      : null;

  async function run(key: string, change: () => Promise<{ error?: unknown } | null | undefined>, failed: string) {
    // One change at a time; Capsomer's buttons are never disabled, so a
    // press while another runs does nothing.
    if (busy !== null) return;
    setError(null);
    // The demo saves nothing, as DemoGuardedForm refuses every other write.
    if (isDemo) {
      setError(DEMO_READ_ONLY_MESSAGE);
      return;
    }
    setBusy(key);
    try {
      const res = await change();
      if (signInAgainIfStale(res?.error)) return;
      if (res?.error) {
        const message = (res.error as { message?: string }).message;
        setError(message ? `${failed} ${message}` : failed);
        return;
      }
      await revalidator.revalidate();
    } catch {
      setError(`${failed} Check your connection and try again.`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="cap-panel">
      <div className="cap-panel-body">
        <h2 className="mb-2 text-label font-semibold text-text">Sign-in</h2>
        <p className="mb-4 text-label text-text-tertiary">
          A passkey signs you in with your face, fingerprint or device PIN. It only works on Foxhound, so it
          cannot be phished. You can always sign in with an email link too.
        </p>

        {initial.passkeys.length > 0 ? (
          <ul className="mb-4 flex flex-col gap-2">
            {initial.passkeys.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3">
                <span className="text-label text-text">{p.name}</span>
                <Button
                  size="sm"
                  pending={busy === p.id}
                  onClick={() =>
                    void run(
                      p.id,
                      async () => {
                        const res = await authClient.passkey.deletePasskey({ id: p.id });
                        // Tell the browser's password manager it is gone, so
                        // it stops offering it (where the browser can). The
                        // relying party is this host, BETTER_AUTH_URL's.
                        if (!res?.error) {
                          await signalUnknownCredential({ rpId: location.hostname, credentialId: p.credentialId });
                        }
                        return res;
                      },
                      "The passkey was not removed.",
                    )
                  }
                >
                  Remove passkey<span className="sr-only"> {p.name}</span>
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <Button
          variant="primary"
          pending={busy === "add"}
          onClick={() => void run("add", () => authClient.passkey.addPasskey(), "The passkey was not saved.")}
        >
          {busy === "add" ? "Waiting for your device..." : "Create a passkey"}
        </Button>

        {initial.providers.length > 0 ? (
          <ul className="mt-5 flex flex-col gap-2 border-t border-border pt-5">
            {initial.providers.map((provider) => (
              <li key={provider.id} className="flex items-center justify-between gap-3">
                <span className="text-label text-text">
                  {provider.label}: {provider.accountId ? "connected" : "not connected"}
                </span>
                {provider.accountId ? (
                  <Button
                    size="sm"
                    pending={busy === provider.id}
                    onClick={() =>
                      void run(
                        provider.id,
                        () => authClient.unlinkAccount({ accountId: provider.accountId ?? "" }),
                        `${provider.label} was not disconnected.`,
                      )
                    }
                  >
                    Disconnect {provider.label}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    pending={busy === provider.id}
                    onClick={() =>
                      void run(
                        provider.id,
                        () => authClient.linkSocial({ provider: provider.id, callbackURL: "/settings/account" }),
                        `${provider.label} was not connected.`,
                      )
                    }
                  >
                    Connect<span className="sr-only"> {provider.label}</span>
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : null}

        {initial.devices === "stale" ? (
          <div className="mt-5 border-t border-border pt-5">
            <h3 className="mb-2 text-label font-semibold text-text">Signed-in devices</h3>
            <p className="mb-3 text-label text-text-tertiary">Sign in again to see where you are signed in.</p>
            <Button size="sm" onClick={signInAgain}>
              Sign in again
            </Button>
          </div>
        ) : initial.devices ? (
          <div className="mt-5 border-t border-border pt-5">
            <h3 className="mb-3 text-label font-semibold text-text">Signed-in devices</h3>
            <ul className="mb-4 flex flex-col gap-2">
              {initial.devices.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-3">
                  <span className="text-label text-text">
                    {d.device ?? "Unknown device"}
                    {d.current ? " (this device)" : null}
                    <span className="block text-text-tertiary">
                      Signed in {formatDateShort(d.signedInAt)}, last active {formatDateShort(d.lastActiveAt)}
                    </span>
                  </span>
                  {d.current ? null : (
                    <signOut.Form method="post">
                      <input type="hidden" name="_action" value="sign-out-device" />
                      <input type="hidden" name="session" value={d.id} />
                      <Button type="submit" size="sm" pending={signOut.formData?.get("session") === d.id}>
                        Sign out<span className="sr-only"> {d.device ?? "Unknown device"}</span>
                      </Button>
                    </signOut.Form>
                  )}
                </li>
              ))}
            </ul>
            {initial.devices.length > 1 ? (
              <Button
                pending={busy === "others"}
                onClick={() =>
                  void run("others", () => authClient.revokeOtherSessions(), "The other devices were not signed out.")
                }
              >
                Sign out all other devices
              </Button>
            ) : null}
          </div>
        ) : null}

        {initial.history ? (
          <div className="mt-5 border-t border-border pt-5">
            <h3 className="mb-3 text-label font-semibold text-text">Recent security activity</h3>
            {initial.history.length === 0 ? (
              <p className="text-label text-text-tertiary">Nothing yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {initial.history.map((h, i) => (
                  <li key={`${h.at.toISOString()}-${i}`} className="text-label text-text">
                    {historyLabel(h)}
                    <span className="block text-text-tertiary">
                      {[formatDateShort(h.at), h.device, h.location].filter(Boolean).join(", ")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        {error || signOutFailed ? (
          <div className="mt-4">
            <Alert tone="crit">{error ?? signOutFailed}</Alert>
          </div>
        ) : null}
      </div>
    </section>
  );
}
