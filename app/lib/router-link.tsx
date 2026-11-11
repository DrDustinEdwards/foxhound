import type { ReactNode } from "react";
import { Form } from "react-router";
import { Link } from "capsomer/react/link";
import type { FormComponent } from "capsomer/react/inline-confirm";

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

// React Router's Form as a Capsomer part's `form` (InlineConfirm, ReadOnlyForm). Its `method`
// type is narrower than the plain form props the parts declare; it accepts every method they
// pass, so the cast is a type gap in the parts, not a change in behavior.
export const routerForm = Form as unknown as FormComponent;
