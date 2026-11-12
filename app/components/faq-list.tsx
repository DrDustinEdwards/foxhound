import { Disclosure } from "capsomer/react/disclosure";

import "capsomer/disclosure.css";

/** Questions as Capsomer card disclosures sharing `name`: native details, so one opens at a time with no script and
 *  every answer is in the HTML. The /product spokes' FAQ and the decline-code pages draw it. */
export function FaqList({ name, faqs }: { name: string; faqs: { q: string; a: string }[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      {faqs.map((faq) => (
        <li key={faq.q}>
          <Disclosure summary={faq.q} variant="card" name={name}>
            <p className="m-0 text-copy leading-relaxed text-text-secondary">{faq.a}</p>
          </Disclosure>
        </li>
      ))}
    </ul>
  );
}
