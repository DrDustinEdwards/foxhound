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
}

export const authContext = createContext<AuthContext>();
