// An island (devkit ./islands): the home page's live email generator (components/email-samples.tsx) on a page
// that does not hydrate, as the React one behaves. The decline type is the native radio group; choosing one
// clears the last email (a call still running shows its email when it lands, as the fetcher's does). Generate posts the chosen type to /marketing/generate-email-sample, says
// "Generating..." with no arrow while the call runs, then shows the email, or Recova's failure line when the
// route answers { error: true } or nothing usable.
const ACTION = "/marketing/generate-email-sample";
const UPDATE_URL = "https://billing.yoursaas.com/update";

type Result = { subject: string; body: string } | { error: true };

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function drawResult(out: HTMLElement, result: Result | null): void {
  out.replaceChildren();
  if (!result) return;
  if ("error" in result) {
    out.appendChild(
      node("div", "fh-sample-result fh-small fh-error", "Generation failed. Try again."),
    );
    return;
  }
  const box = node("div", "fh-sample-result");
  for (const part of [
    node("p", "fh-sample-label fh-mono fh-source fh-caps-wide fh-faint", "Subject"),
    node("div", "fh-sample-subject fh-copy fh-medium fh-text", result.subject),
    node("p", "fh-sample-label-tight fh-mono fh-source fh-caps-wide fh-faint", "Body"),
    node(
      "div",
      "fh-sample-body fh-pre-wrap fh-mono fh-small fh-soft",
      result.body.replace("{{update_url}}", UPDATE_URL),
    ),
    node(
      "p",
      "fh-sample-note fh-mono fh-source fh-faint",
      "Generated in real time by AI, for a fictional customer.",
    ),
  ])
    box.appendChild(part);
  out.appendChild(box);
}

async function generate(category: string): Promise<Result> {
  try {
    const response = await fetch(ACTION, {
      method: "POST",
      body: new URLSearchParams({ category }),
    });
    const result = (await response.json()) as Partial<{
      subject: string;
      body: string;
      error: true;
    }>;
    if (typeof result.subject === "string" && typeof result.body === "string")
      return { subject: result.subject, body: result.body };
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

  const onClick = async () => {
    const category =
      el.querySelector<HTMLInputElement>("input[name='decline-type']:checked")?.value ?? "soft";
    drawResult(out, null);
    setBusy(true);
    const result = await generate(category);
    setBusy(false);
    drawResult(out, result);
  };
  button.addEventListener("click", () => void onClick());
}
