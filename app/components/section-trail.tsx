import { Breadcrumb } from "capsomer/react/breadcrumb";
import { Link } from "capsomer/react/link";

import "capsomer/breadcrumb.css";

// The trail a page inside a section shows (Docs > Platform setup, Blog > a post): Capsomer's
// breadcrumb, the same levels as the page's BreadcrumbList (app/lib/seo/meta.ts SECTIONS) below
// the home page. Recova's crumbs are quiet: tertiary, the link lighting up under the pointer.
export function SectionTrail({ items, className = "mb-8" }: { items: { label: string; href?: string }[]; className?: string }) {
  return (
    <div
      className={`${className} [&_.cap-breadcrumb]:text-micro [&_.cap-breadcrumb]:text-text-tertiary [&_.cap-breadcrumb-page]:font-normal [&_.cap-breadcrumb-page]:text-text-tertiary [&_a:hover]:text-text [&_a]:text-text-tertiary [&_a]:no-underline`}
    >
      <Breadcrumb
        items={items}
        renderLink={({ href, className: linkClass, children }) => (
          <Link to={href} className={linkClass}>
            {children}
          </Link>
        )}
      />
    </div>
  );
}
