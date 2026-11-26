import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TERMS_USE } from "~/components/legal/terms-use";
import { INVOICE_DAYS_UNTIL_DUE } from "~/lib/constants";

// The Terms say how Foxhound bills the way the billing code does it (run.ts, stripe-invoice.ts, credit-note.ts).
const text = renderToStaticMarkup(
  createElement(
    Fragment,
    null,
    ...TERMS_USE.map((s) => createElement(Fragment, { key: s.id }, s.body)),
  ),
).replace(/\s+/g, " ");

describe("the Terms' billing sections match the billing code", () => {
  it("invoice in each result's own currency, not in US dollars only", () => {
    expect(text).toContain("one invoice per currency");
    expect(text).not.toContain("All payments shall be in US dollars");
  });

  it("charge a card on file, else email an invoice due in the code's days", () => {
    expect(text).toContain(`due within ${INVOICE_DAYS_UNTIL_DUE} days`);
  });

  it("promise the credit for a refunded or charged-back recovery, and no subscription", () => {
    expect(text).toContain("refunded or charged back, we credit that fee");
    expect(text).not.toContain("automatically renew");
    expect(text).not.toContain("All purchases are non-refundable");
  });
});
