import { ArrowLeft } from "lucide-react";
import { Link } from "react-router";

// Recova's SettingsBackLink (components/SettingsBackLink.tsx, blob 64d4a153,
// 391 bytes): a link back to the settings hub, shown only below md, where the
// settings sub-nav aside is hidden (app/layouts/settings.tsx). Recova puts it
// first on each settings page, above the page head.
//
// A plain link on Foxhound's tokens: it goes somewhere, so it is not a
// Capsomer button, and Capsomer's breadcrumb shows at every width where this
// shows only on a phone. Its box is at least 24px tall (WCAG 2.5.8).
export function SettingsBackLink() {
  return (
    <Link
      to="/settings"
      className="mb-6 inline-flex min-h-6 items-center gap-1.5 text-label text-text-secondary no-underline hover:text-text md:hidden"
    >
      <ArrowLeft className="h-4 w-4" strokeWidth={2} aria-hidden />
      Settings
    </Link>
  );
}
