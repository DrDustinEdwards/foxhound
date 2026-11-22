import {
  appendAudit,
  correlationId,
  loggedArgs,
  recordAudit,
} from "@dustinedwards/site-runtime/audit-log";
import { chunked, rowsPerInsert } from "@dustinedwards/site-runtime/d1";
import { callerName } from "@dustinedwards/site-runtime/mcp-server";

import type { Db } from "~/db";
import { mcpCalls } from "~/db/schema";

import { maskEmailsInText } from "./redact";

import { errorMessage } from "@dustinedwards/site-runtime/log";
// The call log: one append-only row per tool call with the caller, arguments and result, written at the door from the
// request and response so it holds every call past authentication, including one the SDK refused at its schema check and
// one naming a nonexistent tool (the probes worth seeing; logging inside a tool would miss them). The result is an
// OUTCOME, never the data: a read's answer is the merchant's customers, so this table would become an unredacted copy;
// what is kept is whether the call worked and the error text the agent got, emails masked. Each row is also written to
// site-runtime's append-only, hash-chained ToolCallLog Durable Object (TOOL_CALL_LOG), with the same redacted arguments:
// `finished` for a call that ran, `refused` for one that never reached a tool; mcp_calls stays as the table Foxhound's
// pages read. The caller is the key, never the token, and each row names the OAuth client. A `started` row goes first
// (startToolCalls throws when it cannot, so the door refuses): a call that left no trace is not reachable.

/** Arguments that are credentials: kept as "[redacted]". A confirm code approves one exact call (./confirm.server.ts). */
const CREDENTIAL_ARGUMENTS = new Set(["slack_webhook_url", "confirm"]);

type McpCallOutcome = "ok" | "tool_error" | "protocol_error";

export interface McpToolCallRequest {
  id: string | number;
  tool: string;
  arguments: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

export interface McpCaller {
  accountId: string;
  apiKeyId: string;
  clientId: string | null;
}

export interface StartedCall {
  callId: string;
  correlationId: string;
}

interface JsonRpcMessage {
  id?: string | number | null;
  method?: string;
  params?: { name?: unknown; arguments?: unknown; _meta?: unknown };
  result?: {
    isError?: boolean;
    structuredContent?: { error?: unknown };
    content?: { text?: unknown }[];
  };
  error?: { message?: unknown };
}

function messages(raw: unknown): JsonRpcMessage[] {
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((m): m is JsonRpcMessage => !!m && typeof m === "object");
}

/** The tools/call requests in a request body. A notification (no id) is not a call: there is no result to log. */
export function toolCallsIn(body: unknown): McpToolCallRequest[] {
  return messages(body).flatMap((m) => {
    if (m.method !== "tools/call" || m.id === undefined || m.id === null) return [];
    const args = m.params?.arguments;
    const meta = m.params?._meta;
    return [
      {
        id: m.id,
        tool: typeof m.params?.name === "string" ? m.params.name : "",
        arguments:
          args && typeof args === "object" && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {},
        ...(meta && typeof meta === "object" && !Array.isArray(meta)
          ? { meta: meta as Record<string, unknown> }
          : {}),
      },
    ];
  });
}

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

function outcomeOf(answer: JsonRpcMessage | undefined): {
  outcome: McpCallOutcome;
  error: string | null;
} {
  if (!answer) return { outcome: "protocol_error", error: "No answer was returned for this call." };
  if (answer.error) return { outcome: "protocol_error", error: String(answer.error.message ?? "") };
  if (answer.result?.isError) {
    const structured = answer.result.structuredContent?.error;
    const text = answer.result.content?.[0]?.text;
    return {
      outcome: "tool_error",
      error: String(typeof structured === "string" ? structured : (text ?? "")),
    };
  }
  return { outcome: "ok", error: null };
}

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

function logName(caller: McpCaller): string {
  return callerName({ kind: "agent", principal: `key_${caller.apiKeyId}`, scopes: [] });
}

/** Write each call's `started` row to the shared log before anything runs; throws when one cannot be written. */
export async function startToolCalls(
  env: Env,
  server: { name: string; version: string },
  caller: McpCaller,
  calls: McpToolCallRequest[],
): Promise<StartedCall[]> {
  const started: StartedCall[] = [];
  for (const call of calls) {
    const ids = { callId: crypto.randomUUID(), correlationId: correlationId(call.meta) };
    await appendAudit(env, {
      ...ids,
      phase: "started",
      caller: logName(caller),
      tool: call.tool,
      args: await loggedArgs(redactArguments(call.arguments) as Record<string, unknown>),
      server,
      ...(caller.clientId ? { clientId: caller.clientId } : {}),
    });
    started.push(ids);
  }
  return started;
}

/** Append one row per call, after it ran. A failed write is REPORTED, never swallowed, and never turns the call into a
 *  failure: it already happened, and telling the agent it failed would be false. */
export async function recordToolCalls(
  env: Env,
  server: { name: string; version: string },
  db: Db,
  caller: McpCaller,
  calls: McpToolCallRequest[],
  started: StartedCall[],
  answers: JsonRpcMessage[],
  now: Date,
): Promise<void> {
  if (calls.length === 0) return;
  const byId = new Map(
    answers.filter((a) => a.id !== undefined && a.id !== null).map((a) => [a.id, a]),
  );
  const rows = calls.map((call) => {
    const { outcome, error } = outcomeOf(byId.get(call.id));
    return {
      accountId: caller.accountId,
      apiKeyId: caller.apiKeyId,
      clientId: caller.clientId,
      tool: call.tool,
      arguments: redactArguments(call.arguments) as Record<string, unknown>,
      outcome,
      error: error === null ? null : maskEmailsInText(error),
      createdAt: now,
    };
  });
  for (const [i, row] of rows.entries()) {
    await recordAudit(env, {
      callId: started[i]?.callId ?? crypto.randomUUID(),
      phase: row.outcome === "protocol_error" ? "refused" : "finished",
      caller: logName(caller),
      tool: row.tool,
      args: await loggedArgs(row.arguments),
      result: { isError: row.outcome !== "ok", text: row.error ?? "ok" },
      server,
      ...(caller.clientId ? { clientId: caller.clientId } : {}),
      correlationId: started[i]?.correlationId ?? correlationId(),
    });
  }
  try {
    // Nine columns, so rowsPerInsert(9) rows a statement; one db.batch keeps the log all-or-nothing.
    const [first, ...rest] = chunked(rows, rowsPerInsert(9)).map((part) =>
      db.insert(mcpCalls).values(part),
    );
    if (first !== undefined) await db.batch([first, ...rest]);
  } catch (err) {
    console.error(
      "mcp call log write failed:",
      caller.apiKeyId,
      rows.map((r) => r.tool).join(","),
      errorMessage(err),
    );
  }
}
