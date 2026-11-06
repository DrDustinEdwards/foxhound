import { calculatorFigures, fmt, rangeFill } from "../lib/marketing/calculator-math";

// An island (devkit ./islands): the home page's recovery calculator (components/recovery-calculator.tsx) on a
// page that does not hydrate. Each slider moves its figure and every row under it, with the same math and the
// same words as the React one; the sliders keep Capsomer's fill and their spoken values.
export default function start(el: HTMLElement, props: { stripeRecoveryRatePercent: number; recoveryFeeBps: number }): void {
  const slider = (id: string) => el.querySelector<HTMLInputElement>(`#${id}`);
  const mrr = slider("mrr-slider");
  const failure = slider("failure-share-slider");
  const recovery = slider("recovery-share-slider");
  if (!mrr || !failure || !recovery) return;
  const set = (name: string, text: string) => {
    const out = el.querySelector(`[data-calc="${name}"]`);
    if (out) out.textContent = text;
  };
  const sync = (input: HTMLInputElement, text: string) => {
    input.setAttribute("aria-valuenow", input.value);
    input.setAttribute("aria-valuetext", text);
    input.style.setProperty("--cap-range-fill", rangeFill(Number(input.value), Number(input.min), Number(input.max)));
  };
  const update = () => {
    const values = { mrr: Number(mrr.value), failureShare: Number(failure.value), recoveryShare: Number(recovery.value) };
    const f = calculatorFigures({ ...values, ...props });
    set("mrr", fmt(values.mrr));
    set("failureShare", `${values.failureShare}%`);
    set("recoveryShare", `${values.recoveryShare}%`);
    sync(mrr, fmt(values.mrr));
    sync(failure, `${values.failureShare}%`);
    sync(recovery, `${values.recoveryShare}%`);
    set("failedRevenue", fmt(f.failedRevenue));
    set("failedRevenue-sub", `${values.failureShare}% of MRR, the share you set above`);
    set("stripeRecovers", fmt(f.stripeRecovers));
    set("remaining", fmt(f.remaining));
    set("foxhoundRecovers", fmt(f.foxhoundRecovers));
    set("foxhoundFee", `-${fmt(f.foxhoundFee)}`);
    set("netGainAnnual", `+${fmt(f.netGainAnnual)}`);
    set("netGain", `+${fmt(f.netGain)}`);
  };
  for (const input of [mrr, failure, recovery]) input.addEventListener("input", update);
  // A slider the browser restored on back or forward keeps its place, so the figures follow it at once.
  update();
}
