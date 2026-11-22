import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import route from "~/routes/app/settings/brand-voice";

const Page = route as unknown as (props: { loaderData: Record<string, unknown> }) => ReactElement;

type Stored = Partial<Record<"soft" | "expired" | "network" | "fraud", string | null>>;

function render(stored: Stored): string {
  const loaderData = {
    connectionId: "conn_1",
    stored: { soft: null, expired: null, network: null, fraud: null, ...stored },
    samples: [],
  };
  const Stub = createRoutesStub([
    { path: "/settings/brand-voice", Component: () => createElement(Page, { loaderData }) },
  ]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/settings/brand-voice"] }));
}

describe("brand voice settings", () => {
  // A stored voice must come back in the field the save posts, or saving erases it.
  it("round-trips a stored preset and a stored custom voice through the form", () => {
    const preset = render({ network: "direct and no-nonsense" });
    expect(preset).toMatch(/<option value="direct and no-nonsense" selected="">/);
    expect(preset).toMatch(
      /<input type="hidden" name="voice_network" value="direct and no-nonsense"\/>/,
    );

    const custom = render({ fraud: "calm and careful" });
    expect(custom).toMatch(/<option value="custom" selected="">/);
    expect(custom).toContain(">calm and careful</textarea>");
    expect(custom).toMatch(/<input type="hidden" name="voice_fraud" value="calm and careful"\/>/);
  });
});
