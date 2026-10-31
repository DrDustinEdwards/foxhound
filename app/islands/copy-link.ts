// An island (devkit ./islands): "Copy link" (components/copy-link-button.tsx) on a page that does not hydrate.
// A press copies the URL and says "Copied" for `resetMs`, showing the copied icon where there is one.
export default function start(el: HTMLElement, props: { url: string; resetMs: number }): void {
  const label = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent === "Copy link");
  const show = (copied: boolean) => {
    if (label) label.textContent = copied ? "Copied" : "Copy link";
    for (const icon of el.querySelectorAll("[data-copied]")) {
      icon.classList.toggle("hidden", icon.getAttribute("data-copied") !== String(copied));
    }
  };
  el.addEventListener("click", async () => {
    await navigator.clipboard.writeText(props.url);
    show(true);
    setTimeout(() => show(false), props.resetMs);
  });
}
