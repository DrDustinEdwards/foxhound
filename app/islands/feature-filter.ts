// An island (devkit ./islands): the /features product filter (components/feature-filter.tsx) on a page that
// does not hydrate. A press moves the one active choice: the wrapper's data-feature-filter, which the page's
// CSS reads to hide the other cards, each chip's aria-pressed, and the screen reader's line saying what is left.
export default function start(el: HTMLElement, props: { total: number; counts: Record<string, number> }): void {
  const chips = [...el.querySelectorAll<HTMLButtonElement>(".cap-chip[data-value]")];
  const status = el.querySelector<HTMLElement>(".cap-chips [role='status']");
  for (const chip of chips) {
    chip.addEventListener("click", () => {
      const active = chip.dataset.value ?? "All";
      el.dataset.featureFilter = active;
      for (const other of chips) other.setAttribute("aria-pressed", String(other === chip));
      if (status) {
        status.textContent =
          active === "All"
            ? `Showing all ${props.total} features`
            : `Showing ${props.counts[active] ?? 0} of ${props.total} features: ${active}`;
      }
    });
  }
}
