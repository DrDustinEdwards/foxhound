import { createContext } from "react-router";

// Set by the admin-shell layout's middleware once Cloudflare Access has signed
// the caller in and the email is on the ADMIN_EMAIL and CO_OWNER_EMAILS roster.
export interface AdminContext {
  email: string;
}

export const adminContext = createContext<AdminContext>();
