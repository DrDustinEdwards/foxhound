import { createContext } from "react-router";

// Set by the admin-shell layout's middleware once Cloudflare Access has signed
// the caller in and the email is on the ADMIN_EMAIL allowlist. Admin loaders and
// actions read the actor's email here (audit rows, brake events, staged
// decisions); /admin no longer runs under the app shell, so it has no
// authContext.
export interface AdminContext {
  email: string;
}

export const adminContext = createContext<AdminContext>();
