import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { useFetcher } from "react-router";
import { Segmented } from "capsomer/react/segmented";

import type { MarketingEmailCategory, MarketingEmailResult } from "~/lib/marketing/email-sample";

import "capsomer/panel.css";
import "capsomer/button.css";
import "capsomer/segmented.css";

// The home page's live email generator. Recova's spec is
// components/marketing/EmailGenerator.tsx (blob c4592a56), read whole.
//
// Recova's parts in Recova's order: the header with its live dot, the decline
// type picker, the generate button with its trailing arrow, the line under it,
// and the output (subject, body, footer) or Recova's failure line. The picker
// labels are Recova's: the decline name in bold, the plain cause beneath, and
// no raw Stripe code (M3 divergence 27).
//
// Look is Capsomer's: the card is a panel, the picker its segmented control in
// the cards layout (one of a few, so radios, not four buttons), each chosen
// type tinted as Recova's were (soft blue, network orange, expired amber,
// fraud red), the button its primary.
//
// Generation posts to /marketing/generate-email-sample, which calls the model
// for a fictional customer. When that fails or the visitor is over the rate
// limit, the route says so and this shows Recova's failure line (M3 divergence
// 28), rather than passing a stored sample off as one generated just now.

interface CategoryMeta {
  id: MarketingEmailCategory;
  label: string;
  desc: string;
  tone?: "info" | "warn" | "crit";
}

const CATEGORIES: CategoryMeta[] = [
  { id: "soft", label: "Soft decline", desc: "Insufficient funds", tone: "info" },
  { id: "network", label: "Network error", desc: "Processing failure", tone: "warn" },
  { id: "expired", label: "Expired card", desc: "Card needs updating" },
  { id: "fraud", label: "Fraud flag", desc: "Bank flagged the charge", tone: "crit" },
];

export function EmailSamples() {
  const [category, setCategory] = useState<MarketingEmailCategory>("soft");
  const [result, setResult] = useState<MarketingEmailResult | null>(null);
  const fetcher = useFetcher<MarketingEmailResult>();
  const busy = fetcher.state !== "idle";

  // `result` is fetcher.data, EXCEPT that switching category clears it and it
  // stays cleared until the next generate lands, so it cannot be derived from
  // fetcher.data alone. React's documented pattern: adjust state during
  // render, guarded on the value having changed.
  const [seenData, setSeenData] = useState(fetcher.data);
  if (fetcher.data !== seenData) {
    setSeenData(fetcher.data);
    if (fetcher.data) setResult(fetcher.data);
  }

  function selectCategory(id: MarketingEmailCategory) {
    setCategory(id);
    setResult(null);
  }

  // Recova's generate() calls setResult(null) and setError(false) before the
  // request, so a new call never shows the last call's email or failure line.
  function generate() {
    setResult(null);
    void fetcher.submit({ category }, { method: "post", action: "/marketing/generate-email-sample" });
  }

  return (
    <EmailGeneratorView
      category={category}
      busy={busy}
      result={result}
      onSelect={selectCategory}
      onGenerate={generate}
    />
  );
}

/** What the generator draws for a given state, apart from the fetcher, so each
 *  state (idle, busy, a result, a failure) can be rendered on its own. */
function EmailGeneratorView({
  category,
  busy,
  result,
  onSelect,
  onGenerate,
}: {
  category: MarketingEmailCategory;
  busy: boolean;
  result: MarketingEmailResult | null;
  onSelect: (id: MarketingEmailCategory) => void;
  onGenerate: () => void;
}) {
  return (
    <div className="cap-panel">
      <div className="cap-panel-body" data-flush>
        <div>
          <div className="flex items-center justify-between border-b border-border-sub px-5 py-4">
            <span className="font-mono text-micro uppercase tracking-widest text-text-tertiary">
              Live email generator
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-green" aria-hidden />
              <span className="font-mono text-source text-green">Calls real AI</span>
            </span>
          </div>

          <div className="p-5">
            <div className="mb-4">
              <Segmented
                legend={
                  <span className="text-micro font-medium uppercase tracking-widest text-text-tertiary">Decline type</span>
                }
                name="decline-type"
                layout="cards"
                value={category}
                onChange={onSelect}
                options={CATEGORIES.map((c) => ({
                  value: c.id,
                  tone: c.tone,
                  label: (
                    <span className="block text-caption">
                      <span className="block font-medium">{c.label}</span>
                      <span className="mt-0.5 block font-mono text-source opacity-80">{c.desc}</span>
                    </span>
                  ),
                }))}
              />
            </div>

            <div className="flex justify-center">
              <button
                type="button"
                onClick={onGenerate}
                disabled={busy}
                aria-busy={busy ? "true" : undefined}
                className="cap-btn w-full px-6 font-semibold sm:w-auto sm:min-w-[280px] [--cap-btn-h:2.5rem]"
                data-variant="primary"
              >
                {/* Recova (EmailGenerator.tsx): "Generating..." with no arrow
                    while the call runs, the label and the arrow otherwise. */}
                {busy ? (
                  <span className="cap-btn-label">Generating...</span>
                ) : (
                  <>
                    <span className="cap-btn-label">Generate recovery email</span>
                    <ArrowRight data-icon="end" size={13} strokeWidth={1.5} aria-hidden />
                  </>
                )}
              </button>
            </div>

            {/* Recova: "The same AI that writes your recovery emails. Try it on
                a real failed payment." The sample uses its own model
                (MODEL_MARKETING_EMAIL_SAMPLE, not MODEL_RECOVERY_EMAIL) on a
                fictional customer, so the line says what it is. */}
            <p className="mt-2 text-center font-mono text-source text-text-subtle">
              A live AI call on a sample failed payment, for a fictional customer.
            </p>
          </div>

          <div aria-live="polite">
            {busy ? null : result && "error" in result ? (
              <div className="border-t border-border-sub p-5 text-label text-error-text">Generation failed. Try again.</div>
            ) : result ? (
              <div className="border-t border-border-sub p-5">
                <p className="mb-3 font-mono text-source uppercase tracking-widest text-text-subtle">Subject</p>
                <div className="mb-4 rounded-lg border border-border-sub bg-bg px-3 py-2 text-copy font-medium text-text">
                  {result.subject}
                </div>
                <p className="mb-2 font-mono text-source uppercase tracking-widest text-text-subtle">Body</p>
                <div className="whitespace-pre-wrap rounded-lg border border-border-sub bg-bg px-3 py-3 font-mono text-label leading-[1.7] text-text-secondary">
                  {result.body.replace("{{update_url}}", "https://billing.yoursaas.com/update")}
                </div>
                <p className="mt-3 font-mono text-source text-text-subtle">
                  Generated in real time by AI, for a fictional customer.
                </p>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
