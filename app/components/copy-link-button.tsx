import type { ComponentProps, ReactNode } from "react";
import { useState } from "react";

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
  icon?: (copied: boolean) => ReactNode;
}) {
  const [copied, setCopied] = useState(false);

  async function copyLink() {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), resetMs);
  }

  return (
    <button type="button" onClick={copyLink} {...button}>
      {icon?.(copied)}
      {copied ? "Copied" : "Copy link"}
    </button>
  );
}
