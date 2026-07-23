import { useEffect, useState } from "react";
import { useFetcher } from "react-router";

import type { MarketingEmailCategory, MarketingEmailCopy } from "~/lib/marketing/email-sample-fallbacks";

// Live email generator (TASK-foxhound-demo-entry-parity.md item 3, reversing
// the earlier call at app/components/email-samples.tsx: Phase 6 replaced
// legacy's real Anthropic call with a static rotator over hardcoded samples,
// reasoning that the demo-account AI firewall meant "zero Anthropic calls in
// the demo path." That firewall is for the SEEDED DEMO ACCOUNT (a nightly
// cron reseed calling AI would be genuinely wrong there); it never applied to
// this unauthenticated marketing page, where a human clicks a button once.
// Legacy called real AI from here. Generation posts to
// /marketing/generate-email-sample (app/routes/marketing/), which is rate
// limited and falls back to a static sample on any failure, in the same
// shape, so a visitor never sees an error.
interface CategoryMeta {
  id: MarketingEmailCategory;
  label: string;
  desc: string;
  tone: "blue" | "orange" | "amber" | "red";
}

const CATEGORIES: CategoryMeta[] = [
  { id: "soft", label: "Insufficient funds", desc: "Soft decline", tone: "blue" },
  { id: "network", label: "Processing failure", desc: "Network decline", tone: "orange" },
  { id: "expired", label: "Expired card", desc: "Card needs updating", tone: "amber" },
  { id: "fraud", label: "Suspected fraud", desc: "do_not_honor", tone: "red" },
];

const TONE_CLASSES: Record<CategoryMeta["tone"], string> = {
  blue: "bg-blue-bg border-blue text-blue",
  orange: "bg-orange-bg border-orange text-warning-text",
  amber: "bg-amber-bg border-amber-border-interactive text-amber-text",
  red: "bg-red-bg border-red text-error-text",
};

export function EmailSamples() {
  const [activeId, setActiveId] = useState<MarketingEmailCategory>(CATEGORIES[0].id);
  const [result, setResult] = useState<MarketingEmailCopy | null>(null);
  const fetcher = useFetcher<MarketingEmailCopy>();
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data) setResult(fetcher.data);
  }, [fetcher.data]);

  function selectCategory(id: MarketingEmailCategory) {
    setActiveId(id);
    setResult(null);
  }

  function generate() {
    fetcher.submit({ category: activeId }, { method: "post", action: "/marketing/generate-email-sample" });
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border-sub px-5 py-4">
        <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
          Live email generator
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-green" aria-hidden />
          <span className="font-mono text-micro text-green">Calls real AI</span>
        </span>
      </div>

      <div className="p-5">
        <p className="mb-2 font-mono text-micro uppercase tracking-wide text-text-tertiary">
          Decline type
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {CATEGORIES.map((category) => (
            <button
              key={category.id}
              type="button"
              onClick={() => selectCategory(category.id)}
              className={`rounded-lg border px-3 py-2.5 text-left text-label transition-colors ${
                activeId === category.id
                  ? TONE_CLASSES[category.tone]
                  : "border-border bg-bg text-text-secondary hover:border-border-i"
              }`}
            >
              <div className="font-medium">{category.label}</div>
              <div className="mt-0.5 font-mono text-micro opacity-80">{category.desc}</div>
            </button>
          ))}
        </div>

        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={generate}
            disabled={busy}
            className="w-full rounded-md bg-amber px-5 py-2.5 text-label font-semibold text-on-amber hover:bg-amber-dark disabled:opacity-60 sm:w-auto sm:min-w-[280px]"
          >
            {busy ? "Generating..." : "Generate recovery email"}
          </button>
        </div>
        <p className="mt-2 text-center font-mono text-micro text-text-subtle">
          The same AI that writes your recovery emails. Try it on a real failed payment.
        </p>
      </div>

      {result ? (
        <div className="border-t border-border-sub p-5">
          <p className="mb-2 font-mono text-micro uppercase tracking-wide text-text-subtle">Subject</p>
          <div className="mb-4 rounded-lg border border-border-sub bg-bg px-3 py-2 text-body font-medium text-text">
            {result.subject}
          </div>
          <p className="mb-2 font-mono text-micro uppercase tracking-wide text-text-subtle">Body</p>
          <div className="whitespace-pre-wrap rounded-lg border border-border-sub bg-bg px-3 py-3 font-mono text-label leading-relaxed text-text-secondary">
            {result.body.replace("{{update_url}}", "https://billing.yoursaas.com/update")}
          </div>
          <p className="mt-3 font-mono text-micro text-text-subtle">
            Generated in real time by the same AI that writes your recovery emails.
          </p>
        </div>
      ) : null}
    </div>
  );
}
