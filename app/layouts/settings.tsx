import { Outlet } from "react-router";

import { SettingsSidebar } from "~/components/settings-sidebar";

// S25's settings layout, ported from legacy's (blob `606c17335817`, 700 bytes).
//
// The aside is `md:w-60`, bordered right, on the chrome surface, and HIDDEN
// below `md`, where legacy's hub renders its own mobile section list instead.
// Main is capped at legacy's 800px.
//
// It sits INSIDE the app shell rather than replacing it: legacy's layout renders
// its own SiteNav because Next has no nested-layout chrome above it, where
// Foxhound's app-shell layout already provides the header, so reproducing it
// here would render two.
export default function SettingsLayout() {
  return (
    <div className="flex">
      <aside className="hidden border-r border-border-sub bg-chrome md:flex md:w-60 md:flex-shrink-0 md:flex-col">
        <SettingsSidebar />
      </aside>
      <main className="min-w-0 flex-1 px-4 py-8 md:px-10 md:py-10">
        <div className="max-w-[800px]">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
