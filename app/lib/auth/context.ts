import { createContext } from "react-router";

import type { Membership } from "./account";

// Populated by the app-shell server middleware once the caller is proven to have
// a session AND a resolved account. Loaders/actions under the app shell read this
// instead of re-querying the session and membership.
export interface AuthContext {
  userId: string;
  userName: string;
  email: string;
  membership: Membership;
  /** Every account this caller actively belongs to, earliest first, with the
   *  resolved one among them. Ruling 326 phase (b). Legacy's equivalent is
   *  `resolveAccount`'s `allMemberships`, returned "so callers (e.g. nav) can
   *  render an account switcher" (lib/account.ts:70-74, blob `9bb58874`).
   *
   *  NOTHING READS IT YET, deliberately: the switcher is phase (e) and this
   *  session moves no pixels. It is populated now because `guards.ts` already
   *  has the list in hand to resolve `membership`, so carrying it costs nothing
   *  and phase (e) needs no new query on every authenticated request.
   *
   *  IT DOES NOT CARRY `stripe_user_id`, and that is legacy's structure rather
   *  than an omission. Legacy assembles the switcher's
   *  `{id, name, stripe_user_id}` shape in components/SiteNav.tsx:73-90 (blob
   *  `21f28324`) with a SEPARATE query over `stripe_connections` filtered to
   *  `is_primary = true`; `resolveAccount` never joins it. Phase (e) does the
   *  same in the nav's own loader, which also keeps a stripe_connections join
   *  off the path of every authenticated request.
   *
   *  In the demo branch this is the single demo membership, so a switcher can
   *  never offer a demo visitor a real account. */
  memberships: Membership[];
  /** The account this request acts as, always equal to `membership.accountId`.
   *
   *  THE RESOLVED ID, NOT THE RAW `session.active_account_id`. The raw column
   *  may be null (no switch yet) or stale (it names an account the user has
   *  since left), and a consumer reading it would act on an account the request
   *  is not actually scoped to. Everything downstream that needs "which account
   *  am I on" gets the answer the resolver already committed to. */
  activeAccountId: string;
  isAdmin: boolean;
  /** True when this is a read-only demo view (the app-shell middleware
   *  injected the demo account). Never an admin. Loaders may use it to hide
   *  write affordances; the hard read-only guarantee is the middleware's
   *  method gate, not any single loader. A real session MAY also exist
   *  alongside this (see demoSignedIn) - TASK-foxhound-demo-access-parity.md's
   *  demo-over-session precedence means isDemo no longer implies "anonymous". */
  isDemo: boolean;
  /** True when isDemo is true AND the caller also has a real, valid session
   *  (they are signed in but currently viewing the demo instead of their own
   *  account). Always false when isDemo is false. Lets the app-shell banner
   *  and /demo/exit tell "exit to /demos" (anonymous) apart from "exit back
   *  to your own /dashboard" (signed in), without either of them re-deriving
   *  session state themselves. */
  demoSignedIn: boolean;
}

export const authContext = createContext<AuthContext>();
