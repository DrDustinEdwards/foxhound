import { describe, expect, it, vi } from "vitest";

import { cloudflareContext } from "~/lib/cloudflare-context";
import { applySecurityHeaders } from "~/lib/http/content-security-policy";
import { SECURITY_HEADERS } from "~/lib/http/header-set";

// /og/* cards are images other sites show: og:image previews, and any page
// that embeds a Foxhound card. The Worker's default CORP is same-origin, which
// a browser enforces on a cross-origin <img>, so the og route sets
// cross-origin on its own response, and the Worker's merge keeps a route-set
// header (applyHeaderSet, overwrite: false). Recova sent no CORP at all.
//
// workers-og's WASM cannot load under vitest, so its ImageResponse is replaced
// by a plain PNG Response; everything Foxhound's own code does to the response
// runs for real.
vi.mock("workers-og", () => ({
  ImageResponse: class extends Response {
    constructor() {
      super(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } });
    }
  },
}));

const { loader } = await import("~/routes/files/og");

async function render(type: string): Promise<Response> {
  const context = {
    get: (key: unknown) => (key === cloudflareContext ? { env: { SITE_URL: "https://example.com" } } : undefined),
  };
  return (await loader({
    params: { params: type },
    request: new Request(`https://example.com/og/${type}?title=Hello`),
    context,
  } as never)) as Response;
}

describe("/og/* cards can be embedded by other origins", () => {
  it("the route sets Cross-Origin-Resource-Policy: cross-origin on its own response", async () => {
    for (const type of ["default", "blog"]) {
      const response = await render(type);
      expect(response.headers.get("Content-Type")).toBe("image/png");
      expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
    }
  });

  it("survives the Worker's merge, while every other response keeps same-origin", async () => {
    const merged = applySecurityHeaders(await render("default"), "dGVzdC1ub25jZS12YWx1ZTAw");
    expect(merged.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
    expect(SECURITY_HEADERS["Cross-Origin-Resource-Policy"]).toBe("same-origin");
    expect(applySecurityHeaders(new Response("x"), "dGVzdC1ub25jZS12YWx1ZTAw").headers.get("Cross-Origin-Resource-Policy")).toBe(
      "same-origin",
    );
  });
});
