import type { ComponentProps, ReactElement } from "react";
import { cloneElement, useState } from "react";

// One "Copy link" for the site, ported from legacy's two: components/audit/
// CopyLinkButton.tsx (the saved audit run, label flips to "Copied" for 1.5s)
// and the copy action in components/blog/ShareBar.tsx (2s, with an icon that
// the caller renders from `copied`). Everything else on the <button> (class,
// data-variant, aria-label) is the caller's.
export function CopyLinkButton({
  url,
  resetMs,
  icon,
  ...button
}: Omit<ComponentProps<"button">, "type" | "onClick" | "children"> & {
  url: string;
  resetMs: number;
  icon?: (copied: boolean) => ReactElement<{ className?: string }>;
}) {
  const [copied, setCopied] = useState(false);

  async function copyLink() {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), resetMs);
  }

  // Both icons are drawn, the one not showing hidden (Tailwind's `hidden`), so on a page that does not
  // hydrate the copy-link island (islands/copy-link.ts) can do the same with no React.
  const drawn = (state: boolean) => {
    const el = icon?.(state);
    if (!el) return null;
    const className = [el.props.className, state === copied ? "" : "hidden"].filter(Boolean).join(" ") || undefined;
    return cloneElement(el, { className, key: String(state), "data-copied": String(state) } as { className?: string });
  };

  return (
    <button
      type="button"
      onClick={copyLink}
      data-island="copy-link"
      data-props={JSON.stringify({ url, resetMs })}
      {...button}
    >
      {drawn(false)}
      {drawn(true)}
      {copied ? "Copied" : "Copy link"}
    </button>
  );
}
