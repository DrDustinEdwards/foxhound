import { Disclosure } from "capsomer/react/disclosure";

import "capsomer/disclosure.css";

/** Questions as Capsomer card disclosures sharing `name`: native details, so one opens at a time with no script and
 *  every answer is in the HTML. The /product spokes' FAQ and the decline-code pages draw it. */
export function FaqList({ name, faqs }: { name: string; faqs: { q: string; a: string }[] }) {
  return (
    <ul className="cap-stack" data-gap="4">
      {faqs.map((faq) => (
        <li key={faq.q}>
          <Disclosure summary={faq.q} variant="card" name={name}>
            <p className="fh-copy fh-relaxed fh-soft">{faq.a}</p>
          </Disclosure>
        </li>
      ))}
    </ul>
  );
}
