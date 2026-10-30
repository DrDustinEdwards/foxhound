// Tags and alt text a model suggests for one library picture (site-api v0.13.0, mediaSuggestions). Workers AI,
// through Cloudflare AI Gateway when AI_GATEWAY_BASE_URL is set, as dustinedwards.info does. Nothing here writes a
// file: a suggestion reaches one only when an editor accepts it in Carrel, as an alt or a tags write. The only
// pictures sent are the blog pictures Carrel uploaded; no merchant data is ever in them or in the prompt. Every
// call is metered in ai_calls (source "media-suggest", no account), as the Anthropic calls are.

import { readSuggestion } from "@dustinedwards/site-api";
import { anthropicRoute } from "@dustinedwards/site-runtime/ai-gateway";
import { toBase64 } from "@dustinedwards/site-runtime/encoding";
import { editImage } from "@dustinedwards/site-runtime/image";

import type { Db } from "~/db";
import { buildAiCallRow } from "~/lib/ai/cost";

/** Natively multimodal, Cloudflare-hosted, and the model dustinedwards.info suggests with. */
const SUGGEST_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

/** The longest edge the model is shown: enough to name what is in a picture, and a small request. */
const VIEW_EDGE = 768;

const PROMPT = [
  "You write alt text and library tags for one picture in a blog about failed payments and subscription billing.",
  'Answer with JSON only, in this shape: {"alt": "...", "tags": ["...", "..."]}.',
  "alt: one plain sentence, at most 25 words, describing what the picture shows: the subject, what it is doing,",
  "and any text that is legible in it. Say only what can be seen. Do not begin with 'Image of', 'Picture of' or",
  "'Photo of'. Do not interpret, praise or guess at names or places that are not written in the picture.",
  "tags: three to eight short lower case nouns for what is in the picture, words joined by hyphens, no duplicates.",
].join(" ");

/**
 * The gateway Workers AI runs through: its id from AI_GATEWAY_BASE_URL (the URL site-runtime's ./ai-gateway checks,
 * `.../v1/{account_id}/{gateway_id}/anthropic`), with that module's policy: bodies not logged and the site named on
 * each entry. Undefined without a gateway: the call goes to Workers AI directly.
 */
function suggestGateway(env: Pick<Env, "AI_GATEWAY_BASE_URL">): GatewayOptions | undefined {
  const route = anthropicRoute({ AI_GATEWAY_BASE_URL: env.AI_GATEWAY_BASE_URL }, "foxhound");
  if (!route.gateway) return undefined;
  const id = /\/v1\/[^/]+\/([^/]+)\/anthropic$/.exec(route.baseURL)?.[1];
  if (!id) throw new Error("AI_GATEWAY_BASE_URL names no gateway id");
  return { id, collectLog: false, metadata: { app: "foxhound" } };
}

/** What the model suggests for one stored picture. */
export async function suggestFor(
  env: Pick<Env, "AI" | "IMAGES" | "AI_GATEWAY_BASE_URL">,
  db: Db,
  key: string,
  picture: ReadableStream,
): Promise<{ tags: string[]; alt: string | null; model: string }> {
  const view = await editImage(env.IMAGES, picture, { maxEdge: VIEW_EDGE, format: "image/jpeg", quality: 80 });
  const image = `data:image/jpeg;base64,${toBase64(new Uint8Array(await view.arrayBuffer()))}`;
  const gateway = suggestGateway(env);
  const answer = await env.AI.run(
    SUGGEST_MODEL as keyof AiModels,
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            { type: "image_url", image_url: { url: image } },
          ],
        },
      ],
      max_tokens: 300,
      temperature: 0.2,
    } as never,
    gateway ? { gateway } : {},
  );
  const usage = (answer as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
  try {
    await buildAiCallRow(db, {
      accountId: null,
      source: "media-suggest",
      model: SUGGEST_MODEL,
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      relatedId: key,
      createdAt: new Date(),
    });
  } catch (err) {
    console.error("ai_calls write failed for media-suggest:", err instanceof Error ? err.message : err);
  }
  return { ...readSuggestion(answer), model: SUGGEST_MODEL };
}
