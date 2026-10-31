// An island (devkit ./islands): the FAQ accordion (components/faq-accordion.tsx) on a page that does not
// hydrate, as the React one behaves: one answer open at a time, a press on the open one closes it.
export default function start(el: HTMLElement): void {
  const items = [...el.querySelectorAll<HTMLButtonElement>(":scope > li > button[aria-expanded]")];
  const show = (button: HTMLButtonElement, open: boolean) => {
    button.setAttribute("aria-expanded", String(open));
    const sign = button.querySelector<HTMLElement>("[aria-hidden='true']");
    if (sign) sign.style.transform = open ? "rotate(45deg)" : "rotate(0deg)";
    const answer = button.nextElementSibling as HTMLElement | null;
    if (!answer) return;
    answer.setAttribute("aria-hidden", String(!open));
    answer.style.maxHeight = open ? "480px" : "0px";
  };
  for (const button of items) {
    button.addEventListener("click", () => {
      const opening = button.getAttribute("aria-expanded") !== "true";
      for (const other of items) show(other, other === button && opening);
    });
  }
}
