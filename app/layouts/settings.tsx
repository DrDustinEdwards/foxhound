import { Outlet } from "react-router";

import { SettingsSidebar } from "~/components/settings-sidebar";

// S25's settings layout, ported from Recova's (app/(app)/settings/layout.tsx,
// blob `606c17335817`, 700 bytes).
//
// The aside is `md:w-60`, bordered right, and HIDDEN below `md`, where Recova's
// hub renders its own section list instead. The page column is capped at
// Recova's 800px with Recova's padding.
//
// It sits INSIDE the app shell rather than replacing it: Recova's layout
// renders its own SiteNav because Next has no nested-layout chrome above it,
// where Foxhound's app-shell layout already provides the header.
//
// NO <main> HERE (J40). Recova's layout owns the page's main; in Foxhound the
// shell does (AdminShell's #cap-main, the skip link's target, ruling 146), and
// this layout renders inside it. A main here made every settings page carry
// two main landmarks, so the page column is a plain div.
//
// THE ASIDE IS ON THE PAGE'S GROUND, NOT THE CHROME (J40). Recova's sidebar
// sat on --chrome, dark in both themes, because it continued Recova's dark
// nav. Inside the Capsomer frame (APPROVED-DIFFERENCES, 2026-10-13 dashboard
// frame; Q10) the menu beside it is AdminShell's, on --ground in each theme,
// so a chrome aside rendered a dark strip between a light menu and a light
// page. It takes the ground the shell's menu takes, and follows the theme.
export default function SettingsLayout() {
  return (
    <div className="flex">
      <aside className="hidden border-r border-border-sub bg-bg md:flex md:w-60 md:flex-shrink-0 md:flex-col">
        <SettingsSidebar />
      </aside>
      <div className="min-w-0 flex-1 px-4 py-8 md:px-10 md:py-10">
        <div className="max-w-[800px]">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
