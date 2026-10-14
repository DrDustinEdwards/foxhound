// --color-wordmark is theme-aware (white in dark mode, near-black in light),
// correct on a theme-switching surface. On a surface that's ALWAYS dark
// (--chrome: the app-shell header, the auth-ui.tsx brand panel), that same
// token goes near-invisible in light mode, so those callers pass
// tone="chrome" for the always-light chrome-text color instead.
export function Wordmark({ tone = "auto" }: { tone?: "auto" | "chrome" }) {
  const textClass = tone === "chrome" ? "text-chrome-text" : "text-wordmark";
  // The x is the brand accent, teal (Q11): the chrome's own teal on the
  // always-dark chrome, the page's brand text on a theme-switching surface.
  const xClass = tone === "chrome" ? "text-chrome-brand" : "text-brand-text";
  return (
    <span
      className={`-translate-y-px font-mono text-lg font-medium tracking-[-0.5px] transition-opacity duration-500 hover:opacity-80 ${textClass}`}
    >
      fo<span className={xClass}>x</span>hound
    </span>
  );
}
