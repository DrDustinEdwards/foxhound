import { describe, expect, it, vi } from "vitest";

import { cloudflareContext } from "@dustinedwards/site-runtime/context";

// /og answers Recova's URL shape (card type, title and excerpt in the query),
// because the redirect map sends that path here unchanged.
//
// Takumi's WASM cannot load under vitest, so the renderer is replaced by a
// stand-in that records the HTML it was asked to draw.
const drawn: string[] = [];
vi.mock("@dustinedwards/site-runtime/share-card-draw", () => ({
  drawShareCard: async (html: string) => {
    drawn.push(html);
    return new Uint8Array([137, 80, 78, 71]);
  },
}));

const { loader } = await import("~/routes/files/og");

async function render(
  path: string,
  params: Record<string, string> = {},
): Promise<{ response: Response; html: string }> {
  const context = {
    get: (key: unknown) =>
      key === cloudflareContext ? { env: { SITE_URL: "https://example.com" } } : undefined,
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

describe("/og URL shape", () => {
  it("/og with no query draws the default card", async () => {
    const { response, html } = await render("/og");
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(html).toContain(">hound</div>");
    expect(html).not.toContain("Foxhound Blog");
  });

  it("/og?type=blog draws the blog card with its title and description parameters", async () => {
    const { html } = await render(
      "/og?type=blog&title=Why%20cards%20fail&description=Soft%20declines%20explained",
    );
    expect(html).toContain("Foxhound Blog");
    expect(html).toContain(">Why cards fail</div>");
    expect(html).toContain(">Soft declines explained</div>");
  });
});

// The renderer parses the card from HTML, and whitespace between two tags
// becomes a text child that shifts justify-content:space-between layouts.
describe("the card HTML has no blank text children", () => {
  it("no tag is followed by whitespace-only text before the next tag", async () => {
    for (const path of ["/og", "/og?type=blog&title=T&description=D", "/og?type=blog&title=T"]) {
      const { html } = await render(path);
      expect(html.trim()).toBe(html);
      expect(html.match(/>\s+</g) ?? []).toEqual([]);
    }
  });
});
