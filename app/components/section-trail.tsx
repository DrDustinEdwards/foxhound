import { Breadcrumb } from "capsomer/react/breadcrumb";
import { Link } from "capsomer/react/link";

import "capsomer/breadcrumb.css";

// The trail a page inside a section shows (Docs > Platform setup, Blog > a post): Capsomer's
// breadcrumb, the same levels as the page's BreadcrumbList (app/lib/seo/meta.ts SECTIONS) below
// the home page. Recova's crumbs are quiet: tertiary, the link lighting up under the pointer.
export function SectionTrail({
  items,
  className = "fh-trail-gap",
}: {
  items: { label: string; href?: string }[];
  className?: string;
}) {
  return (
    <div className={`fh-section-trail-block ${className}`}>
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
