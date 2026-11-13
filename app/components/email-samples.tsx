import { ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import { enhance } from "capsomer/behavior/ai-sample";
import { Eyebrow } from "capsomer/react/eyebrow";
import { Segmented } from "capsomer/react/segmented";

import { generateEmailSample, type MarketingEmailCategory } from "~/lib/marketing/email-sample";

import "capsomer/ai-sample.css";
import "capsomer/button.css";
import "capsomer/eyebrow.css";
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
// It is Capsomer's AI sample (capsomer/ai-sample.css, its HTML contract, and
// capsomer/behavior/ai-sample, which runs it): the picker is Capsomer's
// segmented control in the cards layout (one of a few, so radios, not four
// buttons), each chosen type tinted as Recova's were (soft blue, network
// orange, expired amber, fraud red), the button its primary. The behavior runs
// here once React hydrates, and from the email-generator island
// (islands/email-generator.ts) on a page that does not.
//
// Generation posts to /marketing/generate-email-sample (generateEmailSample),
// which calls the model for a fictional customer. When that fails or the
// visitor is over the rate limit, the route says so and this shows Recova's
// failure line (M3 divergence 28), rather than passing a stored sample off as
// one generated just now.

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
  // The behavior owns the button's words and the output region from here on;
  // nothing in this component re-renders them. It wires each AI sample once.
  useEffect(() => enhance(document, { generate: generateEmailSample }), []);

  return (
    <div data-island="email-generator">
      <form className="cap-ai-sample" data-cap="ai-sample">
        <div className="cap-ai-sample-head">
          <p className="cap-ai-sample-title">Live email generator</p>
          <span className="cap-ai-sample-live">Calls real AI</span>
        </div>
        <div className="cap-ai-sample-controls">
          <DeclinePicker />
          {/* Recova (EmailGenerator.tsx): "Generating..." with no arrow while
              the call runs, the label and the arrow otherwise. */}
          <div className="cap-ai-sample-action">
            <button
              type="submit"
              className="cap-btn"
              data-variant="primary"
              data-ai-sample-generate=""
              data-busy-label="Generating..."
            >
              <span className="cap-btn-label">Generate recovery email</span>
              <ArrowRight data-icon="end" size={13} strokeWidth={1.5} aria-hidden />
            </button>
            {/* Recova: "The same AI that writes your recovery emails. Try it on
                a real failed payment." The sample uses its own model
                (MODEL_MARKETING_EMAIL_SAMPLE, not MODEL_RECOVERY_EMAIL) on a
                fictional customer, so the line says what it is. */}
            <p className="cap-ai-sample-hint">
              A live AI call on a sample failed payment, for a fictional customer.
            </p>
          </div>
        </div>
        <div className="cap-ai-sample-out" aria-live="polite" />
      </form>
    </div>
  );
}

/** The decline type, the form's one input: native radios, so the island needs
 *  no React to choose one. Its own state, so a choice re-renders only this. */
function DeclinePicker() {
  const [category, setCategory] = useState<MarketingEmailCategory>("soft");
  return (
    <Segmented
      legend={<Eyebrow as="span">Decline type</Eyebrow>}
      name="decline-type"
      layout="cards"
      value={category}
      onChange={setCategory}
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
  );
}
