import type { HeaderSwitcher } from "capsomer/react/site-header";

import { ADD_ACCOUNT_PATH } from "~/lib/nav/paths";

// The business switcher: which account you are acting as. Ruling 326 phase (e)
// built it to legacy's components/AccountSwitcher.tsx (blob `70567b69`) as a
// round avatar in the right-hand cluster. Dustin's answer 3 of 2026-10-13
// (docs/design/design-site-header.md in capsomer, recorded in
// parity/APPROVED-DIFFERENCES.md) moves it to the LEFT of Capsomer's site
// header as a square tile with the business's initial, before the product
// switcher: "Acme Supply Co. / Recovery". A square is the business you are in,
// a circle is you. Its panel is Capsomer's (a disclosure button over a list,
// Esc and light dismiss included); what it holds is still legacy's: every
// account, then + Add account.

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

/** A switch is a POST, not a page, so an account's row carries this marker in
 *  place of an href and the header's link renderer draws a button for it
 *  (app/components/site-header.tsx). The marker names which endpoint the
 *  switch posts to, legacy's `switchAccountUrl` (SiteNav.tsx): the session's
 *  own accounts, or the demo's businesses. */
export const ACCOUNT_SWITCH_URL = "/api/account/switch";
export const DEMO_ACCOUNT_SWITCH_URL = "/api/demo/switch-account";

const SWITCH_PREFIXES: Record<string, string> = {
  [ACCOUNT_SWITCH_URL]: "#switch-account:",
  [DEMO_ACCOUNT_SWITCH_URL]: "#switch-demo-account:",
};

function switchAccountHref(accountId: string, switchAccountUrl: string): string {
  return `${SWITCH_PREFIXES[switchAccountUrl] ?? SWITCH_PREFIXES[ACCOUNT_SWITCH_URL]}${accountId}`;
}

export function switchTargetFromHref(href: string): { accountId: string; switchAccountUrl: string } | null {
  for (const [switchAccountUrl, prefix] of Object.entries(SWITCH_PREFIXES)) {
    if (href.startsWith(prefix)) return { accountId: href.slice(prefix.length), switchAccountUrl };
  }
  return null;
}

let switching = false;

/** The switch itself goes to phase (b)'s action, then a HARD navigation, legacy's
 *  pattern (AccountSwitcher.tsx:55-59): every loader on the page resolved through
 *  the old marker, so a soft navigation would leave stale account data on screen.
 *  Pathname plus search, so a switch does not carry a fragment across accounts.
 *  `assign()` rather than legacy's `location.href = ...`: identical behavior,
 *  and the react-hooks/immutability rule rejects the assignment form. */
export async function switchAccount(accountId: string, switchAccountUrl = ACCOUNT_SWITCH_URL): Promise<void> {
  // One switch at a time, as the old menu's disabled rows had it: a second
  // click before the reload would race two POSTs for the session marker.
  if (switching) return;
  switching = true;
  try {
    await fetch(switchAccountUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId }),
    });
  } catch (error) {
    switching = false;
    throw error;
  }
  window.location.assign(window.location.pathname + window.location.search);
}

function Tile({ initial }: { initial: string }) {
  return (
    <span className="fh-account-tile" aria-hidden>
      {initial}
    </span>
  );
}

/** The header's business switcher, or null when there is nothing to switch.
 *
 *  LEGACY'S RENDER RULE, read from components/SiteNavClient.tsx:
 *  `accounts.length > 0 && (multiSeat || (isAuthenticated && hasAccount))`.
 *  Legacy SHOWS the switcher at ONE account, listing that account and the
 *  + Add account row; it is hidden only when the visitor has no account at
 *  all. Callers gate on `accounts.length > 0`; this returns null for an empty
 *  list too, so the anonymous header can never draw one. The tile's letter is
 *  the ACTIVE ACCOUNT's (legacy's accountInitial), so it changes on a switch. */
export function businessSwitcher(
  accounts: SwitcherAccount[],
  activeAccountId: string | null,
  switchAccountUrl: string = ACCOUNT_SWITCH_URL,
): HeaderSwitcher | null {
  const active = accounts.find((a) => a.id === activeAccountId) ?? accounts[0];
  if (!active) return null;
  return {
    id: "business",
    label: accountLabel(active),
    name: `Switch account: ${accountLabel(active)}`,
    tile: accountInitial(active),
    sheetLabel: "Accounts",
    groups: [
      {
        label: "Accounts",
        links: [
          ...accounts.map((a) => ({
            id: a.id,
            label: accountLabel(a),
            // The account you are on is marked current; its row switches
            // nothing (the renderer skips a current row), as legacy's did.
            href: switchAccountHref(a.id, switchAccountUrl),
            current: a.id === active.id,
            icon: <Tile initial={accountInitial(a)} />,
          })),
          // Legacy's own + Add account row points at /connect
          // (AccountSwitcher.tsx:112), which falls through to the callback's
          // upsert branch and attaches the new Stripe account to the user's
          // FIRST account instead of creating a second one. Ruling 326 named
          // that DEFECT 1 and ruled the INTENT ported, never the transport, so
          // this points at the marked add-account route instead. It sits in the
          // accounts' own list, so the phone's sheet shows one Accounts group.
          { id: "add-account", label: "+ Add account", href: ADD_ACCOUNT_PATH },
        ],
      },
    ],
  };
}
