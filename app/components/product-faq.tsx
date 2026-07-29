import { useState } from "react";

// Ported from legacy components/product/ProductFAQ.tsx (M30 divergence 38).
//
// Legacy deliberately runs TWO accordions and they are not interchangeable:
// components/FaqAccordion.tsx on the home page (px-6 py-5 button, pb-5
// leading-[1.6] answer, plus a useInView stagger of 60ms per item) and this
// one on the four /product/* spokes (px-5 py-4 button, pb-4 leading-relaxed
// answer, no stagger, and its own section chrome with a 620px container and a
// micro uppercase eyebrow rather than a heading).
//
// Foxhound had routed the spokes to the shared faq-accordion.tsx, which is
// ruling 63's pattern exactly: a faithful port of one legacy component applied
// to a surface legacy chose not to use it on. faq-accordion.tsx is left
// UNTOUCHED here, because the home page and three other routes consume it and
// their legacy pair is FaqAccordion.tsx, not this file.
//
// The 620px container is a SIXTH width in the spoke render chain, on top of
// the five inside product-sections.tsx (ruling 60: the width check is per
// section, and it does not stop at one file's boundary).
export function ProductFAQ({ faqs }: { faqs: { q: string; a: string }[] }) {
  const [open, setOpen] = useState<number | null>(null);

  return (
    <section className="border-b border-border px-5 py-16 sm:px-8">
      <div className="mx-auto max-w-[620px]">
        <h2 className="mb-8 text-center text-micro font-medium uppercase tracking-widest text-text-tertiary">
          Questions
        </h2>
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {faqs.map((faq, i) => (
            <li key={faq.q} className="overflow-hidden rounded-xl border border-border bg-surface">
              <button
                type="button"
                onClick={() => setOpen(open === i ? null : i)}
                aria-expanded={open === i}
                className="flex w-full cursor-pointer items-center justify-between gap-4 border-0 bg-transparent px-5 py-4 text-left"
              >
                <span className="text-item-title font-medium text-text">{faq.q}</span>
                <span
                  className="flex-shrink-0 text-lg text-text-tertiary transition-transform duration-200"
                  style={{ transform: open === i ? "rotate(45deg)" : "rotate(0deg)" }}
                  aria-hidden="true"
                >
                  +
                </span>
              </button>
              <div
                style={{
                  maxHeight: open === i ? "400px" : "0",
                  overflow: "hidden",
                  transition: "max-height 0.3s ease",
                }}
              >
                <p className="m-0 px-5 pb-4 text-copy leading-relaxed text-text-secondary">
                  {faq.a}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
