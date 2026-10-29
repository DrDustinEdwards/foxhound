import { Outlet } from "react-router";

// S25's settings layout, ported from Recova's (app/(app)/settings/layout.tsx,
// blob `606c17335817`, 700 bytes).
//
// Recova's layout put its settings list in an aside beside the page. Here the
// app shell's left menu becomes that list on a settings page (app-shell.tsx),
// so the layout is the page column alone: an aside beside it was a second menu
// next to the first (Dustin 2026-10-29). Below md Recova's hub renders its own
// section list, as before. The page column is capped at Recova's 800px with
// Recova's padding.
//
// NO <main> HERE (J40). Recova's layout owns the page's main; in Foxhound the
// shell does (AdminShell's #cap-main, the skip link's target, ruling 146), and
// this layout renders inside it. A main here made every settings page carry
// two main landmarks, so the page column is a plain div.
export default function SettingsLayout() {
  return (
    <div className="min-w-0 px-4 py-8 md:px-10 md:py-10">
      <div className="max-w-[800px]">
        <Outlet />
      </div>
    </div>
  );
}
