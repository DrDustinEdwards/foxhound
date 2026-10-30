// --color-wordmark is theme-aware (white in dark mode, near-black in light),
// correct on a theme-switching surface. On a surface that's ALWAYS dark
// (--chrome: the app-shell header, the auth-ui.tsx brand panel), that same
// token goes near-invisible in light mode, so those callers pass
// tone="chrome" for the always-light chrome-text color instead.
//
// size="title" sets it on the title step of the five text sizes,
// for a page that shows the wordmark as Recova's 20px page mark above its
// content (the unsubscribe page) rather than in a header.
export function Wordmark({
  tone = "auto",
  size = "header",
}: {
  tone?: "auto" | "chrome";
  size?: "header" | "title";
}) {
  const textClass = tone === "chrome" ? "text-chrome-text" : "text-wordmark";
  const sizeClass = size === "title" ? "text-title" : "text-lg";
  // The x is the brand accent, amber: the chrome's own amber on the
  // always-dark chrome, the page's brand text on a theme-switching surface.
  const xClass = tone === "chrome" ? "text-chrome-brand" : "text-brand-text";
  return (
    <span
      className={`-translate-y-px font-mono ${sizeClass} font-medium tracking-[-0.5px] transition-opacity duration-500 hover:opacity-80 ${textClass}`}
    >
      fo<span className={xClass}>x</span>hound
    </span>
  );
}
