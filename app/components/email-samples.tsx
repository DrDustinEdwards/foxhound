import { Icon, iconArrowRight } from "capsomer/react/icons";
import { useState } from "react";
import { AiSample, type AiSampleResult } from "capsomer/react/ai-sample";
import { Segmented } from "capsomer/react/segmented";

import { generateEmailSample, type MarketingEmailCategory } from "~/lib/marketing/email-sample";

import "capsomer/ai-sample.css";
import "capsomer/button.css";
import "capsomer/segmented.css";

// The home page's live email generator: a decline type picker, a generate button and the output (subject, body, footer) or a failure line. The picker shows the decline name in bold and the plain cause beneath, no raw Stripe code. It is Capsomer's AI sample: the picker its segmented control in the cards layout, each chosen type tinted. Hydrated, React keeps the state here; on a page that does not hydrate, the email-generator island (islands/email-generator.ts) runs the same markup through capsomer/behavior/ai-sample.
// Generation posts to /marketing/generate-email-sample (generateEmailSample), which calls the model for a fictional customer. When that fails or the visitor is over the rate limit, the route says so and this shows a failure line, rather than passing a stored sample off as one generated just now.

interface CategoryMeta {
  id: MarketingEmailCategory;
  label: string;
  tone?: "info" | "warn" | "crit";
}

const CATEGORIES: CategoryMeta[] = [
  { id: "soft", label: "Insufficient funds", tone: "info" },
  { id: "network", label: "Processing failure", tone: "warn" },
  { id: "expired", label: "Card needs updating" },
  { id: "fraud", label: "Bank flagged the charge", tone: "crit" },
];

export function EmailSamples() {
  const [category, setCategory] = useState<MarketingEmailCategory>("soft");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AiSampleResult | null>(null);

  // Clear the last email and failure line before the request, so a new call never shows the last call's.
  async function generate(data: FormData) {
    setResult(null);
    setBusy(true);
    const next = await generateEmailSample(data);
    setBusy(false);
    setResult(next);
  }

  return (
    <div data-island="email-generator">
      <AiSample
        title="Live email generator"
        live="Calls real AI"
        busy={busy}
        result={result}
        onGenerate={(data) => void generate(data)}
        // Choosing another decline type clears the last email.
        onChange={() => setResult(null)}
        button={
          <>
            <span className="cap-btn-label">Generate recovery email</span>
            <Icon d={iconArrowRight} className="fh-icon-13 fh-icon-fine" data-icon="end" />
          </>
        }
        // The sample uses its own model (MODEL_MARKETING_EMAIL_SAMPLE, not MODEL_RECOVERY_EMAIL) on a fictional customer, so the line says what it is.
        hint="A live AI call on a sample failed payment, for a fictional customer."
      >
        <Segmented
          legend={<span className="fh-label">Decline type</span>}
          name="decline-type"
          layout="cards"
          value={category}
          onChange={setCategory}
          options={CATEGORIES.map((c) => ({
            value: c.id,
            tone: c.tone,
            label: (
              <span className="fh-line fh-caption">
                <span className="fh-line fh-medium">{c.label}</span>
              </span>
            ),
          }))}
        />
      </AiSample>
    </div>
  );
}
