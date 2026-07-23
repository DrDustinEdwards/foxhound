import { useState } from "react";

// Ported from legacy blog post pages (TASK-foxhound-parity-cluster-b.md fix
// 4), confirmed live on recova-eta.vercel.app/blog/stripe-failed-payment-
// recovery before building: a "Share" label plus X, LinkedIn, and Copy link
// actions in a bordered row directly under the lead paragraph. Plain anchor
// share intents (X's /intent/tweet, LinkedIn's /sharing/share-offsite), no
// tracking scripts. Text-only, not icon buttons: lucide-react (this repo's
// only icon set) ships no X/LinkedIn brand marks, and a mismatched or
// invented brand icon would be worse than none.
export function ShareRow({ url, title }: { url: string; title: string }) {
  const [copied, setCopied] = useState(false);

  async function copyLink() {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const tweetHref = `https://x.com/intent/tweet?${new URLSearchParams({ text: title, url }).toString()}`;
  const linkedinHref = `https://www.linkedin.com/sharing/share-offsite/?${new URLSearchParams({ url }).toString()}`;

  return (
    <div className="mb-6 flex items-center gap-3 border-b border-border-sub pb-4">
      <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Share</span>
      <a
        href={tweetHref}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Share on X"
        className="font-mono text-label text-text-tertiary hover:text-text"
      >
        X
      </a>
      <a
        href={linkedinHref}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Share on LinkedIn"
        className="font-mono text-label text-text-tertiary hover:text-text"
      >
        LinkedIn
      </a>
      <button
        type="button"
        onClick={copyLink}
        aria-label="Copy link"
        className="font-mono text-label text-text-tertiary hover:text-text"
      >
        {copied ? "Copied" : "Copy link"}
      </button>
    </div>
  );
}
