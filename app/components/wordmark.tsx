// --color-wordmark is theme-aware (white in dark mode, near-black in light),
// correct on a theme-switching surface. On a surface that's ALWAYS dark
// (--chrome: the app-shell header, the auth-ui.tsx brand panel), that same
// token goes near-invisible in light mode, so those callers pass
// tone="chrome" for the always-light chrome-text color instead.
export function Wordmark({ tone = "auto" }: { tone?: "auto" | "chrome" }) {
  const textClass = tone === "chrome" ? "text-chrome-text" : "text-wordmark";
  return (
    <span className={`-translate-y-px font-mono text-lg font-medium tracking-[-0.5px] ${textClass}`}>
      fo<span className="text-amber">x</span>hound
    </span>
  );
}
