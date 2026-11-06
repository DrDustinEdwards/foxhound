import {
  amountClass,
  FINAL_FRAME,
  FRAMES,
  iconClass,
  PAYMENTS,
  recoveredText,
  recoveredTone,
  REDUCED_MOTION_QUERY,
  rowClass,
  statValueClass,
  stepClass,
} from "../lib/marketing/queue-demo-frames";

// An island (devkit ./islands): the home hero's recovery queue (components/recovery-queue-demo.tsx) on a page
// that does not hydrate. It plays the same frames on the server's markup, the first one drawn already, with
// the same timings and the 800ms pulse; under prefers-reduced-motion it settles on the last frame and
// schedules nothing, and turning reduced motion on while the page is open stops it there.
export default function start(el: HTMLElement): void {
  const rows = [...el.querySelectorAll<HTMLElement>("[data-queue-row]")];
  const steps = [...el.querySelectorAll<HTMLElement>("[data-queue-step]")];
  const pulse = el.querySelector<HTMLElement>("[data-queue-pulse]");
  const stat = (name: string) => el.querySelector<HTMLElement>(`[data-queue-stat="${name}"]`);
  const sequence = el.querySelector<HTMLElement>("[data-queue-sequence]");

  const draw = (index: number) => {
    const frame = FRAMES[index]!;
    rows.forEach((row, i) => {
      const status = frame.statuses[i]!;
      row.className = rowClass(status);
      const icon = row.querySelector<HTMLElement>("[data-queue-icon]");
      if (icon) {
        icon.className = iconClass(status);
        for (const svg of icon.querySelectorAll("[data-queue-status]")) {
          svg.classList.toggle("hidden", svg.getAttribute("data-queue-status") !== status);
        }
      }
      const meta = row.querySelector("[data-queue-meta]");
      if (meta) meta.textContent = frame.metas[i] ?? "";
      const amount = row.querySelector("[data-queue-amount]");
      if (amount) amount.className = amountClass(status);
    });
    if (sequence) sequence.textContent = `${PAYMENTS[frame.activeSequence]!.name} sequence`;
    steps.forEach((step, i) => (step.className = stepClass(i, frame.done)));
    const recovered = stat("recovered");
    if (recovered) {
      recovered.className = statValueClass(recoveredTone(frame.recovered));
      recovered.textContent = recoveredText(frame.recovered);
    }
    const rate = stat("rate");
    if (rate) rate.textContent = frame.rate;
    const active = stat("active");
    if (active) active.textContent = String(frame.active);
  };

  let frameTimer: ReturnType<typeof setTimeout> | undefined;
  let pulseTimer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    clearTimeout(frameTimer);
    clearInterval(pulseTimer);
  };
  const play = () => {
    let frame = 0;
    let on = true;
    draw(0);
    if (pulse) pulse.style.opacity = "1";
    const advance = () => {
      frame = (frame + 1) % FRAMES.length;
      draw(frame);
      frameTimer = setTimeout(advance, FRAMES[frame]!.holdMs);
    };
    frameTimer = setTimeout(advance, FRAMES[0]!.holdMs);
    pulseTimer = setInterval(() => {
      on = !on;
      if (pulse) pulse.style.opacity = on ? "1" : "0.3";
    }, 800);
  };

  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  const apply = () => {
    stop();
    if (query.matches) draw(FINAL_FRAME);
    else play();
  };
  query.addEventListener("change", apply);
  apply();
}
