import { createContext } from "react-router";

import type { Membership } from "./account";

// Populated by the app-shell server middleware once the caller is proven to
// have a session AND a resolved account. Loaders/actions under the app shell
// read this instead of re-querying the session and membership.
export interface AuthContext {
  userId: string;
  userName: string;
  email: string;
  membership: Membership;
  /**
   * Every account this caller actively belongs to, earliest first, with the
   * resolved one among them. Ruling 326 phase (b).
   *
   * In the demo branch these are the demo businesses' memberships only, so a
   * switcher can never offer a demo visitor a real account.
   */
  memberships: Membership[];
  /**
   * The account this request acts as, always equal to `membership.accountId`.
   */
  activeAccountId: string;
  isAdmin: boolean;
  /**
   * True when this is a read-only demo view (the app-shell middleware injected
   * the demo account). Never an admin. Loaders may use it to hide write
   * affordances; the hard read-only guarantee is the middleware's method gate,
   * not any single loader.
   */
  isDemo: boolean;
  /**
   * True when isDemo is true AND the caller also has a real, valid session
   * (they are signed in but currently viewing the demo instead of their own
   * account). Always false when isDemo is false.
   */
  demoSignedIn: boolean;
  viewingAs?: { adminEmail: string };
}

export const authContext = createContext<AuthContext>();
