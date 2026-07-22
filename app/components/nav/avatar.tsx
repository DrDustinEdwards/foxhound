import { Link } from "react-router";

// Replaces the marketing header's "Dashboard" button for an authenticated
// visitor (TASK-foxhound-marketing-header-v2.md): a compact circular avatar
// carrying the visitor's display initial, amber accent per app-shell
// conventions (the app shell's own utility cluster uses the same amber/
// chrome-text pairing throughout). Always links to /dashboard.
//
// The bottom-right amber dot matches the legacy site's authenticated avatar
// exactly (recova-eta.vercel.app, inspected live): static presence only,
// there is no notification system behind it yet.
export function Avatar({ initial }: { initial: string }) {
  return (
    <Link
      to="/dashboard"
      aria-label="Dashboard"
      className="relative flex h-8 w-8 items-center justify-center rounded-full bg-amber font-mono text-label font-semibold text-on-amber hover:bg-amber-dark"
    >
      {initial}
      <span className="absolute right-0 bottom-0 h-2 w-2 rounded-full bg-amber-dark ring-2 ring-chrome" aria-hidden />
    </Link>
  );
}
