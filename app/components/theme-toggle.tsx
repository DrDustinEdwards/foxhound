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
// zero latency; the persisted write is what makes the NEXT request's SSR match.
//
// Two persistence paths, matching legacy NavThemeToggle exactly (ruling 59):
// an authenticated merchant's choice POSTs to accounts.theme so it follows them
// across devices, while an anonymous visitor keeps the cookie. They are
// EXCLUSIVE, as in legacy: an authenticated toggle writes no cookie, because
// resolveThemeForRequest prefers the stored value anyway and a cookie left
// behind would only be a stale second source of truth.
//
// Fire-and-forget on purpose: the DOM already flipped, so a failed write must
// not roll back what the merchant is looking at. The next request reconciles.
export function ThemeToggle({
  initialTheme,
  variant = "chrome",
  isAuthenticated = false,
}: {
  initialTheme: Theme;
  variant?: keyof typeof VARIANT_CLASS;
  isAuthenticated?: boolean;
}) {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const isDark = theme === "dark";

  function toggle() {
    const next: Theme = isDark ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);

    if (isAuthenticated) {
      void fetch("/api/theme", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: next }),
      });
      return;
    }

    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; SameSite=Lax`;
  }

  return (
    <button
      type="button"
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={toggle}
      className={`flex h-8 w-8 items-center justify-center overflow-hidden rounded-md transition-colors duration-150 ${VARIANT_CLASS[variant]}`}
    >
      <span
        key={theme}
        className="flex items-center justify-center"
        style={{ animation: "theme-icon-in 0.2s ease both" }}
      >
        {isDark ? (
          <Moon width={16} height={16} strokeWidth={2} aria-hidden />
        ) : (
          <Sun width={16} height={16} strokeWidth={2} aria-hidden />
        )}
      </span>
    </button>
  );
}
