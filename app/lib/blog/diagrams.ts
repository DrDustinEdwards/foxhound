import declineCodeTaxonomy from "./diagrams/decline-code-taxonomy.svg?raw";
import disputeLifecycle from "./diagrams/dispute-lifecycle.svg?raw";
import dunningSequenceTimeline from "./diagrams/dunning-sequence-timeline.svg?raw";
import involuntaryVsVoluntary from "./diagrams/involuntary-vs-voluntary.svg?raw";
import mrrWaterfall from "./diagrams/mrr-waterfall.svg?raw";
import recoverySequence from "./diagrams/recovery-sequence.svg?raw";
import recoveryVsSmartRetries from "./diagrams/recovery-vs-smart-retries.svg?raw";

// The seven hand-drawn blog diagrams, read into the Worker at build time.
// The page inlines the SVG. Nothing requests the file.
export const BLOG_DIAGRAMS: Readonly<Record<string, string>> = {
  "decline-code-taxonomy": declineCodeTaxonomy,
  "dispute-lifecycle": disputeLifecycle,
  "dunning-sequence-timeline": dunningSequenceTimeline,
  "involuntary-vs-voluntary": involuntaryVsVoluntary,
  "mrr-waterfall": mrrWaterfall,
  "recovery-sequence": recoverySequence,
  "recovery-vs-smart-retries": recoveryVsSmartRetries,
};
