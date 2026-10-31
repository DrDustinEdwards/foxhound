import {
  messages,
  structured,
  type CallOptions,
  type CallRecord,
  type MessagesRequest,
} from "@dustinedwards/site-runtime/anthropic";

import { getDb } from "~/db";

import { buildAiCallRow } from "./cost";

// EVERY ANTHROPIC CALL GOES THROUGH site-runtime's ./anthropic, the family's one
// caller: where the call goes (AI Gateway or direct), the deadline, the ONE retry
// layer, stop reasons and the log line are all its. What stays here is Foxhound's
// meter. Each call site names what it is (`source`) and whose it is (`accountId`,
// null for the anonymous audit and the home page's sample), and every call,
// retries included, writes one ai_calls row with its tokens and cost. A failed
// cost write is logged and never fails the call: the copy the merchant is waiting
// on matters more than its cost row.

/** What one call site's calls are logged as in ai_calls. */
export interface AiCallMeter {
  source: string;
  accountId: string | null;
  relatedId?: string | null;
}

/** A call's input as input-priced tokens, rounded up: a cache read costs 0.1x the input
 *  price and a five-minute cache write 1.25x (platform.claude.com prompt-caching pricing). */
function promptTokens(record: CallRecord): number {
  return Math.ceil(record.input + record.cacheRead * 0.1 + record.cacheWrite * 1.25);
}

async function recordAiCall(env: Env, meter: AiCallMeter, record: CallRecord): Promise<void> {
  // A call that failed before any token was billed costs nothing and leaves no row.
  if (record.input + record.output + record.cacheRead + record.cacheWrite === 0) return;
  try {
    await buildAiCallRow(getDb(env), {
      accountId: meter.accountId,
      source: meter.source,
      model: record.model,
      promptTokens: promptTokens(record),
      completionTokens: record.output,
      relatedId: meter.relatedId ?? null,
      createdAt: new Date(),
    });
  } catch (err) {
    console.error(`ai_calls write failed for ${meter.source}:`, err instanceof Error ? err.message : err);
  }
}

/** The options that meter one call, and the row write to wait for: the shared caller
 *  hands the record over without waiting, and a Worker may stop once it answers. */
function metered(env: Env, meter: AiCallMeter, options: CallOptions) {
  let written: Promise<void> = Promise.resolve();
  const onResult = (record: CallRecord) => {
    written = recordAiCall(env, meter, record);
    return written;
  };
  return { options: { ...options, feature: meter.source, onResult }, written: () => written };
}

/** One metered Messages call. Never throws for a failed call; the result says why. */
export async function askModel(env: Env, meter: AiCallMeter, request: MessagesRequest, options: CallOptions = {}) {
  const call = metered(env, meter, options);
  const result = await messages(env, "foxhound", request, call.options);
  await call.written();
  return result;
}

/** One metered call whose answer is JSON matching `schema`, parsed into `value`. */
export async function askStructured<T>(
  env: Env,
  meter: AiCallMeter,
  request: MessagesRequest,
  schema: Record<string, unknown>,
  options: CallOptions = {},
) {
  const call = metered(env, meter, options);
  const result = await structured<T>(env, "foxhound", request, schema, call.options);
  await call.written();
  return result;
}

/** A content rewrite (stock phrasing, a timing word) is optional: the first draft stands
 *  if it fails, so it gets one attempt and the retry layer's attempts stay on the first call. */
export const REWRITE: CallOptions = { maxAttempts: 1 };
