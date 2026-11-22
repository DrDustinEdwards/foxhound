import type { HeaderSwitcher } from "capsomer/react/site-header";

import { ADD_ACCOUNT_PATH } from "~/lib/nav/paths";

// The business switcher: which account you are acting as. A square tile with the business's initial on the left of Capsomer's site header, before the product switcher ("Acme Supply Co. / Recovery"): a square is the business you are in, a circle is you. Its panel is Capsomer's (a disclosure button over a list, Esc and light dismiss included): every account, then + Add account.

export interface SwitcherAccount {
  id: string;
  name: string | null;
  stripeUserId: string | null;
}

/** Name, else the Stripe account id, else the first eight characters of the Foxhound account id, so a nameless, unconnected account still renders something a human can tell apart from another one. */
export function accountLabel(a: SwitcherAccount): string {
  return a.name || a.stripeUserId || a.id.slice(0, 8);
}

/** The label's first character uppercased. */
function accountInitial(a: SwitcherAccount): string {
  return accountLabel(a).charAt(0).toUpperCase();
}

/** Where a switch posts: the session's own accounts, or the demo's businesses. A switch is a POST, not a page, so an account's row has no href: Capsomer draws it as a button whose onClick switches. */
export const ACCOUNT_SWITCH_URL = "/api/account/switch";
export const DEMO_ACCOUNT_SWITCH_URL = "/api/demo/switch-account";

let switching = false;

/** The switch posts the action, then a HARD navigation: every loader on the page resolved through the old marker, so a soft navigation would leave stale account data on screen. Pathname plus search, so a switch does not carry a fragment across accounts. `assign()` because the react-hooks/immutability rule rejects assigning location.href. */
async function switchAccount(
  accountId: string,
  switchAccountUrl = ACCOUNT_SWITCH_URL,
): Promise<void> {
  // One switch at a time: a second click before the reload would race two POSTs for the session marker.
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

/** The header's business switcher, or null when there is nothing to switch. It is shown from one account (listing it and the + Add account row) and hidden only when the visitor has no account. Callers gate on `accounts.length > 0`; this returns null for an empty list too, so the anonymous header can never draw one. The tile's letter is the active account's, so it changes on a switch. */
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
            // The account you are on is marked current; its row switches nothing.
            current: a.id === active.id,
            onClick:
              a.id === active.id ? undefined : () => void switchAccount(a.id, switchAccountUrl),
            icon: <Tile initial={accountInitial(a)} />,
          })),
          // + Add account points at the marked add-account route, not /connect: /connect falls through to the callback's upsert branch and attaches the new Stripe account to the user's FIRST account instead of creating a second one. It sits in the accounts' own list, so the phone's sheet shows one Accounts group.
          { id: "add-account", label: "+ Add account", href: ADD_ACCOUNT_PATH },
        ],
      },
    ],
  };
}
