
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { DocWidget } from "~/components/docs/doc-widgets";
import { classifyDecline } from "~/lib/recovery/decline";
import { DECLINE_CATEGORY_LABELS } from "~/lib/recovery/labels";

// J73, row M18: the five guides carry Recova's Part structure, with every claim
// true of Foxhound's engine, on Capsomer's components.
//
// THE SPEC IS RECOVA'S SOURCE, read whole at these blobs through Capsid's repo
// "legacy": app/(marketing)/docs/platform/page.tsx 2b69517b, audit 3b1153b4,
// recovery 6166a6be, disputes 598fcbaa, intelligence e7f18266. The Part lists
// below are their TOC arrays, word for word, with "Recova" read as "Foxhound"
// (branding, RULES.md 1.2). The H3 lists are their H3 children in order.






// Recova's H3s, in order, MINUS the ones cut because the feature they describe
// does not exist in Foxhound. Each cut is named with its reason, so a cut is a
// decision in this file and never a silent omission.

describe("J73 PLANT 2: every claim is Foxhound's engine, not Recova's", () => {

  it("RECOVERY: every decline code the guide names classifies into the category it is shown under", () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(DocWidget, { name: "decline-categories" })));
    for (const [category, label] of Object.entries(DECLINE_CATEGORY_LABELS)) {
      const start = html.indexOf(`data-category="${category}"`);
      expect(start, `${label} card`).toBeGreaterThanOrEqual(0);
      const end = html.indexOf("data-category=", start + 1);
      const card = html.slice(start, end === -1 ? undefined : end);
      const codes = [...card.matchAll(/<code[^>]*>([a-z_]+)<\/code>/g)].map((m) => m[1]!);
      if (category !== "unknown") expect(codes.length, `${category} names codes`).toBeGreaterThan(0);
      for (const code of codes) expect(classifyDecline(code), code).toBe(category);
    }
  });
});
