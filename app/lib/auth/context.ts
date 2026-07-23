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
