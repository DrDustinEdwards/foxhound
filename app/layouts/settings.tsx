import { Outlet } from "react-router";
// The CSS every settings page reads, loaded once here for all of them: Capsomer's parts, and the
// tokens and amber family they read (~/site-header.css; the shell loads it too, and this keeps a
// settings page whole under any layout).
import "capsomer/button.css";
import "capsomer/field.css";
import "capsomer/page-head.css";
import "capsomer/panel.css";
import "capsomer/save-bar.css";
import "capsomer/settings-row.css";
import "capsomer/status.css";
import "capsomer/switch.css";
import "~/site-header.css";

// The settings layout is the page column alone: the app shell's left menu becomes the settings list on a settings page (app-shell.tsx), so an aside here would be a second menu. Below md the hub renders its own section list. The page column is capped at 800px.
// NO <main> HERE: the shell owns it (AdminShell's #cap-main, the skip link's target), and a second one would give every settings page two main landmarks, so the page column is a plain div.
export default function SettingsLayout() {
  return (
    <div className="fh-settings-main">
      <div className="fh-settings-column">
        <Outlet />
      </div>
    </div>
  );
}
