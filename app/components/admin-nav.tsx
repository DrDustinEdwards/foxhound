import { NavLink } from "react-router";

// Admin sub-navigation. DESIGN.md: admin "reuses the app shell, no distinct
// admin shell" - this is NOT a second shell, just a cross-link row rendered
// inside each admin page's own content column, mirroring the app-shell primary
// nav's active-state pattern (2px amber bottom border) at a smaller scale.
const ADMIN_NAV_ITEMS = [
  { to: "/admin", label: "Overview", end: true },
  { to: "/admin/merchants", label: "Merchants" },
  { to: "/admin/users", label: "Users" },
  { to: "/admin/operations", label: "Operations" },
  { to: "/admin/brake", label: "Brake" },
  { to: "/admin/crons", label: "Crons" },
  { to: "/admin/webhooks", label: "Webhooks" },
  { to: "/admin/blog", label: "Blog" },
  { to: "/admin/social", label: "Social" },
  { to: "/admin/audit-log", label: "Audit log" },
] as const;

function linkClassName({ isActive }: { isActive: boolean }): string {
  return isActive
    ? "inline-block whitespace-nowrap border-b-2 border-amber py-2 text-label font-semibold text-text"
    : "inline-block whitespace-nowrap border-b-2 border-transparent py-2 text-label text-text-tertiary hover:text-text";
}

export function AdminNav() {
  return (
    <nav className="mb-6 flex gap-5 overflow-x-auto border-b border-border" aria-label="Admin">
      {ADMIN_NAV_ITEMS.map((item) => (
        <NavLink key={item.to} to={item.to} end={"end" in item ? item.end : false} className={linkClassName}>
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
