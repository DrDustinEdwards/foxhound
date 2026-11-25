import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiKeys, oauthAuthorizationCodes } from "~/db/schema";
import { verifyMcpToken } from "~/lib/auth/mcp-tokens";
import { isAcceptableRedirectUri, isRegisteredRedirect } from "~/lib/oauth/redirects";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  ALLOWED,
  CLAUDE_REDIRECT,
  NOW,
  ORIGIN,
  USER,
  authorizeParams,
  authorizeRoute,
  consent,
  context,
  db,
  harness,
  landing,
  pkcePair,
  provider,
  registerRoute,
  registered,
  sqlite,
  tokenCall,
} from "./helpers/oauth-provider";

describe("registration (RFC 7591)", () => {
  it("answers the registered client with defaults", async () => {
    const res = await provider.registerClient(
      db,
      { redirect_uris: [CLAUDE_REDIRECT] },
      NOW,
      ALLOWED,
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      client_name: "OAuth Client",
      redirect_uris: [CLAUDE_REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect(res.body.client_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refuses a body with no usable or no allowlisted redirect URI", async () => {
    for (const body of [
      {},
      { redirect_uris: [] },
      { redirect_uris: "x" },
      { redirect_uris: [7] },
    ]) {
      const res = await provider.registerClient(db, body, NOW, ALLOWED);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toBe("invalid_redirect_uri");
    }
    // And one that is not on the shared allowlist.
    const unlisted = await provider.registerClient(
      db,
      { redirect_uris: ["https://evil.example/cb"] },
      NOW,
      ALLOWED,
    );
    expect(unlisted.status).toBe(400);
    expect(unlisted.body.error).toBe("invalid_redirect_uri");
  });

  it("the route limits per address, caps allowlisted registrations a day, and fails closed", async () => {
    const call = async (redirect = CLAUDE_REDIRECT) =>
      (await registerRoute.action({
        request: new Request(`${ORIGIN}/api/oauth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_name: "Claude", redirect_uris: [redirect] }),
        }),
        context: context(),
        params: {},
      } as never)) as Response;
    expect((await call()).status).toBe(201);
    // The daily cap counts only registrations the allowlist would take, so an
    // unlisted one is still answered 400 for what it is.
    harness.limitedBuckets = ["oauth-register-all"];
    expect((await call()).status).toBe(429);
    expect((await call("https://evil.example/cb")).status).toBe(400);
    harness.limitedBuckets = ["oauth-register"];
    expect((await call("https://evil.example/cb")).status).toBe(429);
    harness.limitedBuckets = [];
    harness.limiterDown = true;
    expect((await call()).status).toBe(429);
  });
});

describe("redirect match: exact, except loopback ports (RFC 8252)", () => {
  it("matches a loopback URI on any port and everything else exactly", () => {
    expect(
      isRegisteredRedirect("http://localhost:53682/callback", ["http://localhost/callback"]),
    ).toBe(true);
    expect(isRegisteredRedirect("http://127.0.0.1:9/cb", ["http://127.0.0.1:1234/cb"])).toBe(true);
    expect(isRegisteredRedirect("https://claude.ai/cb", ["https://claude.ai/cb"])).toBe(true);
    expect(isRegisteredRedirect("https://claude.ai:8443/cb", ["https://claude.ai/cb"])).toBe(false);
    expect(isRegisteredRedirect("http://localhost/other", ["http://localhost/callback"])).toBe(
      false,
    );
  });
});

describe("the authorize request", () => {
  it("refuses each bad parameter and accepts a good request", async () => {
    const clientId = await registered();
    const { challenge } = await pkcePair();
    const refused: Array<Record<string, string>> = [
      { client_id: "" },
      { redirect_uri: "" },
      { response_type: "token" },
      { code_challenge: "" },
      { code_challenge_method: "plain" },
      { client_id: "00000000-0000-0000-0000-000000000000" },
      { redirect_uri: "https://evil.example/cb" },
      { resource: "https://evil.example/mcp" },
    ];
    for (const override of refused) {
      const params = authorizeParams(clientId, challenge, override);
      for (const [k, v] of Object.entries(override)) if (v === "") params.delete(k);
      const check = await provider.checkAuthorizeRequest(db, params, ORIGIN);
      expect(check, JSON.stringify(override)).toMatchObject({ ok: false });
    }
    const good = await provider.checkAuthorizeRequest(
      db,
      authorizeParams(clientId, challenge),
      ORIGIN,
    );
    expect(good).toMatchObject({
      ok: true,
      clientId,
      clientName: "Claude",
      redirectUri: CLAUDE_REDIRECT,
      state: "st_123",
    });
  });

  it("a signed-out visitor goes to /login with EVERY parameter kept, resource included", async () => {
    harness.session = null;
    const clientId = await registered();
    const { challenge } = await pkcePair();
    const params = authorizeParams(clientId, challenge, {
      resource: `${ORIGIN}/mcp`,
      prompt: "consent",
    });
    const url = `${ORIGIN}/oauth/authorize?${params}`;
    let thrown: unknown;
    try {
      await authorizeRoute.loader({
        request: new Request(url),
        context: context(),
        params: {},
      } as never);
    } catch (e) {
      thrown = e;
    }
    const res = thrown as Response;
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location")!, ORIGIN);
    expect(location.pathname).toBe("/login");
    const next = new URL(location.searchParams.get("next")!, ORIGIN);
    expect(next.pathname).toBe("/oauth/authorize");
    for (const [k, v] of params) expect(next.searchParams.get(k), k).toBe(v);
  });

  it("a signed-in visitor sees the ACTIVE account, never the earliest", async () => {
    const clientId = await registered();
    const { challenge } = await pkcePair();
    const data = (await authorizeRoute.loader({
      request: new Request(`${ORIGIN}/oauth/authorize?${authorizeParams(clientId, challenge)}`),
      context: context(),
      params: {},
    } as never)) as { ok: true; accountName: string; email: string; clientName: string };
    expect(data).toMatchObject({
      ok: true,
      accountName: "Beta Ltd",
      email: "dana@acme.test",
      clientName: "Claude",
    });
  });

  it("a signed-in visitor with no account goes to /connect", async () => {
    sqlite.prepare("DELETE FROM account_members").run();
    const clientId = await registered();
    const { challenge } = await pkcePair();
    let thrown: unknown;
    try {
      await authorizeRoute.loader({
        request: new Request(`${ORIGIN}/oauth/authorize?${authorizeParams(clientId, challenge)}`),
        context: context(),
        params: {},
      } as never);
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Response).headers.get("Location")).toBe("/connect");
  });
});

describe("consent", () => {
  it("Allow mints a code for the active account and returns state", async () => {
    const clientId = await registered();
    const { challenge } = await pkcePair();
    const back = await consent(clientId, challenge);
    expect(`${back.origin}${back.pathname}`).toBe(CLAUDE_REDIRECT);
    expect(back.searchParams.get("state")).toBe("st_123");
    expect(back.searchParams.get("iss"), "RFC 9207").toBe(ORIGIN);
    expect(back.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await db.select().from(oauthAuthorizationCodes);
    expect(rows).toHaveLength(1);
    expect(rows[0].accountId).toBe(ACCOUNT_B);
    expect(rows[0].userId).toBe(USER);
    expect(rows[0].codeHash).not.toBe(back.searchParams.get("code"));
  });

  it("Deny goes back with access_denied and the state, and mints nothing", async () => {
    const clientId = await registered();
    const { challenge } = await pkcePair();
    const back = await consent(clientId, challenge, "deny");
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("st_123");
    expect(back.searchParams.get("iss"), "RFC 9207").toBe(ORIGIN);
    expect(await db.select().from(oauthAuthorizationCodes)).toHaveLength(0);
  });

  it("the card's account is posted back and checked, never used: a mismatch is refused and binds nothing", async () => {
    const clientId = await registered();
    const { challenge } = await pkcePair();
    const loaded = (await authorizeRoute.loader({
      request: new Request(`${ORIGIN}/oauth/authorize?${authorizeParams(clientId, challenge)}`),
      context: context(),
      params: {},
    } as never)) as { accountId: string };
    expect(loaded.accountId).toBe(ACCOUNT_B);
    // The merchant switched to another account in a second tab after the card
    // rendered (or the field was tampered with, or is missing): refused.
    for (const shown of [ACCOUNT_A, null]) {
      const form = authorizeParams(clientId, challenge, { intent: "allow" });
      if (shown) form.set("account_id", shown);
      const res = (await authorizeRoute.action({
        request: new Request(`${ORIGIN}/oauth/authorize`, {
          method: "POST",
          headers: { Origin: ORIGIN },
          body: form,
        }),
        context: context(),
        params: {},
      } as never)) as { data?: { error?: string }; init?: { status?: number } } | Response;
      expect(res instanceof Response, `shown=${shown}`).toBe(false);
      expect((res as { init: { status: number } }).init.status, `shown=${shown}`).toBe(409);
    }
    expect(await db.select().from(oauthAuthorizationCodes)).toHaveLength(0);
    // The matching account goes through, and is the session's.
    const back = await consent(clientId, challenge);
    expect(back.searchParams.get("code")).toBeTruthy();
    const [row] = await db.select().from(oauthAuthorizationCodes);
    expect(row.accountId).toBe(ACCOUNT_B);
  });

  it("a member, not the owner, is refused on the card and on Allow, and nothing is minted", async () => {
    sqlite
      .prepare("UPDATE account_members SET role = 'member' WHERE account_id = ?")
      .run(ACCOUNT_B);
    const clientId = await registered();
    const { challenge } = await pkcePair();
    const loaded = (await authorizeRoute.loader({
      request: new Request(`${ORIGIN}/oauth/authorize?${authorizeParams(clientId, challenge)}`),
      context: context(),
      params: {},
    } as never)) as unknown as { data: { ok: boolean }; init: { status: number } };
    expect(loaded.data.ok).toBe(false);
    expect(loaded.init.status).toBe(403);
    // An unknown client is refused on the card too, with a 400.
    const unknown = (await authorizeRoute.loader({
      request: new Request(
        `${ORIGIN}/oauth/authorize?${authorizeParams("00000000-0000-0000-0000-000000000000", challenge)}`,
      ),
      context: context(),
      params: {},
    } as never)) as unknown as { data: { title: string }; init: { status: number } };
    expect(unknown.init.status).toBe(400);
    expect(unknown.data.title).toBe("Unknown client");
    const form = authorizeParams(clientId, challenge, { intent: "allow", account_id: ACCOUNT_B });
    const res = (await authorizeRoute.action({
      request: new Request(`${ORIGIN}/oauth/authorize`, {
        method: "POST",
        headers: { Origin: ORIGIN },
        body: form,
      }),
      context: context(),
      params: {},
    } as never)) as { init?: { status?: number } } | Response;
    expect(res instanceof Response ? res.status : res.init?.status).toBe(403);
    expect(await db.select().from(oauthAuthorizationCodes)).toHaveLength(0);
  });

  it("a post from another origin is refused before anything is minted", async () => {
    const clientId = await registered();
    const { challenge } = await pkcePair();
    const form = authorizeParams(clientId, challenge, { intent: "allow" });
    const res = (await authorizeRoute.action({
      request: new Request(`${ORIGIN}/oauth/authorize`, {
        method: "POST",
        headers: { Origin: "https://evil.example" },
        body: form,
      }),
      context: context(),
      params: {},
    } as never)) as { init?: { status?: number } } | Response;
    const status = res instanceof Response ? res.status : res.init?.status;
    expect(status).toBe(403);
    expect(await db.select().from(oauthAuthorizationCodes)).toHaveLength(0);
  });

  it("a tampered redirect URI in the form is refused, never followed", async () => {
    const clientId = await registered();
    const { challenge } = await pkcePair();
    const form = authorizeParams(clientId, challenge, {
      intent: "allow",
      redirect_uri: "https://evil.example/cb",
    });
    const res = (await authorizeRoute.action({
      request: new Request(`${ORIGIN}/oauth/authorize`, {
        method: "POST",
        headers: { Origin: ORIGIN },
        body: form,
      }),
      context: context(),
      params: {},
    } as never)) as { data?: { error?: string }; init?: { status?: number } } | Response;
    expect(res instanceof Response).toBe(false);
    expect((res as { data: { error: string } }).data.error).toBeTruthy();
    expect(await db.select().from(oauthAuthorizationCodes)).toHaveLength(0);
  });
});

describe("safeNextPath", () => {
  it("refuses off-site, malformed and non-ASCII targets, and decodes once", () => {
    for (const bad of [
      "https://evil.example/",
      "//evil.example/x",
      "/\\evil.example",
      "evil",
      "",
      null,
      undefined,
      "/\t/evil.example",
      "/\n/evil.example",
      "%2F%09%2Fevil.example",
      "/\u3000/x",
      "/\u00a0/x",
      "/caf\u00e9",
      "/\u2028x",
      "%2F%E3%80%80%2Fx",
      encodeURIComponent("//evil.example"),
    ]) {
      expect(landing(bad), String(bad)).toBe("/console");
    }
    expect(landing(encodeURIComponent("/oauth/authorize?a=1"))).toBe("/oauth/authorize?a=1");
    expect(landing("/oauth/authorize?a=%E3%80%80")).toBe("/oauth/authorize?a=%E3%80%80");
  });
});

type ConsentProps = Parameters<typeof authorizeRoute.default>[0];
type ConsentData = ConsentProps["loaderData"];

const CONSENT_OK: ConsentData = {
  ok: true,
  clientId: "c1",
  clientName: "Claude",
  redirectUri: CLAUDE_REDIRECT,
  state: "st",
  codeChallenge: "x".repeat(43),
  wantsWrite: false,
  publishedBy: "claude.ai",
  redirectHost: "claude.ai",
  redirectWarning: null,
  accountId: ACCOUNT_B,
  accountName: "Acme Supply Co.",
  email: "dana@acme.test",
};

function renderConsent(loaderData: ConsentData): string {
  const Page = authorizeRoute.default;
  const props = {
    loaderData,
    actionData: undefined,
    params: {},
    matches: [],
  } as unknown as ConsentProps;
  const router = createMemoryRouter([{ path: "*", element: createElement(Page, props) }], {
    initialEntries: ["/oauth/authorize"],
  });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

describe("the consent page", () => {
  it("ticks Allow changes only when the client asked to write", () => {
    const box = /<input[^>]*name="allow_write"[^>]*>/.exec(renderConsent(CONSENT_OK))?.[0] ?? "";
    expect(box, "the read-only grant is the default").not.toMatch(/checked/);
    expect(renderConsent({ ...CONSENT_OK, wantsWrite: true })).toMatch(
      /<input[^>]*name="allow_write"[^>]*checked/,
    );
  });
});

describe("a client known by its metadata document (CIMD)", () => {
  const DOC_URL = "https://agent.example/oauth/client.json";
  const doc = (over: Record<string, unknown> = {}) => ({
    client_id: DOC_URL,
    client_name: "Example Agent",
    redirect_uris: [CLAUDE_REDIRECT],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    ...over,
  });
  let served: Record<string, unknown> = doc();
  const fetched: string[] = [];

  beforeEach(() => {
    served = doc();
    fetched.length = 0;
    // The library fetches only under global_fetch_strictly_public (wrangler.jsonc).
    vi.stubGlobal("Cloudflare", { compatibilityFlags: { global_fetch_strictly_public: true } });
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(String(url));
      return new Response(JSON.stringify(served), {
        headers: { "Content-Type": "application/json" },
      });
    });
  });

  it("fetches the document, connects the client it names, and refuses one that fails a check", async () => {
    const { verifier, challenge } = await pkcePair();
    const check = await provider.checkAuthorizeRequest(
      db,
      authorizeParams(DOC_URL, challenge),
      ORIGIN,
    );
    expect(check).toMatchObject({
      ok: true,
      clientId: DOC_URL,
      clientName: "Example Agent",
      metadataDocument: true,
    });
    expect(fetched).toEqual([DOC_URL]);

    const back = await consent(DOC_URL, challenge);
    const { status, body } = await tokenCall({
      grant_type: "authorization_code",
      code: back.searchParams.get("code")!,
      code_verifier: verifier,
      client_id: DOC_URL,
      redirect_uri: CLAUDE_REDIRECT,
    });
    expect(status).toBe(200);
    const [key] = await db.select().from(apiKeys);
    expect(key.label).toBe("Example Agent (OAuth)");
    expect((await verifyMcpToken(db, body.access_token as string))?.accountId).toBe(ACCOUNT_B);

    // A document that names another client_id, offers a redirect the request
    // does not use, or wants a client secret: the client is unknown.
    for (const bad of [
      doc({ client_id: "https://agent.example/other.json" }),
      doc({ redirect_uris: ["https://agent.example/elsewhere"] }),
      doc({ token_endpoint_auth_method: "client_secret_basic" }),
    ]) {
      served = bad;
      const refused = await provider.checkAuthorizeRequest(
        db,
        authorizeParams(DOC_URL, challenge),
        ORIGIN,
      );
      expect(refused.ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("redirect schemes: an operating-system handler is never a client", () => {
  it("refuses Windows and other OS protocol handlers, keeps real clients' schemes", () => {
    for (const uri of [
      "ms-msdt:/id PCWDiagnostic",
      "search-ms:query=x",
      "ms-settings:privacy",
      "ms-officecmd:x",
      "ms-word:ofe|u|https://evil.example/a.docx",
      "shell:startup",
      "mk:@MSITStore:x",
      "its:x",
      "hcp://x",
      "jar:https://evil.example/a.jar!/",
      "view-source:https://evil.example",
      "filesystem:https://evil.example/x",
      "ftp://evil.example/cb",
      "mailto:a@example.com",
      "tel:123",
      "sms:123",
      "intent://x#Intent;end",
    ]) {
      expect(isAcceptableRedirectUri(uri), uri).toBe(false);
    }
    for (const uri of [
      "https://claude.ai/api/mcp/auth_callback",
      "http://localhost:43123/callback",
      "http://127.0.0.1/callback",
      "cursor://anysphere.cursor-retrieval/oauth/callback",
      "vscode://vscode.github-authentication/did-authenticate",
      "com.example.agent:/oauth/callback",
    ]) {
      expect(isAcceptableRedirectUri(uri), uri).toBe(true);
    }
  });
});
