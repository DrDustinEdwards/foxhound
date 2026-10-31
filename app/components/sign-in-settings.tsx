import { Alert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { useState } from "react";
import { useRevalidator } from "react-router";

import { authClient, signInAgainIfStale } from "~/lib/auth/client";
import { DEMO_READ_ONLY_MESSAGE } from "~/lib/demo/session";

/** What /settings/account's loader reads for this panel. */
export type SignInSettings = {
  passkeys: { id: string; name: string }[];
  /** The providers Foxhound offers, and the joined account's id for each. */
  providers: { id: "google" | "apple"; label: string; accountId: string | null }[];
};

/**
 * How this person signs in (site-runtime ./sign-in): their passkeys, and
 * Google or Apple joined to the account. Joining happens only here, while
 * signed in, never by a matching email at sign-in. The email link always
 * works, so nothing here can lock anyone out. Each change is Better Auth's
 * own endpoint through the client, then the loader reads the list again.
 */
export function SignInMethodsPanel({ initial, isDemo }: { initial: SignInSettings; isDemo: boolean }) {
  const revalidator = useRevalidator();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
                    void run(p.id, () => authClient.passkey.deletePasskey({ id: p.id }), "The passkey was not removed.")
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

        {error ? (
          <div className="mt-4">
            <Alert tone="crit">{error}</Alert>
          </div>
        ) : null}
      </div>
    </section>
  );
}
