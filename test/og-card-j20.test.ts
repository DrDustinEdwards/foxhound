import { describe, expect, it, vi } from "vitest";

import { cloudflareContext } from "~/lib/cloudflare-context";

// J20, row F6. Recova's card (legacy app/og/route.tsx, blob 59c49647) is the
// spec. Two things are checked here:
//
//   1. Recova's URL shape. Recova serves /og, with the card type, title and
//      excerpt in the query (?type=blog&title=...&description=...). Ruling 41's
//      redirect entry sends that path to the same path on Foxhound, so Foxhound
//      has to answer it with the same card Recova would draw.
//   2. Recova's default card spacing. Recova stacks the wordmark (24px below
//      it), the tagline (24px below it) and the amber line (8px above it), so
//      the line sits 32px under the tagline. Foxhound had 8px.
//
// workers-og's WASM cannot load under vitest, so ImageResponse is replaced by
// a stand-in that records the HTML it was asked to draw; everything Foxhound's
// own code does runs for real.
const drawn: string[] = [];
vi.mock("workers-og", () => ({
  ImageResponse: class extends Response {
    constructor(html: string) {
      super(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } });
      drawn.push(html);
    }
  },
}));

const { loader } = await import("~/routes/files/og");

async function render(path: string, params: Record<string, string> = {}): Promise<{ response: Response; html: string }> {
  const context = {
    get: (key: unknown) => (key === cloudflareContext ? { env: { SITE_URL: "https://example.com" } } : undefined),
  };
  const response = (await loader({
    params,
    request: new Request(`https://example.com${path}`),
    context,
  } as never)) as Response;
  const html = drawn.at(-1);
  if (html === undefined) throw new Error("no card was drawn");
  return { response, html };
}



describe("Recova's /og URL shape (ruling 41)", () => {
  it("/og with no query draws the default card", async () => {
    const { response, html } = await render("/og");
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(html).toContain(">hound</div>");
    expect(html).not.toContain("Foxhound Blog");
  });

  it("/og?type=blog draws the blog card with Recova's title and description parameters", async () => {
    const { html } = await render("/og?type=blog&title=Why%20cards%20fail&description=Soft%20declines%20explained");
    expect(html).toContain("Foxhound Blog");
    expect(html).toContain(">Why cards fail</div>");
    expect(html).toContain(">Soft declines explained</div>");
  });
});

// workers-og parses the card from HTML, and a run of spaces and newlines
// between two tags becomes a text child of the flex box. Recova's card is JSX,
// which has no such children. On the blog card those blank children took part
// in justify-content:space-between: the footer's host sat at x=271 instead of
// Recova's 80, the pill short of the right edge, and the footer about 36px
// above Recova's 72px bottom padding (decoded from the rendered PNG, J20).
describe("the card HTML has no blank text children", () => {
  it("no tag is followed by whitespace-only text before the next tag", async () => {
    for (const path of ["/og", "/og?type=blog&title=T&description=D", "/og?type=blog&title=T"]) {
      const { html } = await render(path);
      expect(html.trim()).toBe(html);
      expect(html.match(/>\s+</g) ?? []).toEqual([]);
    }
  });
});
