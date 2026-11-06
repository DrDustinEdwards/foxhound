// An island (devkit ./islands): the home page's live email generator (components/email-samples.tsx) on a page
// that does not hydrate, as the React one behaves. The decline type is the native radio group; choosing one
// clears the last email (a call still running shows its email when it lands, as the fetcher's does). Generate posts the chosen type to /marketing/generate-email-sample, says
// "Generating..." with no arrow while the call runs, then shows the email, or Recova's failure line when the
// route answers { error: true } or nothing usable.
const ACTION = "/marketing/generate-email-sample";
const UPDATE_URL = "https://billing.yoursaas.com/update";

type Result = { subject: string; body: string } | { error: true };

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function drawResult(out: HTMLElement, result: Result | null): void {
  out.replaceChildren();
  if (!result) return;
  if ("error" in result) {
    out.appendChild(node("div", "border-t border-border-sub p-5 text-label text-error-text", "Generation failed. Try again."));
    return;
  }
  const box = node("div", "border-t border-border-sub p-5");
  for (const part of [
    node("p", "mb-3 font-mono text-source uppercase tracking-widest text-text-subtle", "Subject"),
    node("div", "mb-4 rounded-lg border border-border-sub bg-bg px-3 py-2 text-copy font-medium text-text", result.subject),
    node("p", "mb-2 font-mono text-source uppercase tracking-widest text-text-subtle", "Body"),
    node(
      "div",
      "whitespace-pre-wrap rounded-lg border border-border-sub bg-bg px-3 py-3 font-mono text-label leading-[1.7] text-text-secondary",
      result.body.replace("{{update_url}}", UPDATE_URL),
    ),
    node("p", "mt-3 font-mono text-source text-text-subtle", "Generated in real time by AI, for a fictional customer."),
  ])
    box.appendChild(part);
  out.appendChild(box);
}

async function generate(category: string): Promise<Result> {
  try {
    const response = await fetch(ACTION, { method: "POST", body: new URLSearchParams({ category }) });
    const result = (await response.json()) as Partial<{ subject: string; body: string; error: true }>;
    if (typeof result.subject === "string" && typeof result.body === "string") return { subject: result.subject, body: result.body };
  } catch {
    // A network failure or a body that is not the route's JSON is a failed generation.
  }
  return { error: true };
}

export default function start(el: HTMLElement): void {
  const button = el.querySelector<HTMLButtonElement>("[data-email-generate]");
  const out = el.querySelector<HTMLElement>("[aria-live='polite']");
  if (!button || !out) return;
  const idle = [...button.childNodes].map((n) => n.cloneNode(true));
  const busyLabel = node("span", "cap-btn-label", "Generating...");

  el.addEventListener("change", (e) => {
    if ((e.target as HTMLInputElement).name !== "decline-type") return;
    drawResult(out, null);
  });

  const setBusy = (busy: boolean) => {
    button.disabled = busy;
    if (busy) button.setAttribute("aria-busy", "true");
    else button.removeAttribute("aria-busy");
    button.replaceChildren(...(busy ? [busyLabel] : idle.map((n) => n.cloneNode(true))));
  };

  button.addEventListener("click", async () => {
    const category = el.querySelector<HTMLInputElement>("input[name='decline-type']:checked")?.value ?? "soft";
    drawResult(out, null);
    setBusy(true);
    const result = await generate(category);
    setBusy(false);
    drawResult(out, result);
  });
}
