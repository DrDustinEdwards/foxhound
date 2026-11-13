import { Link } from "capsomer/react/link";
import type { ReactNode } from "react";
import "~/auth.css";

// Its own module, so a page that needs only the link (the connect pages) does not load the sign-in
// card's passkey, Turnstile and auth client code with it.

/** A small text link (Capsomer's link system, capsomer/links.css), 24px tall
 *  as a target. */
export function AuthLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="fh-auth-link">
      {children}
    </Link>
  );
}
