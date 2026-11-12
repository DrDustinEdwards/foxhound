// Tags and alt text a model suggests for one library picture: site-api's mediaSuggester (Claude Haiku 5.5, straight at
// Anthropic with ANTHROPIC_API_KEY). Nothing here writes a file: a suggestion reaches one only
// when an editor accepts it in Carrel, as an alt or a tags write. The only pictures sent are the blog pictures Carrel
// uploaded; no merchant data is ever in them or in the prompt. Every call is metered in ai_calls (source
// "media-suggest", no account), as the Anthropic calls are.

import { mediaSuggester } from "@dustinedwards/site-api";

import { getDb } from "~/db";
import { buildAiCallRow } from "~/lib/ai/cost";
import { errorMessage } from "@dustinedwards/site-runtime/log";

export const suggestFor = mediaSuggester<Env>({
  app: "foxhound",
  describe: "in a blog about failed payments and subscription billing",
  async afterCall(env, usage, id) {
    try {
      await buildAiCallRow(getDb(env), {
        accountId: null,
        source: "media-suggest",
        model: usage.model,
        promptTokens: Math.ceil(usage.input + usage.cacheRead * 0.1 + usage.cacheWrite * 1.25),
        completionTokens: usage.output,
        relatedId: id ?? null,
        createdAt: new Date(),
      });
    } catch (err) {
      console.error("ai_calls write failed for media-suggest:", errorMessage(err));
    }
  },
});
