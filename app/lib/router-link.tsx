import type { ReactNode } from "react";
import { Link } from "capsomer/react/link";

// A Capsomer part's `renderLink`, drawn as a client-side router link: the part gives the address
// and the words, the router moves between pages without a full load.
export function routerLink({
  href,
  ...rest
}: {
  href: string;
  children?: ReactNode;
  className?: string;
  "aria-current"?: "page";
}) {
  return <Link to={href} {...rest} />;
}
