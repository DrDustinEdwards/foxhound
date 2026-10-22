import { useState } from "react";

export interface FaqItem {
  question: string;
  answer: React.ReactNode;
}

// Ported from legacy components/FaqAccordion.tsx (Phase 6 Pass 1): dropped
// the useInView reveal (FadeUp already wraps the section that hosts this on
// every Pass 1 page) and swapped inline hex-adjacent styling for token
// classes. The open/close animation stays inline (max-height/transform), not
// color, so it is exempt from the no-inline-hex rule.
export function FaqAccordion({ faqs }: { faqs: FaqItem[] }) {
  const [open, setOpen] = useState<number | null>(null);

  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      {faqs.map((faq, i) => (
        <li key={faq.question} className="overflow-hidden rounded-lg border border-border bg-surface">
          <button
            type="button"
            onClick={() => setOpen(open === i ? null : i)}
            aria-expanded={open === i}
            className="flex w-full items-center justify-between gap-4 border-0 bg-transparent px-5 py-4 text-left"
          >
            <span className="text-body font-medium text-text">{faq.question}</span>
            <span
              className="flex-shrink-0 text-lg text-text-tertiary transition-transform duration-200"
              style={{ transform: open === i ? "rotate(45deg)" : "rotate(0deg)" }}
              aria-hidden="true"
            >
              +
            </span>
          </button>
          <div
            // A closed answer is clipped to zero height, so it leaves the accessibility tree too.
            aria-hidden={open !== i}
            style={{
              maxHeight: open === i ? "480px" : "0px",
              overflow: "hidden",
              transition: "max-height 0.3s ease",
            }}
          >
            <p className="m-0 px-5 pb-5 text-label leading-relaxed text-text-secondary">{faq.answer}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}
