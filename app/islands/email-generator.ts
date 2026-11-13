// An island (devkit ./islands): the home page's live email generator (components/email-samples.tsx) on a page
// that does not hydrate. Capsomer's AI sample behavior runs it, as the React page does.
import { enhance } from "capsomer/behavior/ai-sample";

import { generateEmailSample } from "../lib/marketing/email-sample";

export default function start(): void {
  enhance(document, { generate: generateEmailSample });
}
