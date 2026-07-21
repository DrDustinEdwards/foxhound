import { useState } from "react";
import { Moon, Sun } from "lucide-react";

import { THEME_COOKIE, type Theme } from "~/lib/theme";

const VARIANT_CLASS = {
  // The app-shell header sits on --chrome, which stays dark in both modes
  // (DESIGN.md), so its icon needs the chrome-namespaced tokens regardless
  // of the active theme.
  chrome: "text-chrome-text-secondary hover:bg-white/10 hover:text-chrome-text",
  // The marketing header sits on --bg, which switches with the theme, so
  // its icon needs the regular theme-aware text tokens instead.
  surface: "text-text-tertiary hover:bg-surface2 hover:text-text",
};

// Compact icon toggle for the nav utility cluster. Optimistic: data-theme on
// <html> flips immediately so the page repaints under the new tokens with
// zero latency; the cookie write is what makes the NEXT request's SSR match
// (task Appendix A: cookie-persisted, no flash).
export function ThemeToggle({
  initialTheme,
  variant = "chrome",
}: {
  initialTheme: Theme;
  variant?: keyof typeof VARIANT_CLASS;
}) {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const isDark = theme === "dark";

  function toggle() {
    const next: Theme = isDark ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; SameSite=Lax`;
  }

  return (
    <button
      type="button"
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={toggle}
      className={`flex h-8 w-8 items-center justify-center rounded-md ${VARIANT_CLASS[variant]}`}
    >
      {isDark ? (
        <Moon width={16} height={16} strokeWidth={2} aria-hidden />
      ) : (
        <Sun width={16} height={16} strokeWidth={2} aria-hidden />
      )}
    </button>
  );
}
