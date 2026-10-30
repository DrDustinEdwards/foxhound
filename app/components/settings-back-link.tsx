import { ArrowLeft } from "lucide-react";
import { Link } from "capsomer/react/link";

/**
 * Recova's SettingsBackLink (components/SettingsBackLink.tsx, blob 64d4a153,
 * 391 bytes): a phone-only "Settings" link with a left arrow, at the top of a
 * settings page, because the settings sidebar is hidden below md. Recova puts it
 * on each settings page, not in the layout, so each page adds it.
 *
 * Capsomer has no back link (PageHead's crumbs show at every width), so this is
 * Foxhound's own element at Recova's size and spacing, with a 24px target.
 */
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
