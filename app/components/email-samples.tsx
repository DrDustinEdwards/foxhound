import { useState } from "react";

// Replaces legacy components/marketing/EmailGenerator.tsx (Phase 6 Pass 1,
// copy correction #10). The legacy widget called a live Anthropic API per
// visitor; that cost, abuse surface, and the API key itself are Phase 8
// scope. This is a static rotator over hardcoded, pre-written samples, zero
// API calls, zero marginal cost, same proof value. Categories mirror the
// DECLINE_CATEGORIES enum (app/lib/constants.ts): soft, network, expired,
// fraud. Copy reflects the silent-first engine (correction #4): a quiet
// retry already ran before any soft/network/expired email sends, and fraud
// declines are never retried.
interface EmailSample {
  id: string;
  label: string;
  desc: string;
  tone: "blue" | "orange" | "amber" | "red";
  subject: string;
  body: string;
  note?: string;
}

const SAMPLES: EmailSample[] = [
  {
    id: "soft",
    label: "Insufficient funds",
    desc: "Soft decline",
    tone: "blue",
    subject: "A quick note about your Acme Analytics payment",
    body: `Hi Jordan,

Your card was declined for this month's Acme Analytics payment (insufficient_funds). We already tried a quiet retry this morning in case it was just timing, no luck yet.

If you would rather update your card directly, this link takes you straight there:
{{card_update_link}}

We will keep trying automatically over the next few days. No action needed if the funds clear on their own.

Acme Analytics`,
    note: "A silent retry already ran before this email sent.",
  },
  {
    id: "network",
    label: "Processing failure",
    desc: "Network decline",
    tone: "orange",
    subject: "A payment hiccup on your Acme Analytics account",
    body: `Hi Priya,

Your last payment on Acme Analytics ran into a processing error on the card network's side, not a problem with your card itself. We already retried it once quietly before sending this.

If it happens again, updating your card details usually clears it:
{{card_update_link}}

Acme Analytics`,
    note: "A silent retry already ran before this email sent.",
  },
  {
    id: "expired",
    label: "Expired card",
    desc: "Card needs updating",
    tone: "amber",
    subject: "The card on file for Acme Analytics has expired",
    body: `Hi Sam,

The card on file for your Acme Analytics subscription expired, so this month's payment did not go through. A retry will not fix this one, it needs a new card.

Update it here, it takes about 30 seconds:
{{card_update_link}}

Acme Analytics`,
  },
  {
    id: "fraud",
    label: "Suspected fraud",
    desc: "do_not_honor",
    tone: "red",
    subject: "Your Acme Analytics payment needs a new card",
    body: `Hi Morgan,

Your bank declined this month's Acme Analytics payment as do_not_honor, usually a fraud check on the bank's side rather than anything about your account. We do not retry declines like this automatically.

If everything looks right to you, updating your card usually resolves it:
{{card_update_link}}

Acme Analytics`,
    note: "Fraud declines are never retried. This is the only step in the sequence.",
  },
];

const TONE_CLASSES: Record<EmailSample["tone"], string> = {
  blue: "bg-blue-bg border-blue text-blue",
  orange: "bg-orange-bg border-orange text-warning-text",
  amber: "bg-amber-bg border-amber-border-interactive text-amber-text",
  red: "bg-red-bg border-red text-error-text",
};

export function EmailSamples() {
  const [activeId, setActiveId] = useState(SAMPLES[0].id);
  const active = SAMPLES.find((s) => s.id === activeId) ?? SAMPLES[0];

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border-sub px-5 py-4">
        <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
          Sample recovery emails
        </span>
        <span className="font-mono text-micro text-text-subtle">Pre-written, not generated live</span>
      </div>

      <div className="p-5">
        <p className="mb-2 font-mono text-micro uppercase tracking-wide text-text-tertiary">
          Decline type
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {SAMPLES.map((sample) => (
            <button
              key={sample.id}
              type="button"
              onClick={() => setActiveId(sample.id)}
              className={`rounded-lg border px-3 py-2.5 text-left text-label transition-colors ${
                activeId === sample.id
                  ? TONE_CLASSES[sample.tone]
                  : "border-border bg-bg text-text-secondary hover:border-border-i"
              }`}
            >
              <div className="font-medium">{sample.label}</div>
              <div className="mt-0.5 font-mono text-micro opacity-80">{sample.desc}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="border-t border-border-sub p-5">
        <p className="mb-2 font-mono text-micro uppercase tracking-wide text-text-subtle">Subject</p>
        <div className="mb-4 rounded-lg border border-border-sub bg-bg px-3 py-2 text-body font-medium text-text">
          {active.subject}
        </div>
        <p className="mb-2 font-mono text-micro uppercase tracking-wide text-text-subtle">Body</p>
        <div className="whitespace-pre-wrap rounded-lg border border-border-sub bg-bg px-3 py-3 font-mono text-label leading-relaxed text-text-secondary">
          {active.body}
        </div>
        {active.note ? <p className="mt-3 font-mono text-micro text-text-subtle">{active.note}</p> : null}
        <p className="mt-3 text-micro text-text-subtle">
          Every account customizes its brand voice. These samples use a neutral default.
        </p>
      </div>
    </div>
  );
}
