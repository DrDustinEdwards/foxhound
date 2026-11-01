// An island (devkit ./islands): the click-to-play embeds in a blog post. Prelum's enhanceEmbeds swaps a lite embed link for its
// player when the reader asks, so a post loads no third party until then. Only a post that holds an embed loads it
// (routes/blog/post.tsx marks the body), so a page without one sends no script for it.
import { enhanceEmbeds } from "@drdustinedwards/site-helpers/render/enhance";

export default function start(): void {
  enhanceEmbeds({ root: '[data-island="embeds"]' });
}
