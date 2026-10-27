import type { Db } from "~/db";
import { mcpCalls } from "~/db/schema";

import { maskEmailsInText } from "./redact";

// THE CALL LOG (MCP ruling 2026-10-10, rule 12.4): one append-only row per tool
// call, with the caller, the arguments and the result.
//
// WRITTEN AT THE DOOR, FROM THE REQUEST AND THE RESPONSE. ./handler.server.ts
// reads the tools/call messages out of the request before the SDK sees it and
// the answers out of the response after, so the log holds every call that got
// past authentication: one that ran, one a tool refused, one the SDK refused at
// its schema check, and one naming a tool that does not exist. Logging inside a
// tool would miss the last two, which are exactly the probes worth seeing.
//
// THE RESULT IS AN OUTCOME, NEVER THE DATA. A read's answer is the merchant's
// customers; copying it here would make this table a second, unredacted copy of
// them. What is kept is whether the call worked and, if not, the error text the
// agent was given, with email addresses masked.

/** Arguments that are credentials: kept as "[redacted]" wherever they appear. */
const CREDENTIAL_ARGUMENTS = new Set(["slack_webhook_url"]);

type McpCallOutcome = "ok" | "tool_error" | "protocol_error";

export interface McpToolCallRequest {
  id: string | number;
  tool: string;
  arguments: Record<string, unknown>;
}

interface JsonRpcMessage {
  id?: string | number | null;
  method?: string;
  params?: { name?: unknown; arguments?: unknown };
  result?: { isError?: boolean; structuredContent?: { error?: unknown }; content?: { text?: unknown }[] };
  error?: { message?: unknown };
}

function messages(raw: unknown): JsonRpcMessage[] {
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((m): m is JsonRpcMessage => !!m && typeof m === "object");
}

/** The tools/call requests in a request body. A notification (no id) is not a
 *  call: nothing answers it, so there is no result to log. */
export function toolCallsIn(body: unknown): McpToolCallRequest[] {
  return messages(body).flatMap((m) => {
    if (m.method !== "tools/call" || m.id === undefined || m.id === null) return [];
    const args = m.params?.arguments;
    return [
      {
        id: m.id,
        tool: typeof m.params?.name === "string" ? m.params.name : "",
        arguments: args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {},
      },
    ];
  });
}

/** The JSON-RPC messages in a response, whether it came as JSON or as SSE. */
export function answersIn(text: string, contentType: string | null): JsonRpcMessage[] {
  const payloads = (contentType ?? "").includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
    : [text];
  return payloads.flatMap((payload) => {
    try {
      return messages(JSON.parse(payload));
    } catch {
      return [];
    }
  });
}

function outcomeOf(answer: JsonRpcMessage | undefined): { outcome: McpCallOutcome; error: string | null } {
  if (!answer) return { outcome: "protocol_error", error: "No answer was returned for this call." };
  if (answer.error) return { outcome: "protocol_error", error: String(answer.error.message ?? "") };
  if (answer.result?.isError) {
    const structured = answer.result.structuredContent?.error;
    const text = answer.result.content?.[0]?.text;
    return { outcome: "tool_error", error: String(typeof structured === "string" ? structured : (text ?? "")) };
  }
  return { outcome: "ok", error: null };
}

/** Replace every credential argument, at any depth. */
function redactArguments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactArguments);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      CREDENTIAL_ARGUMENTS.has(key) ? "[redacted]" : redactArguments(item),
    ]),
  );
}

/**
 * Append one row per call. A failure to write the log is REPORTED, never
 * swallowed, and never turns the call into a failure: the call has already
 * happened (a write has already committed with its own trace), and telling the
 * agent it failed would be the one false statement this path could make.
 */
export async function recordToolCalls(
  db: Db,
  caller: { accountId: string; apiKeyId: string },
  calls: McpToolCallRequest[],
  answers: JsonRpcMessage[],
  now: Date,
): Promise<void> {
  if (calls.length === 0) return;
  const byId = new Map(answers.filter((a) => a.id !== undefined && a.id !== null).map((a) => [a.id, a]));
  const rows = calls.map((call) => {
    const { outcome, error } = outcomeOf(byId.get(call.id));
    return {
      accountId: caller.accountId,
      apiKeyId: caller.apiKeyId,
      tool: call.tool,
      arguments: redactArguments(call.arguments) as Record<string, unknown>,
      outcome,
      error: error === null ? null : maskEmailsInText(error),
      createdAt: now,
    };
  });
  try {
    await db.insert(mcpCalls).values(rows);
  } catch (err) {
    console.error(
      "mcp call log write failed:",
      caller.apiKeyId,
      rows.map((r) => r.tool).join(","),
      err instanceof Error ? err.message : String(err),
    );
  }
}
