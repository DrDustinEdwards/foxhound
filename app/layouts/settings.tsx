import { Outlet } from "react-router";
// The CSS every settings page reads, loaded once here for all of them: Capsomer's parts and the
// site header's CSS (~/site-header.css; the shell loads it too, and this keeps a settings page
// whole under any layout). The tokens and amber family come with the root route (app/error-page.css).
import "capsomer/button.css";
import "capsomer/field.css";
import "capsomer/page-head.css";
import "capsomer/panel.css";
import "capsomer/save-bar.css";
import "capsomer/settings-row.css";
import "capsomer/status.css";
import "capsomer/switch.css";
import "~/site-header.css";

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
// NO <main> HERE. Recova's layout owns the page's main; in Foxhound the
// shell does (AdminShell's #cap-main, the skip link's target), and
// this layout renders inside it. A main here made every settings page carry
// two main landmarks, so the page column is a plain div.
export default function SettingsLayout() {
  return (
    <div className="fh-settings-main">
      <div className="fh-settings-column">
        <Outlet />
      </div>
    </div>
  );
}
