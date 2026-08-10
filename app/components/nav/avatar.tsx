import { Link } from "react-router";

// Replaces the marketing header's "Dashboard" button for an authenticated
// visitor (TASK-foxhound-marketing-header-v2.md): a compact circular avatar
// carrying the visitor's display initial. Always links to /dashboard.
//
// Translucent, not amber-filled (ruling 48). A solid amber disc put a second
// amber element in a header that already carries the amber CTA, which breaks
// the one-amber-element discipline in DESIGN.md and was the visible header
// difference against legacy. The presence dot stays as it is: static, with no
// notification system behind it.
//
// A plain link, not the account switcher legacy wrapped it in. The reason is
// the CODE, not DESIGN.md's single-account rule, which ruling 53 revoked and
// which this comment used to cite as still holding (145's dead-citation table,
// repaired under ruling 232): at HEAD a user holds at most one ACTIVE
// membership, enforced by `account_members_one_active_per_user_uq` in
// app/db/schema.ts, so there is nothing for a switcher to switch between.
// If the multi-account build ships, this comment is the thing to revisit.
export function Avatar({ initial }: { initial: string }) {
  return (
    <Link
      to="/dashboard"
      aria-label="Dashboard"
      className="relative flex h-7 w-7 items-center justify-center rounded-full border border-white/20 bg-white/10 font-mono text-micro font-medium leading-none text-chrome-text transition-colors duration-150 hover:border-amber"
    >
      {initial}
      <span className="absolute right-0 bottom-0 h-2 w-2 rounded-full bg-amber-dark ring-2 ring-chrome" aria-hidden />
    </Link>
  );
}
