import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "enarratio/base.css";
// Capsomer's --enarratio-* mapping onto its tokens, loaded with the chart so
// its colours do not depend on another file's imports.
import "capsomer/enarratio.css";

import { withoutHoverTitles } from "~/lib/intelligence/dashboard";

// An Enarratio figure drawn to its panel's width, for the Intelligence
// dashboard (row S16, job J67). Enarratio returns the figure as HTML (SVG,
// legend and data table); this draws it at a default width on the server and
// redraws it at the measured width in the browser, so axis text keeps its set
// size at every width instead of shrinking with a phone screen. The same
// approach as the churn chart (app/routes/app/intelligence/churn.tsx). The
// recovery dashboard's pull request, number 109, adds a shared EnarratioFigure of
// the same shape; once both land, this folds into it.

/** About the panel body's width in Recova's 1280px column. */
const DEFAULT_WIDTH = 1160;
const MIN_WIDTH = 280;
// Redraws happen in steps of this many pixels, so dragging a window redraws
// the SVG a few times rather than on every pixel.
const WIDTH_STEP = 40;

/** The width to draw at for a measured panel width. */
export function figureWidthFor(measured: number): number {
  return Math.max(MIN_WIDTH, Math.floor(measured / WIDTH_STEP) * WIDTH_STEP);
}

export function IntelligenceFigure({ draw }: { draw: (width: number) => string }) {
  const ref = useRef<HTMLDivElement>(null);
  const dataOpen = useRef(false);
  const [width, setWidth] = useState(DEFAULT_WIDTH);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver((entries) => {
      const measured = Math.floor(entries[0]?.contentRect.width ?? 0);
      if (measured <= 0) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setWidth(figureWidthFor(measured)));
    });
    observer.observe(el);
    // A redraw replaces Enarratio's "Data table" <details>; remember whether
    // the reader had it open. toggle does not bubble, hence capture.
    const onToggle = (event: Event) => {
      if (event.target instanceof HTMLDetailsElement) dataOpen.current = event.target.open;
    };
    el.addEventListener("toggle", onToggle, true);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      el.removeEventListener("toggle", onToggle, true);
    };
  }, []);

  const drawn = useMemo(() => {
    // Enarratio refuses input it cannot draw honestly by throwing; one chart's
    // refusal is shown in its own place, not the page's.
    try {
      return { html: withoutHoverTitles(draw(width)), error: "" };
    } catch (err) {
      return { html: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [draw, width]);

  useLayoutEffect(() => {
    if (!drawn.html || !dataOpen.current) return;
    const details = ref.current?.querySelector("details");
    if (details) details.open = true;
  }, [drawn.html]);

  // min-w-0: Capsomer's panel body is a grid, whose items default to their
  // content's width, so without it a phone would get a sideways-scrolling chart.
  return (
    <div ref={ref} className="min-w-0">
      {drawn.html === null ? (
        <p className="m-0 text-label text-text-tertiary">This chart could not be drawn: {drawn.error}</p>
      ) : (
        <div dangerouslySetInnerHTML={{ __html: drawn.html }} />
      )}
    </div>
  );
}
