import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MultiLine, type MultiLineSeries } from "~/components/charts";

// charts.tsx primitives are SSR-first by design (DESIGN.md "Charts"): they must
// render to complete markup on the server with no client measurement pass.
// Rendering them with renderToStaticMarkup tests that claim directly.
function render(props: Parameters<typeof MultiLine>[0]): string {
  return renderToStaticMarkup(createElement(MultiLine, props));
}

const solid: MultiLineSeries = { name: "Involuntary", colorClassName: "text-red", values: [1, 2, 3] };
const dashed: MultiLineSeries = {
  name: "Voluntary",
  colorClassName: "text-text-tertiary",
  dashed: true,
  values: [3, 2, 1],
};

describe("MultiLine", () => {
  it("renders one polyline per series", () => {
    const html = render({ labels: ["Jan", "Feb", "Mar"], series: [solid, dashed] });
    expect(html.match(/<polyline/g)).toHaveLength(2);
  });

  it("renders the dashed series dashed and the solid one not", () => {
    const html = render({ labels: ["Jan", "Feb", "Mar"], series: [solid, dashed] });
    // Two dash occurrences for the dashed series: its polyline and its legend swatch.
    expect(html.match(/stroke-dasharray="4 2"/g)).toHaveLength(1);
  });

  // A gap and a zero are different claims. Drawing a missing point as zero would
  // report churn that was never measured.
  it("breaks the line at a null instead of plotting it as zero", () => {
    const html = render({
      labels: ["Jan", "Feb", "Mar", "Apr", "May"],
      series: [{ name: "Rate", colorClassName: "text-red", values: [1, 2, null, 4, 5] }],
    });
    // Two runs either side of the gap, so two polylines for one series.
    expect(html.match(/<polyline/g)).toHaveLength(2);
  });

  it("drops a single-point run rather than drawing a zero-length line", () => {
    const html = render({
      labels: ["Jan", "Feb", "Mar"],
      series: [{ name: "Rate", colorClassName: "text-red", values: [1, null, 3] }],
    });
    expect(html.match(/<polyline/g)).toBeNull();
  });

  it("renders a legend entry per series", () => {
    const html = render({ labels: ["Jan", "Feb"], series: [solid, dashed] });
    expect(html).toContain("Involuntary");
    expect(html).toContain("Voluntary");
  });

  it("formats the y axis through yTickFormat", () => {
    const html = render({
      labels: ["Jan", "Feb"],
      series: [solid],
      yTickFormat: (v) => `${v}%`,
    });
    expect(html).toContain("0%");
  });

  it("labels only the first and last x positions, so labels cannot overprint", () => {
    const html = render({ labels: ["Jan", "Feb", "Mar", "Apr"], series: [solid] });
    expect(html).toContain("Jan");
    expect(html).toContain("Apr");
    expect(html).not.toContain("Feb");
  });

  it("returns nothing when there is too little to plot", () => {
    expect(render({ labels: ["Jan"], series: [solid] })).toBe("");
    expect(render({ labels: ["Jan", "Feb"], series: [] })).toBe("");
  });

  // An all-null series has no scale, so there is nothing honest to draw.
  it("returns nothing when every value is null", () => {
    const html = render({
      labels: ["Jan", "Feb"],
      series: [{ name: "Rate", colorClassName: "text-red", values: [null, null] }],
    });
    expect(html).toBe("");
  });

  // No inline hex anywhere: color arrives via a Tailwind text class and
  // currentColor, which scripts/check-tokens.mjs enforces repo-wide.
  it("carries no inline color", () => {
    const html = render({ labels: ["Jan", "Feb"], series: [solid, dashed] });
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(html).toContain('stroke="currentColor"');
  });
});
