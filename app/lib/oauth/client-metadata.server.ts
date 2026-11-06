// CLIENT ID METADATA DOCUMENTS (the MCP authorization spec's CIMD): a client
// that has not registered uses the https URL of a JSON document it publishes as
// its client_id, and the authorization server fetches that document to learn
// the client's name and redirect URIs.
//
// THE FETCH AND THE CHECKS ARE @cloudflare/workers-oauth-provider's, the
// library the admin MCP already runs, not Foxhound's own: the URL shape (https,
// a path, no userinfo, fragment or dot segments), a 10 second timeout, a 5 KB
// ceiling, the document's client_id equal to the URL it came from, a client
// name, safe redirect URIs, no secret and no private key, and the cache the
// document's own Cache-Control allows. The library refuses to fetch at all
// unless the Worker runs with global_fetch_strictly_public, so a client_id
// cannot point the fetch at anything private (wrangler.jsonc).
//
// It is imported only when a client_id is such a URL, so a registered client's
// authorize request never loads it.

/** A client known from its metadata document. */
export interface MetadataDocumentClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
}

/** Whether a client_id is the URL of a metadata document rather than an id
 *  this server minted at registration (a UUID). */
export function isMetadataDocumentClientId(clientId: string): boolean {
  return clientId.startsWith("https://");
}

/**
 * Fetch and validate the document at `clientId`. Null when it cannot be
 * fetched, fails a check, or asks to authenticate at the token endpoint in a way
 * other than "none": Foxhound issues no secrets and verifies no client keys, so
 * only a public client with PKCE can use it, as for a registered client.
 */
export async function resolveMetadataDocumentClient(clientId: string, resource: string): Promise<MetadataDocumentClient | null> {
  const { getOAuthApi } = await import("@cloudflare/workers-oauth-provider");
  // Only the client lookup is used. The library wants a whole provider to hang
  // it on; nothing here serves its routes or touches its KV, because a
  // metadata-document client id never reaches the KV path.
  const notServed = { fetch: async () => new Response(null, { status: 404 }) };
  const library = getOAuthApi(
    {
      apiRoute: "/mcp",
      apiHandler: notServed,
      defaultHandler: notServed,
      resourceMetadata: { resource },
      authorizeEndpoint: "/oauth/authorize",
      tokenEndpoint: "/api/oauth/token",
      clientIdMetadataDocumentEnabled: true,
    },
    {},
  );
  try {
    const client = await library.lookupClient(clientId);
    if (!client || client.tokenEndpointAuthMethod !== "none") return null;
    const clientName = client.clientName?.trim();
    if (!clientName) return null;
    return { clientId, clientName, redirectUris: client.redirectUris };
  } catch (error) {
    // CimdFetchError and the library's own refusals: the reason goes to the
    // log, and the person sees "Unknown client".
    console.warn("client metadata document refused:", clientId, error instanceof Error ? error.message : String(error));
    return null;
  }
}
