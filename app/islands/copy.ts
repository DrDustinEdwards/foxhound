import { enhance } from "capsomer/behavior/copy";

// An island (devkit ./islands): Capsomer's copy buttons (CopyButton, capsomer/react/copy) on a page that does
// not hydrate. One call wires every copy button on the page by its command and commandfor.
export default function start(): void {
  enhance();
}
