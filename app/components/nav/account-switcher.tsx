import { useEffect, useRef, useState } from "react";

import { ADD_ACCOUNT_PATH } from "~/lib/nav/paths";

// Legacy components/AccountSwitcher.tsx (blob `70567b69`, 4,367 bytes), ported
// at its own geometry. Ruling 326 phase (e); the schema (a), the session marker
// and the switch action (b) shipped first, because this control cannot exist
// ahead of them.
//
// EVERY CLASS BELOW IS LEGACY'S, with two substitutions and one correction, all
// named rather than left to be diffed:
//
//   - `text-[0.8125rem]` becomes `text-label` and `text-[0.6875rem]` becomes
//     `text-micro`. These are Foxhound's semantic tokens for the SAME computed
//     values (`--text-label: 0.8125rem`, `--text-micro: 0.6875rem` in app.css),
//     so the render is identical and the house no-arbitrary-values rule holds.
//   - THE PRESENCE DOT IS CORRECTED TOWARD LEGACY. The avatar this replaces
//     carried `bg-amber-dark ring-2 ring-chrome`; legacy's is `bg-amber` with no
//     ring (AccountSwitcher.tsx:73). No ruling ever ratified the difference, and
//     the PRIME DIRECTIVE makes an unratified divergence a defect to correct
//     rather than a decision to defend. Ruling 48 governs the disc being
//     translucent rather than amber-filled, which is unchanged.
//
// LEGACY BEHAVIOUR NOT PORTED, because legacy does not have it: there is no
// Escape handler. Legacy closes on outside mousedown only
// (AccountSwitcher.tsx:36-45). Recorded as an accessibility gap in
// parity/MULTI-ACCOUNT-SCOPE.md rather than silently improved here, because a
// keyboard affordance legacy lacks is a divergence either way and the seat rules
// on which one ships.

export interface SwitcherAccount {
  id: string;
  name: string | null;
  stripeUserId: string | null;
}

/** Legacy's `accountLabel`: name, else the Stripe account id, else the first
 *  eight characters of the Foxhound account id (AccountSwitcher.tsx:18-20). The
 *  last fallback is why a nameless, unconnected account still renders something
 *  a human can tell apart from another one. */
export function accountLabel(a: SwitcherAccount): string {
  return a.name || a.stripeUserId || a.id.slice(0, 8);
}

/** Legacy's `accountInitial`, the label's first character uppercased. */
export function accountInitial(a: SwitcherAccount): string {
  return accountLabel(a).charAt(0).toUpperCase();
}

export function AccountSwitcher({
  accounts,
  activeAccountId,
  switchAccountUrl = "/api/account/switch",
}: {
  accounts: SwitcherAccount[];
  activeAccountId?: string;
  /** Legacy passes this per section (SiteNav.tsx picks the demo endpoint for
   *  demo pages). Foxhound's demo shell does not render this control at all, so
   *  the default is the only value in use today. */
  switchAccountUrl?: string;
}) {
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Legacy's close-on-outside-click, mousedown rather than click so a drag that
  // starts outside closes it too (AccountSwitcher.tsx:36-45).
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  async function switchAccount(accountId: string) {
    if (accountId === activeAccountId || switching) return;
    setSwitching(true);
    await fetch(switchAccountUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId }),
    });
    // Legacy's pattern verbatim (AccountSwitcher.tsx:55-59): a HARD navigation,
    // not a client-side one. Every loader on the page resolved through the old
    // marker, so a soft navigation would leave stale account data on screen; the
    // full reload is what guarantees the whole tree re-reads. Pathname plus
    // search, so a switch does not carry a fragment across accounts.
    //
    // `assign()` rather than legacy's `location.href = ...`. Identical
    // behaviour, including the history entry; the react-hooks/immutability rule
    // rejects the assignment form, and a lint suppression to keep legacy's
    // spelling would be trading a real rule for a cosmetic match.
    window.location.assign(window.location.pathname + window.location.search);
  }

  const active = accounts.find((a) => a.id === activeAccountId) ?? accounts[0];
  if (!active) return null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Switch account"
        aria-expanded={open}
        aria-haspopup="menu"
        className="relative flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border border-white/20 bg-white/10 transition-colors duration-150 hover:border-amber"
      >
        <span className="font-mono text-micro font-medium leading-none text-chrome-text">
          {accountInitial(active)}
        </span>
        <span className="absolute right-0 bottom-0 h-2 w-2 rounded-full bg-amber" aria-hidden />
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute top-full right-0 z-50 mt-1 min-w-[200px] rounded-md border border-border bg-surface py-1 shadow-lg"
        >
          {accounts.map((a) => {
            const isActive = a.id === activeAccountId;
            return (
              <button
                key={a.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  if (!isActive) switchAccount(a.id);
                }}
                disabled={switching}
                className={`flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-3 py-2 text-left text-label transition-opacity duration-150 hover:opacity-80 disabled:opacity-40 ${
                  isActive ? "font-semibold text-text" : "text-text-tertiary"
                }`}
              >
                <span className="relative inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-bg">
                  <span className="font-mono text-micro font-medium leading-none text-text-tertiary">
                    {accountInitial(a)}
                  </span>
                  {isActive ? (
                    <span
                      className="absolute right-0 bottom-0 h-1.5 w-1.5 rounded-full bg-amber"
                      aria-hidden
                    />
                  ) : null}
                </span>
                <span className="truncate">{accountLabel(a)}</span>
              </button>
            );
          })}

          <div className="my-1 border-t border-border" />

          {/* Legacy's own + Add account row points at /connect
              (AccountSwitcher.tsx:112), which falls through to the callback's
              upsert branch and attaches the new Stripe account to the user's
              FIRST account instead of creating a second one. Ruling 326 named
              that DEFECT 1 and ruled the INTENT ported, never the transport, so
              this points at the marked add-account route instead. */}
          <a
            href={ADD_ACCOUNT_PATH}
            onClick={() => setOpen(false)}
            className="block px-3 py-2 text-label text-text-tertiary no-underline transition-opacity duration-150 hover:opacity-80"
          >
            + Add account
          </a>
        </div>
      ) : null}
    </div>
  );
}
